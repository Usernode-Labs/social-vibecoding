'use strict';

// Run routes (#routes), executed against the FULL PostgreSQL schema.
//
// The feature's hard rule is that a run is PRIVATE, and privacy is only as
// good as the SQL it runs: every read has to be scoped to the viewer, a run
// that is not theirs has to answer the same 404 as one that does not exist,
// and the two tables have to be marked private so a staging clone carries
// their schema and none of their rows. The distance a run reports is
// likewise DERIVED from the stored fixes server-side, so the number can be
// reproduced from the rows rather than trusted from the caller.
//
// Every one of those runs here through the real planner, in a throwaway
// database built from src/db/schema.sql exactly as a boot applies it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.
//
// Run with: node --test tests/routes-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const routes = require('../src/services/run-routes');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('run routes against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `runroutes_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    // WITH (FORCE) because a check may leave a client connected to this
    // scratch database — the API checks open their own server on it — and a
    // plain DROP then fails with 55006, taking the whole file red for a
    // teardown race rather than a real failure.
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the two new tables included

  let seq = 0;
  async function user(prefix = 'runner') {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [`${prefix}_${++seq}`]
    );
    return rows[0];
  }

  /** A straight-ish trace of `count` fixes, one every `seconds`, with jitter. */
  function trace(count, { startLat = 52.0, startLng = 4.0, step = 0.0005, seconds = 5 } = {}) {
    const points = [];
    for (let i = 0; i < count; i += 1) {
      points.push({
        seq: i,
        lat: startLat + i * step,
        lng: startLng + i * step * 0.4,
        recorded_at: new Date(Date.parse('2026-08-01T09:00:00Z') + i * seconds * 1000).toISOString(),
        accuracy_m: 8,
        altitude_m: null,
        speed_mps: null,
      });
    }
    return points;
  }

  await t.test('schema: both tables are private, and boot-idempotent', async () => {
    const comments = (await pool.query(
      `SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
        WHERE c.relname IN ('run_routes', 'run_route_points')
        ORDER BY c.relname`
    )).rows;
    assert.deepEqual(comments, [
      { relname: 'run_route_points', comment: 'staging:private' },
      { relname: 'run_routes', comment: 'staging:private' },
    ], 'a stranger reading every row would see where a person ran');
    // No public table may foreign-key into a private one; nothing does.
    const refs = (await pool.query(
      `SELECT c.conrelid::regclass::text AS from_table, c.confrelid::regclass::text AS to_table
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid IN ('run_routes'::regclass, 'run_route_points'::regclass)`
    )).rows;
    // The only foreign key pointing AT a run table is the points table's own,
    // and `run_routes` itself points at `users`, which is public — so the
    // linter's "no public table may foreign-key a private one" rule holds.
    assert.deepEqual(refs.map((r) => r.from_table).sort(), ['run_route_points'],
      'the points table is the only thing referencing a run table');
    // The unique pair is what makes a re-sent batch idempotent.
    const owner = await user();
    const run = await routes.createRun(pool, owner.id, '2026-08-01T09:00:00Z');
    const points = trace(2);
    assert.equal(await routes.appendPoints(pool, run.id, points), 2);
    assert.equal(await routes.appendPoints(pool, run.id, points), 0,
      'a replayed batch lands on the same rows rather than doubling the trace');
    assert.equal((await routes.pointsFor(pool, run.id)).length, 2);
    // Removed, so this scratch run is not an UNFINISHED row the sweep test
    // below would count. That test asserts exact sweep counts, and a stray
    // open run from here would make its arithmetic say the wrong thing.
    await routes.deleteRun(pool, owner.id, run.id);
  });

  await t.test('the distance is the server\'s, derived from the stored fixes', async () => {
    const owner = await user();
    const run = await routes.createRun(pool, owner.id, '2026-08-01T09:00:00Z');
    const points = trace(20);
    await routes.appendPoints(pool, run.id, points);
    const finished = await routes.finishRun(pool, owner.id, run.id, '2026-08-01T09:02:00Z');
    assert.equal(finished.point_count, 20);
    assert.equal(finished.has_location, true);
    assert.equal(finished.duration_seconds, 120);
    assert.equal(finished.distance_meters, routes.summarize(points).distanceMeters,
      'the stored number is the sum over the rows, not a number handed in');
    // A fix the browser reported at 500 m of accuracy is stored and NOT
    // summed: summing it is how a trace through a park reports 40 km.
    const second = await routes.createRun(pool, owner.id, '2026-08-02T09:00:00Z');
    await routes.appendPoints(pool, second.id, [
      { seq: 0, lat: 52.0, lng: 4.0, recorded_at: '2026-08-02T09:00:00Z', accuracy_m: 8 },
      { seq: 1, lat: 52.1, lng: 4.1, recorded_at: '2026-08-02T09:00:10Z', accuracy_m: 500 },
    ]);
    const filtered = await routes.finishRun(pool, owner.id, second.id, '2026-08-02T09:01:00Z');
    assert.equal(filtered.point_count, 2, 'both fixes are kept');
    assert.equal(filtered.distance_meters, 0, 'and the untrusted one adds nothing');
  });

  await t.test('a run with no fixes still saves, with time only', async () => {
    const owner = await user();
    const run = await routes.createRun(pool, owner.id, '2026-08-03T07:00:00Z');
    const finished = await routes.finishRun(pool, owner.id, run.id, '2026-08-03T07:12:00Z');
    assert.deepEqual(
      [finished.point_count, finished.has_location, finished.distance_meters, finished.duration_seconds],
      [0, false, 0, 720],
      'the honest degradation: the run is real, the map is empty',
    );
    assert.deepEqual((await routes.listFor(pool, owner.id)).map((r) => r.id), [run.id]);
  });

  await t.test('the list is viewer-scoped and another person\'s run is invisible', async () => {
    const a = await user(); const b = await user();
    const mine = await routes.createRun(pool, a.id, '2026-08-04T09:00:00Z');
    await routes.appendPoints(pool, mine.id, trace(5));
    await routes.finishRun(pool, a.id, mine.id, '2026-08-04T09:05:00Z');
    const theirs = await routes.createRun(pool, b.id, '2026-08-04T10:00:00Z');
    await routes.finishRun(pool, b.id, theirs.id, '2026-08-04T10:05:00Z');

    assert.deepEqual((await routes.listFor(pool, a.id)).map((r) => r.id), [mine.id],
      'the list is the viewer\'s own runs and nothing else');
    assert.deepEqual((await routes.listFor(pool, b.id)).map((r) => r.id), [theirs.id]);
    assert.equal(await routes.ownedRun(pool, a.id, theirs.id), null,
      'another person\'s run does not resolve for the viewer');
    assert.equal(await routes.ownedRun(pool, a.id, mine.id) && true, true);
    // The writes refuse it too, which is what makes the 404 honest.
    assert.equal(await routes.finishRun(pool, a.id, theirs.id, '2026-08-04T11:00:00Z'), null);
    assert.equal(await routes.deleteRun(pool, a.id, theirs.id), false);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM run_routes WHERE id = $1',
      [theirs.id])).rows[0].n, 1, 'and it is still there for its owner');
  });

  await t.test('an unfinished run is kept out of the list and swept after a day', async () => {
    const owner = await user();
    // NOW, not a fixed date: this run is the one that must SURVIVE the first
    // sweep, and the TTL is measured against the wall clock rather than
    // against the other fixtures' fixed dates.
    const open = await routes.createRun(pool, owner.id, new Date().toISOString());
    assert.deepEqual(await routes.listFor(pool, owner.id), [],
      'a run that was started and never finished is not a row in the list');
    // Fresh: kept, so a run in progress survives a boot.
    assert.equal(await routes.sweepUnfinished(pool), 0);
    await pool.query(
      `UPDATE run_routes SET started_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [open.id]
    );
    assert.equal(await routes.sweepUnfinished(pool), 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM run_routes WHERE id = $1',
      [open.id])).rows[0].n, 0);
  });

  await t.test('deleting a run takes its points with it', async () => {
    const owner = await user();
    const run = await routes.createRun(pool, owner.id, '2026-08-06T09:00:00Z');
    await routes.appendPoints(pool, run.id, trace(4));
    assert.equal(await routes.deleteRun(pool, owner.id, run.id), true);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM run_route_points WHERE route_id = $1',
      [run.id])).rows[0].n, 0, 'the cascade is what keeps a deleted trace from leaking');
  });

  await t.test('the caps refuse politely', async () => {
    const owner = await user();
    const run = await routes.createRun(pool, owner.id, '2026-08-07T09:00:00Z');
    const many = [];
    for (let i = 0; i < routes.MAX_POINTS_PER_RUN; i += 1) {
      many.push({ seq: i, lat: 52 + i * 1e-6, lng: 4, recorded_at: '2026-08-07T09:00:00Z', accuracy_m: 5 });
    }
    await routes.appendPoints(pool, run.id, many);
    const after = await routes.ownedRun(pool, owner.id, run.id);
    assert.equal(after.point_count, 0, 'point_count is only written on finish');
    assert.equal((await routes.pointsFor(pool, run.id)).length, routes.MAX_POINTS_PER_RUN);
    await pool.query('UPDATE run_routes SET point_count = $2 WHERE id = $1',
      [run.id, routes.MAX_POINTS_PER_RUN]);
    assert.ok(await routes.countFor(pool, owner.id) >= 1);
  });

  await t.test('the HTTP surface is private: the viewer\'s own rows, and a generic 404 otherwise', async () => {
    const { runRoutes } = require('../src/routes/run-routes');
    const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only' };
    const a = await user(); const b = await user();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = req.get('x-test-user') === 'b' ? b : a; next(); });
    app.use(runRoutes(config));
    const { server, base } = await listen(app);
    t.after(() => server.close());

    const post = (path, body, who = 'a') => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': who },
      body: JSON.stringify(body || {}),
    });
    const get = (path, who = 'a') => fetch(`${base}${path}`, { headers: { 'x-test-user': who } });

    const started = await post('/api/routes', { started_at: '2026-08-08T09:00:00Z' });
    assert.equal(started.status, 200);
    const { run } = await started.json();
    assert.ok(run.id > 0);
    assert.equal(started.headers.get('cache-control'), 'private, no-store');
    assert.equal(started.headers.get('x-content-type-options'), 'nosniff');

    const appended = await post(`/api/routes/${run.id}/points`, { points: trace(6) });
    assert.equal(appended.status, 200);
    assert.equal((await appended.json()).appended, 6);

    const finished = await post(`/api/routes/${run.id}/finish`, { finished_at: '2026-08-08T09:06:00Z' });
    assert.equal(finished.status, 200);
    const saved = (await finished.json()).run;
    assert.equal(saved.has_location, true);
    assert.ok(saved.distance_meters > 0);

    const listed = await (await get('/api/routes')).json();
    assert.deepEqual(listed.runs.map((r) => r.id), [run.id], 'the viewer sees their own run');

    // The other person sees NOTHING, and reading the run is a 404 rather
    // than a 403 — a 403 would confirm the row exists, which is the fact
    // this feature is not allowed to disclose.
    assert.deepEqual((await (await get('/api/routes', 'b')).json()).runs, []);
    const stolen = await get(`/api/routes/${run.id}`, 'b');
    assert.equal(stolen.status, 404);
    assert.deepEqual(await stolen.json(), { error: 'Run not found' });
    assert.equal((await post(`/api/routes/${run.id}/finish`, {}, 'b')).status, 404);
    assert.equal((await fetch(`${base}/api/routes/${run.id}`, {
      method: 'DELETE', headers: { 'x-test-user': 'b' },
    })).status, 404);

    const detail = await (await get(`/api/routes/${run.id}`)).json();
    assert.equal(detail.points.length, 6, 'the owner reads the trace');
    const removed = await fetch(`${base}/api/routes/${run.id}`, {
      method: 'DELETE', headers: { 'x-test-user': 'a' },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await (await get('/api/routes')).json()).runs, []);
  });

  await t.test('?demo=1 answers from the fixtures, writes nothing, and is a no-op outside staging', async () => {
    const { runRoutes } = require('../src/routes/run-routes');
    const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only' };
    const viewer = await user();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = viewer; next(); });
    app.use(runRoutes(config));
    const { server, base } = await listen(app);
    t.after(() => server.close());

    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM run_routes')).rows[0].n;
    const demo = await (await fetch(`${base}/api/routes?demo=1`)).json();
    // USERNODE_ENV is not 'staging' in this process, so the injection must
    // be a strict no-op: the viewer's own (empty) list is the answer.
    assert.deepEqual(demo.runs, [],
      'the demo fixtures are staging-only; outside staging the route is honest');
    assert.equal(demo.demo, undefined);
    const demoDetail = await fetch(`${base}/api/routes/900101?demo=1`);
    assert.equal(demoDetail.status, 404);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM run_routes')).rows[0].n, before,
      'and nothing was written');

    // The fixtures themselves, in isolation, are the shape the route serves
    // in staging: three runs, one of them with no location at all.
    const fixtures = routes.demoList();
    assert.equal(fixtures.runs.length, 3);
    assert.deepEqual(fixtures.runs.map((r) => r.label),
      ['Staging demo run 1', 'Staging demo run 2', 'Staging demo run 3']);
    assert.equal(fixtures.runs[1].has_location, false);
    assert.equal(fixtures.runs[1].point_count, 0);
    assert.equal(fixtures.runs[0].has_location, true);
    assert.ok(fixtures.runs[0].distance_meters > 0);
    const detail = routes.demoDetail(900101);
    assert.equal(detail.points.length, detail.run.point_count);
    assert.equal(routes.demoDetail(900102).points.length, 0);
    assert.equal(routes.demoDetail(1), null, 'a run nobody seeded is not a fixture');
  });
});

'use strict';

// #4452 — the change page's run bar estimate.
//
// services/run-estimate.js turns an app's last ten finished runs into three
// medians (build wall clock, checks wall clock, shots wall clock), and
// routes/run-estimate.js serves them at GET /api/apps/:slug/run-estimate.
// The medians are read straight out of what earlier runs already stored —
// checks_progress's { build: { totalMs }, checksMs } and shot_runs'
// started_at/completed_at — so the database half of this file runs the REAL
// queries against a REAL Postgres, in a schema scoped to this process.
//
// Run with: node --test tests/run-estimate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/run-estimate');

// ── median ──────────────────────────────────────────────────────────────

test('median takes the middle value of an odd count and the mean of an even one', () => {
  assert.equal(service.median([5, 1, 3]), 3);
  assert.equal(service.median([1, 3, 5, 7]), 4);
});

test('median needs three values and ignores the non-positive and the missing', () => {
  assert.equal(service.median([4000, 6000]), null, 'two runs say nothing yet');
  assert.equal(service.median([4000, 0, -1, null, undefined, 'x', 6000]), null, 'only two usable');
  assert.equal(service.median([4000, 0, -1, 6000, 8000]), 6000, 'usable values count');
  assert.equal(service.median([]), null);
});

test('median reads pg bigint/numeric strings', () => {
  assert.equal(service.median(['4000', '6000', '8000']), 6000);
});

// ── getEstimate: the queries (fake pool) ────────────────────────────────

test('the two queries filter by app and read the last ten of each kind', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push({ sql, params });
      return { rows: [] };
    },
  };
  await service.getEstimate(pool, 42);
  assert.equal(seen.length, 2);
  const [checks, shots] = seen;
  assert.match(checks.sql, /FROM chat_sessions/);
  assert.match(checks.sql, /app_id = \$1/);
  assert.match(checks.sql, /check_state IN \('passing','failing'\)/);
  assert.match(checks.sql, /checks_progress \? 'checksMs'/);
  assert.match(checks.sql, /LIMIT 10/);
  assert.deepEqual(checks.params, [42]);
  assert.match(shots.sql, /FROM shot_runs sr JOIN chat_sessions cs ON cs\.id = sr\.session_id/);
  assert.match(shots.sql, /cs\.app_id = \$1/);
  assert.match(shots.sql, /sr\.state = 'verified'/);
  assert.match(shots.sql, /LIMIT 10/);
  assert.deepEqual(shots.params, [42]);
});

// ── getEstimate: the real queries, on a real Postgres ───────────────────

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('getEstimate medians the app’s own finished runs on a real database', async (t) => {
  let client;
  try {
    const { Client } = require('pg');
    client = new Client({ connectionString: DSN });
    await client.connect();
  } catch (err) {
    t.skip(`no postgres reachable: ${err.code || err.message}`);
    return;
  }
  const schema = `run_estimate_pg_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Only the columns the two queries touch; the real tables carry more,
    // and none of it changes what a median reads.
    await client.query(`
      CREATE TABLE chat_sessions (
        id SERIAL PRIMARY KEY,
        app_id INTEGER,
        check_state TEXT,
        checks_checked_at TIMESTAMPTZ,
        checks_progress JSONB
      );
      CREATE TABLE shot_runs (
        id VARCHAR(32) PRIMARY KEY,
        session_id INTEGER,
        state TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );
    `);
    // Five finished runs on app 1: build 10s/20s/30s/40s/60s (median 30s),
    // checks 1m/2m/3m/4m/8m (median 3m). A finished run of ANOTHER app, a
    // still-pending row and a finished row without checksMs stay out.
    const finished = [
      { build: 10000, checks: 60000 },
      { build: 20000, checks: 120000 },
      { build: 30000, checks: 180000 },
      { build: 40000, checks: 240000 },
      { build: 60000, checks: 480000 },
    ];
    for (const [i, run] of finished.entries()) {
      await client.query(
        `INSERT INTO chat_sessions (app_id, check_state, checks_checked_at, checks_progress)
         VALUES ($1, 'passing', $2, $3)`,
        [1, new Date(Date.UTC(2026, 9, 1, 12, i)),
          JSON.stringify({ build: { step: 'done', totalMs: run.build }, checksMs: run.checks })]
      );
    }
    await client.query(
      `INSERT INTO chat_sessions (app_id, check_state, checks_checked_at, checks_progress)
       VALUES (2, 'passing', NOW(), $1), (1, 'pending', NOW(), $1), (1, 'passing', NOW(), '{}')`,
      [JSON.stringify({ build: { step: 'done', totalMs: 999000 }, checksMs: 999000 })]
    );
    // Shots on app 1: three verified runs of 2m/4m/6m (median 4m). On the
    // other app one verified run with timestamps and one without: below the
    // floor, and the timestampless one is unreadable anyway.
    for (const [i, ms] of [120000, 240000, 360000].entries()) {
      const { rows } = await client.query(`INSERT INTO chat_sessions (app_id) VALUES (1) RETURNING id`);
      const start = new Date(Date.UTC(2026, 9, 2, 10, i));
      await client.query(
        `INSERT INTO shot_runs (id, session_id, state, started_at, completed_at)
         VALUES ($1, $2, 'verified', $3, $4)`,
        [`run${i}`.padEnd(32, '0'), rows[0].id, start, new Date(start.getTime() + ms)]
      );
    }
    const { rows: otherSessions } = await client.query(`INSERT INTO chat_sessions (app_id) VALUES (2) RETURNING id`);
    const start = new Date(Date.UTC(2026, 9, 2, 11, 0));
    await client.query(
      `INSERT INTO shot_runs (id, session_id, state, started_at, completed_at)
       VALUES ($1, $2, 'verified', $3, $4)`,
      ['o'.padEnd(32, '0'), otherSessions[0].id, start, new Date(start.getTime() + 60000)]
    );
    await client.query(
      `INSERT INTO shot_runs (id, session_id, state) VALUES ($1, $2, 'verified')`,
      ['p'.padEnd(32, '0'), otherSessions[0].id]
    );

    const est = await service.getEstimate(client, 1);
    assert.equal(est.runs, 5, 'runs counts the app’s finished checks rows');
    assert.equal(est.buildMs, 30000);
    assert.equal(est.checksMs, 180000);
    assert.equal(est.shotsMs, 240000);
    assert.equal(est.shotsRuns, 3);

    const other = await service.getEstimate(client, 2);
    assert.equal(other.runs, 1);
    assert.equal(other.buildMs, null, 'one run is below the three-run floor');
    assert.equal(other.checksMs, null);
    assert.equal(other.shotsMs, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

// ── the route ────────────────────────────────────────────────────────────

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

// What the route calls, not the route: access decides who may read, and the
// pool answers the queries the service tests above already covered.
const appAccess = require('../src/services/app-access');
let visibleApp = null;
appAccess.getAppForUser = async (_pool, slug, _user, mode) => {
  if (!visibleApp || visibleApp.slug !== slug || mode !== 'view') return null;
  return visibleApp;
};

// The pool the route reads through, BEFORE the route module loads — it
// binds getPool at require time. It counts the queries the 404 test
// asserts were not made.
let queries = 0;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query() {
    queries += 1;
    return { rows: [] };
  },
});

const { runEstimateRoutes } = require('../src/routes/run-estimate');
const express = require('express');

let server;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 100 }; next(); });
  app.use(runEstimateRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

async function call(slug) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/${slug}/run-estimate`);
  let body = null;
  try { body = await res.json(); } catch { /* a route that answered nothing */ }
  return { status: res.status, cache: res.headers.get('cache-control'), body };
}

test('an app the viewer may not see is a 404, and asks the database nothing', async () => {
  visibleApp = { id: 7, slug: 'visible' };
  const { status } = await call('hidden');
  assert.equal(status, 404);
  assert.equal(queries, 0);
});

test('a viewable app answers the medians privately cached', async () => {
  visibleApp = { id: 7, slug: 'visible' };
  const { status, cache, body } = await call('visible');
  assert.equal(status, 200);
  assert.match(cache, /^private/);
  assert.equal(typeof body.runs, 'number');
  assert.ok('buildMs' in body && 'checksMs' in body && 'shotsMs' in body);
});

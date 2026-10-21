'use strict';

// What is left of the Homeroom bot's shadow-build lane, executed against the
// FULL PostgreSQL schema. The lane itself is gone (design D2: production
// treats mode 'shadow' as 'live', and a staging copy runs no worker turns):
// what stays is a newer verdict superseding a build an older one queued,
// "Triage this app again" owing a live app's requests a look, the
// dashboard's counts and the export over the lane's columns, and a live
// build recorded in those same columns. Everything runs through the real
// planner, in a throwaway database built from src/db/schema.sql as a boot
// applies it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('what is left of the shadow-build lane against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_lane_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  // Every app is live outside a staging copy: a staging copy is where the
  // shadow builds ran, and where the retriage refuses.
  const realEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  t.after(async () => {
    if (realEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = realEnv;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the lane's columns and index included

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  const app = async (slug, repo) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id, slug`,
    [slug, repo],
  )).rows[0];
  const run = async (appRow, issue, { verdict = 'ready', queuedAgo = null, buildAgo = null, attempts = 0, buildOk = null, buildError = null } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note,
                                    build_queued_at, build_at, build_attempts, build_ok, build_error)
     VALUES ($1, $2, 'shadow', $3, 'build it',
             CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $4::int) END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $5::int) END,
             $6, $7, $8)
     RETURNING id`,
    [appRow.id, issue, verdict, queuedAgo, buildAgo, attempts, buildOk, buildError],
  )).rows[0].id;
  const row = async (id) => (await pool.query(
    'SELECT build_queued_at, build_at, build_ok, build_error, build_attempts, build_branch FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];

  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_paused_apps', '["paused-app"]');

  const todo = await app('todo', 'https://github.com/usernode-bot/todo');
  const notes = await app('notes', 'https://github.com/usernode-bot/notes');

  await t.test('the supersede drops only a queued, unstarted build of the same issue', async () => {
    const older = await run(todo, 40, { queuedAgo: 50 });
    const started = await run(todo, 41, { queuedAgo: 50, buildAgo: 10 });
    const newer = await run(todo, 40, { verdict: 'question' });
    await bot.supersedeQueuedBuilds(pool, { appId: todo.id, issueNumber: 40, runId: newer });
    await bot.supersedeQueuedBuilds(pool, { appId: todo.id, issueNumber: 41, runId: newer + 1 });
    const r = await row(older);
    assert.equal(r.build_queued_at, null);
    assert.match(r.build_error, /^superseded/);
    assert.notEqual((await row(started)).build_queued_at, null, 'a build under way is not dropped');
    await pool.query('UPDATE homeroom_bot_runs SET build_queued_at = NULL, build_at = NULL WHERE id = $1', [started]);
  });

  await t.test('"Triage this app again" owes every open issue of a live app a look, oldest first (#3480)', async () => {
    const shop = await app('shop', 'https://github.com/usernode-bot/shop');
    const issues = [
      { number: 7, state: 'open', createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z' },
      { number: 3, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' },
      { number: 5, state: 'open', createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
      { number: 9, state: 'closed', createdAt: '2026-09-04T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z' },
      { number: 11, state: 'open', createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' },
    ];
    const github = { async fetchPublicIssues() { return { issues }; } };
    // Each request's debt is an event to its bot-request instance, which
    // owns the queue row: the retriage writes no row itself.
    const owed = async () => (await pool.query(
      `SELECT key, payload, request_key, source FROM wf_events
        WHERE machine = 'bot-request' AND type = 'Owed' AND app_id = $1 ORDER BY id`, [shop.id],
    )).rows;

    assert.equal((await bot.retriageApp(pool, { slug: 'shop', deps: { github } })).status, 409, 'a staging copy never acts: nothing is owed');
    assert.deepEqual(await owed(), []);

    // Outside a staging copy every app but a paused one is live.
    const env = process.env.USERNODE_ENV;
    delete process.env.USERNODE_ENV;
    try {
      // #11 is somebody's: a person claimed it.
      const { rows: [person] } = await pool.query(
        `INSERT INTO users (username, password) VALUES ('shopkeeper', 'x') RETURNING id`,
      );
      await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 11, $2)', [shop.id, person.id]);

      const out = await bot.retriageApp(pool, { slug: 'shop', actorId: person.id, deps: { github } });
      assert.equal(out.ok, true);
      assert.deepEqual(out.left, { busy: 1, closed: 1 });
      assert.equal(out.queued, 3);
      const rows = await owed();
      assert.deepEqual(rows.map((r) => r.key), [`request:${shop.id}:3`, `request:${shop.id}:5`, `request:${shop.id}:7`],
        'oldest first, closed and claimed left out');
      assert.ok(rows.every((r) => r.payload.priority === 0 && r.payload.reason === 'app_again'), 'kept by the refresh, like a Run now');
      assert.ok(rows.every((r) => r.payload.requestedBy === person.id), 'who asked for it');
      assert.equal(rows[0].payload.threadSeenAt, '2026-09-05T00:00:00.000Z', 'seen as of its last change, so it is not owed again after');
      assert.ok(rows.every((r) => /^retriage:[0-9a-f-]{36}:\d+$/.test(r.request_key)), 'one retriage appends each debt once');
      assert.equal(rows[0].source.name, 'admin');

      await setting('homeroom_bot_paused_apps', '["paused-app","shop"]');
      assert.equal((await bot.retriageApp(pool, { slug: 'shop', deps: { github } })).status, 409, 'not while paused');
      await setting('homeroom_bot_paused_apps', '["paused-app"]');
    } finally {
      process.env.USERNODE_ENV = env;
    }
  });

  await t.test('the dashboard counts and the export still read the lane columns', async () => {
    // What the lane's history holds is set here: three built for a cent
    // each, one failed, and two that were still queued when it went.
    await pool.query('DELETE FROM homeroom_bot_runs');
    for (const n of [61, 62, 63]) {
      await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, build_cost_usd = 0.01 WHERE id = $1',
        [await run(todo, n, { queuedAgo: 600, buildAgo: 500 })]);
    }
    await run(notes, 64, { queuedAgo: 600, buildAgo: 500, buildOk: false, buildError: 'interrupted: the build never finished' });
    await run(notes, 51, { queuedAgo: 60 });
    await run(todo, 52, { queuedAgo: 60 });
    const summary = await bot.buildLaneSummary(pool);
    assert.equal(summary.queued, 2);
    assert.equal(summary.built, 3);
    assert.equal(summary.failed, 1);
    assert.equal(summary.building, 0);
    assert.ok(Math.abs(summary.costUsd - 0.03) < 1e-9);
    const rows = [];
    for await (const chunk of bot.iterateRunsForExport(pool, { app: 'notes' })) rows.push(...chunk);
    assert.ok(rows.length > 0);
    assert.ok('build_queued_at' in rows[0]);
  });

  await t.test('a live build is recorded in the same columns, and the lane never counts it (#3509)', async () => {
    const before = await bot.buildLaneSummary(pool);
    const liveRun = async (issue) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, build_spec_md)
       VALUES ($1, $2, 'live', 'ready', 'build it', 'the spec') RETURNING id`, [todo.id, issue],
    )).rows[0].id;
    const proposed = await liveRun(801);
    await bot.recordLiveBuild(pool, proposed, {
      ok: true, sessionId: null, branchName: 'homeroom_bot/s1', sha: 'c'.repeat(40), commits: 3, costUsd: 0.4,
    });
    const blocked = await liveRun(802);
    await bot.recordLiveBuild(pool, blocked, {
      ok: false, blocked: 'no image generation', costUsd: 0.05,
      specNote: 'no spec (x); the build worked from the plan',
    });
    const { rows: [p] } = await pool.query(
      `SELECT build_ok, build_error, build_branch, build_sha, build_commits, build_cost_usd::float8 AS cost,
              build_spec_md, build_at, build_queued_at
         FROM homeroom_bot_runs WHERE id = $1`, [proposed],
    );
    assert.deepEqual(
      { ...p },
      { build_ok: true, build_error: null, build_branch: 'homeroom_bot/s1', build_sha: 'c'.repeat(40), build_commits: 3,
        cost: 0.4, build_spec_md: 'the spec', build_at: null, build_queued_at: null },
      'the spec already on the run is kept; the lane\'s own markers stay empty',
    );
    assert.equal((await row(blocked)).build_error, 'blocked: no image generation; no spec (x); the build worked from the plan');
    assert.equal((await row(blocked)).build_ok, false);
    assert.deepEqual(await bot.buildLaneSummary(pool), before, 'the shadow lane\'s counts and cost are its own');
  });
});

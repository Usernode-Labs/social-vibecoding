'use strict';

// Work in flight that every platform process sees (services/in-flight-record.js,
// the app_deploys and session_busy tables): an app's production deploy and a
// session being worked on, recorded by one process and read by another. Two
// processes are two loads of each module (each picks its own holder id).
// Against the full PostgreSQL schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh load of `path` and of in-flight-record.js: another process.
function anotherProcess(path) {
  for (const p of [path, '../src/services/in-flight-record']) delete require.cache[require.resolve(p)];
  return require(path);
}

test('work in flight, across processes', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'in_flight_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const poolId = require.resolve('../src/db/pool');
  require.cache[poolId] = { id: poolId, filename: poolId, loaded: true, exports: { getPool: () => pool }, paths: [] };
  const wsId = require.resolve('../src/services/ws');
  require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: { broadcastGlobal() {} }, paths: [] };
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ('Shop', 'shop', $1) RETURNING id`, [u.id]);
  const settle = () => sleep(100);

  await t.test('a deploy one process runs is what another reads, until it ends', async () => {
    const worker = anotherProcess('../src/services/app-deploy-status');
    const web = anotherProcess('../src/services/app-deploy-status');
    worker.markStart('shop', { fromSha: 'a'.repeat(40) });
    await settle();
    const seen = await web.read('shop');
    assert.equal(seen?.deploying, true, 'the web process sees the worker\'s deploy');
    assert.equal(seen.fromSha, 'a'.repeat(40));
    assert.equal((await web.readMany(['shop', 'other'])).size, 1);
    worker.markEnd('shop', {});
    await settle();
    assert.equal(await web.read('shop'), null);
  });

  await t.test('a deploy whose process stopped renewing it reads as none', async () => {
    const worker = anotherProcess('../src/services/app-deploy-status');
    const web = anotherProcess('../src/services/app-deploy-status');
    worker.markStart('shop', {});
    await settle();
    await pool.query(`UPDATE app_deploys SET heartbeat_at = NOW() - interval '3 minutes' WHERE app_id = $1`, [app.id]);
    assert.equal(await web.read('shop'), null, 'the process died mid-deploy');
    worker.markEnd('shop', {});
    await settle();
  });

  await t.test('a session one process works on is busy for every process, and the included changes skip it', async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, reviewed_head_sha)
       VALUES ($1, $2, 'promoted', 7, $3) RETURNING id`, [app.id, u.id, 'b'.repeat(40)]);
    const { rows: [carrier] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number) VALUES ($1, $2, 'merged', 8) RETURNING id`, [app.id, u.id]);
    const { CANDIDATES_SQL } = require('../src/services/included-changes');
    const candidates = async () => (await pool.query(CANDIDATES_SQL, [app.id, carrier.id])).rows.map((r) => r.id);
    assert.deepEqual(await candidates(), [s.id]);

    const web = anotherProcess('../src/services/active-workers');
    const release = web.beginSessionOperation(s.id);   // a sync with main, say
    await settle();
    assert.deepEqual(await candidates(), [], 'the worker\'s find skips it');
    web.activeWorkers.add(s.id);   // and a turn's window over it
    release();
    await settle();
    assert.deepEqual(await candidates(), [], 'still worked on');
    web.activeWorkers.delete(s.id);
    await settle();
    assert.deepEqual(await candidates(), [s.id], 'free again');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_busy')).rows[0].n, 0, 'nothing left behind');
  });

  await t.test('a key held again right after its release keeps its row (the release\'s delete never lands last)', async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [app.id, u.id]);
    const { createHolds, HOLDER } = anotherProcess('../src/services/in-flight-record');
    const holds = createHolds('test', {
      write: (p, id) => p.query('INSERT INTO session_busy (session_id, holder) VALUES ($1, $2) ON CONFLICT (session_id, holder) DO UPDATE SET heartbeat_at = NOW()', [id, HOLDER]),
      remove: (p, id) => p.query('DELETE FROM session_busy WHERE session_id = $1 AND holder = $2', [id, HOLDER]),
    });
    const rowThere = async () => (await pool.query('SELECT count(*)::int AS n FROM session_busy WHERE session_id = $1', [s.id])).rows[0].n === 1;
    for (let i = 0; i < 50; i++) {
      holds.hold(s.id, null);
      holds.release(s.id);
      holds.hold(s.id, null);
      await holds.settled();
      assert.ok(holds.held(s.id) && await rowThere(), `round ${i}: held, and its row is there`);
      holds.release(s.id);
      await holds.settled();
      assert.equal(await rowThere(), false, `round ${i}: released`);
    }
  });

  await t.test('a process that stops cleanly removes its rows', async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id`, [app.id, u.id]);
    // One process: both modules on one load of in-flight-record.
    for (const p of ['../src/services/in-flight-record', '../src/services/active-workers', '../src/services/app-deploy-status']) {
      delete require.cache[require.resolve(p)];
    }
    const web = require('../src/services/active-workers');
    const deploys = require('../src/services/app-deploy-status');
    web.activeWorkers.add(s.id);
    deploys.markStart('shop', {});
    await settle();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_busy WHERE session_id = $1', [s.id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_deploys')).rows[0].n, 1);
    await require('../src/services/in-flight-record').releaseAll();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_busy WHERE session_id = $1', [s.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_deploys')).rows[0].n, 0);
    web.activeWorkers.delete(s.id);
  });

  await t.test('the legacy mark of included changes skips a session any process is working on', async () => {
    const { rows: [carrier] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, merge_commit_sha) VALUES ($1, $2, 'merged', 20, $3) RETURNING id`,
      [app.id, u.id, 'c'.repeat(40)]);
    const { rows: [busy] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number) VALUES ($1, $2, 'promoted', 21) RETURNING id`, [app.id, u.id]);
    const { rows: [free] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number) VALUES ($1, $2, 'promoted', 22) RETURNING id`, [app.id, u.id]);
    await pool.query(`INSERT INTO session_busy (session_id, holder) VALUES ($1, 'another-pod')`, [busy.id]);
    const { MARK_SQL } = require('../src/services/included-changes');
    const { rows } = await pool.query(MARK_SQL, [carrier.id, [busy.id, free.id]]);
    assert.deepEqual(rows.map((r) => r.id), [free.id]);
    // A row its process stopped renewing does not hold it.
    await pool.query(`UPDATE session_busy SET heartbeat_at = NOW() - interval '3 minutes' WHERE session_id = $1`, [busy.id]);
    assert.deepEqual((await pool.query(MARK_SQL, [carrier.id, [busy.id]])).rows.map((r) => r.id), [busy.id]);
  });
});

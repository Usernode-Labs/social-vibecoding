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
});

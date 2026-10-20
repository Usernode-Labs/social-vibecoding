'use strict';

// A turn a process left behind while the Pod a release replaced still
// finishes its own (docs/plans/draining-releases.md), against the REAL schema
// in a throwaway PostgreSQL database:
//
//   - adoptOrphanWorker leaves a turn another live process holds alone;
//   - the turn-leftovers clock (services/turn-leftovers.js) asks a recover
//     turn, once, for what was left: a record no work item and no live
//     process holds, quiet for two minutes; and nothing else.
//
// The worker module is stubbed; the other processes are the rows they write.
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/orphan-adoption-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// The runner reads this file's results from its stdout, framed, and Node's
// parser (internal/test_runner/runner.js parseMessage) can put a held-back
// 0xFF after the next read when a read ends partway through a frame's
// header: "Unable to deserialize cloned data" (#5445). A read only ends there
// when the pipe is full, and what fills it is the INFO lines the server and
// its sweeps log to stdout. WARN and ERROR go to stderr and still show.
process.env.LOG_LEVEL = process.env.ORPHAN_ADOPTION_DEBUG ? 'INFO' : 'WARN';
require('./platform-keys').setPlatformKeys();

// pool.end() resolves once its idle connections are handed their end, not
// once their sockets close, so the teardown's DROP DATABASE ... WITH (FORCE)
// can reach one still closing. The server then terminates it (57P01) and the
// pool re-emits that as 'error', which without a listener is an
// uncaughtException that fails whatever test is running (see the same race in
// tests/username-invite-join-postgres.test.js). A drop DURING the checks is
// still this file's failure: the final subtest asserts none was recorded.
let closing = false;
const dropped = [];
const onPoolError = (err) => {
  if (closing) return; // the teardown's own DROP closes this test's connections
  dropped.push(`${err.code || ''} ${err.message}`);
};

test('only what no live process or work item holds is recovered', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', onPoolError);
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'orphans_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  pool.on('error', onPoolError);
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const workerCalls = [];
  // This process's warm registry, for the idle eviction (empty unless a test fills it).
  let warm = [];
  const workerPath = require.resolve('../src/services/worker');
  const realWorker = require(workerPath);
  require.cache[workerPath].exports = {
    ...realWorker,
    warmRegistrySnapshot: () => warm.map((m) => ({ ...m })),
    evictWorker: async (id) => { workerCalls.push(['evictWorker', Number(id)]); },
    usesKubernetesWorkers: () => false,
    getWorkerStatus: async () => 'running',
    destroyWorker: async (n) => { workerCalls.push(['destroyWorker', n]); },
    adoptWarmWorker: (id, n) => { workerCalls.push(['adoptWarmWorker', id, n]); },
    watchWorker: async (n) => { workerCalls.push(['watchWorker', n]); return {}; },
    stopTurn: async () => { workerCalls.push(['stopTurn']); return false; },
  };
  const origSetInterval = global.setInterval;
  const origSetTimeout = global.setTimeout;
  global.setInterval = (...a) => { const x = origSetInterval(...a); x?.unref?.(); return x; };
  global.setTimeout = (...a) => { const x = origSetTimeout(...a); x?.unref?.(); return x; };
  let server;
  try { server = require('../server'); } finally {
    global.setInterval = origSetInterval;
    global.setTimeout = origSetTimeout;
  }
  const processes = require('../src/services/processes');
  await processes.start({ pool, role: 'all' });
  t.after(async () => {
    closing = true; // from here a drop is this teardown's own doing
    processes._reset();
    require.cache[workerPath].exports = realWorker;
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('alice', 'x', TRUE) RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url) VALUES ('Demo', 'demo', 'running', $1, 'https://github.com/o/demo') RETURNING id`,
    [user.id]);
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  async function session(label, { phase = 'executing', at = old } = {}) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, active_turn)
       VALUES ($1, $2, $3, 'active', $4, $5) RETURNING id`,
      [app.id, user.id, `b-${label}`, label, JSON.stringify({ turnId: `t-${label}`, phase, mode: 'build', journal: `/j/${label}`, startedAt: at, lifecycleUpdatedAt: at })]);
    return s.id;
  }
  const heldLive = await session('held-live');
  const heldDead = await session('held-dead');
  const fresh = await session('fresh', { at: now });
  const left = await session('left');
  const quarantined = await session('quarantined', { phase: 'quarantined' });
  const headless = await session('headless');
  await pool.query('UPDATE chat_sessions SET is_headless = TRUE WHERE id = $1', [headless]);
  const building = await session('building');
  await pool.query(`UPDATE chat_sessions SET workflow_owner = 'bot-build/run:9' WHERE id = $1`, [building]);
  // The build that owns it, written as the kernel's pipeline writes it.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.wf_writer = 'transition'`);
    await c.query(`INSERT INTO wf_instances (machine, key, state, machine_version) VALUES ('bot-build', 'run:9', 'building', 1)`);
    await c.query('COMMIT');
  } finally { c.release(); }
  await pool.query(`INSERT INTO platform_processes (id, state, heartbeat_at, drain_started_at) VALUES ('pod-old', 'draining', NOW(), NOW())`);
  await pool.query(`INSERT INTO platform_processes (id, heartbeat_at) VALUES ('pod-dead', NOW() - interval '10 minutes')`);
  await pool.query(`INSERT INTO process_holds (process_id, kind, ref) VALUES ('pod-old', 'session', $1), ('pod-dead', 'session', $2)`,
    [String(heldLive), String(heldDead)]);

  await t.test('adoption leaves a turn another live process is finishing alone', async () => {
    workerCalls.length = 0;
    await server.adoptOrphanWorker({ name: `usernode-worker-${heldLive}`, sessionId: heldLive, state: 'running' },
      { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} });
    assert.deepEqual(workerCalls, [], 'no warm registration, no stop, no teardown, no journal');
    const { rows: [row] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [heldLive]);
    assert.equal(row.active_turn.phase, 'executing', 'its turn record is untouched');
  });

  const leftovers = require('../src/services/turn-leftovers');
  const asked = async () => (await pool.query(
    `SELECT (payload->'input'->>'sessionId')::int AS id FROM wf_events WHERE machine = 'turn' AND type = 'Asked'
       AND payload->>'kind' = 'recover' ORDER BY id`)).rows.map((r) => r.id);
  const pass = () => leftovers.sweep(pool, { config: {}, deps: { localPass: async () => ({ adopted: 0 }), release: 'test' } });

  await t.test('a recover turn is asked, once, for what was left: unheld (or held by the dead), quiet', async () => {
    const out = await pass();
    assert.equal(out.records, 3);
    const adopted = await asked();
    // A quarantined record is asked too: the adoption stops its worker and
    // keeps the record for an operator (turn-recovery.js adoptOrphanWorker).
    assert.deepEqual(adopted.sort((a, b) => a - b), [heldDead, left, quarantined].sort((a, b) => a - b));
    assert.ok(!adopted.includes(fresh), 'a turn whose record just moved may be one being dispatched');
    assert.ok(!adopted.includes(headless) && !adopted.includes(building),
      'nor what other work carries: a headless run, a durable build\'s session');
    assert.ok(!adopted.includes(heldLive));
    await pass();
    assert.equal((await asked()).length, 3, 'once');
  });

  // (A worker a process left behind is the worker-eviction clock's, from
  // session_workers: tests/worker-eviction-postgres.test.js, a durable
  // build's included.)

  await t.test('nor what this process itself holds', async () => {
    const another = await session('mine');
    const release = processes.hold('session', another);
    try {
      await new Promise((r) => setTimeout(r, 200));
      await pass();
      assert.ok(!(await asked()).includes(another));
    } finally { release(); }
  });

  await t.test('no database connection was dropped while the checks ran', () => {
    assert.deepEqual(dropped, [], 'an idle connection was terminated mid-test: ' + dropped.join('; '));
  });
});

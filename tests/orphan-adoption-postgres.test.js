'use strict';

// The new leader while the Pod a release replaced still finishes its turns
// (docs/plans/draining-releases.md), against the REAL schema in a throwaway
// PostgreSQL database:
//
//   - adoptOrphanWorker leaves a turn another live process holds alone;
//   - the leader's periodic sweep (server.js sweepOrphanTurns) adopts what a
//     process left behind: a turn in a recoverable phase that no live process
//     holds, whose record has not moved for ORPHAN_MIN_AGE_MS, whose worker
//     is still there; and nothing else.
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
require('./platform-keys').setPlatformKeys();

test('the leader adopts only what no live process holds', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'orphans_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const workerCalls = [];
  const workerPath = require.resolve('../src/services/worker');
  const realWorker = require(workerPath);
  require.cache[workerPath].exports = {
    ...realWorker,
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

  await t.test('the sweep adopts what was left: unheld (or held by the dead), old enough, recoverable', async () => {
    const adopted = [];
    const out = await server.sweepOrphanTurns({}, { adopt: async (orphan) => { adopted.push(orphan.sessionId); } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(adopted.sort((a, b) => a - b), [heldDead, left].sort((a, b) => a - b));
    assert.equal(out.adopted, 2);
    assert.ok(!adopted.includes(fresh), 'a turn whose record just moved may be one being dispatched');
    assert.ok(!adopted.includes(quarantined), 'a quarantined turn is not recoverable');
    assert.ok(!adopted.includes(headless) && !adopted.includes(building),
      'nor what adoption leaves as it is: a headless run, a durable build\'s session');
    assert.ok(!adopted.includes(heldLive));
  });

  await t.test('the warm workers a process left behind are adopted; one kept warm or busy elsewhere, or with a turn, is not', async () => {
    // docs/plans/web-and-conductor.md: a web process's release or crash
    // elects nobody, so this sweep is what adopts (and later evicts) them.
    async function idle(label) {
      const { rows: [s] } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title)
         VALUES ($1, $2, $3, 'active', $4) RETURNING id`, [app.id, user.id, `b-${label}`, label]);
      return s.id;
    }
    const leftWarm = await idle('left-warm');
    const warmThere = await idle('warm-there');
    const busyThere = await idle('busy-there');
    const stopped = await idle('stopped');
    await pool.query(`INSERT INTO process_holds (process_id, kind, ref) VALUES ('pod-old', 'warm', $1), ('pod-old', 'shots', $2)`,
      [String(warmThere), String(busyThere)]);
    await pool.query(`UPDATE platform_processes SET heartbeat_at = NOW() WHERE id = 'pod-old'`);
    const list = async () => [leftWarm, warmThere, busyThere, left].map((id) => ({ name: `usernode-worker-${id}`, sessionId: id, state: 'running' }))
      .concat([{ name: `usernode-worker-${stopped}`, sessionId: stopped, state: 'exited' }]);
    const adopted = [];
    const n = await server.sweepLeftWarmWorkers({}, { list, adopt: async (w) => { adopted.push(w.sessionId); } });
    assert.equal(n, 1);
    assert.deepEqual(adopted, [leftWarm], 'not one warm or busy on a live process, nor one with a turn (the turn sweep\'s), nor one not running');
    // Nor one this process keeps warm itself.
    const release = processes.hold('warm', leftWarm);
    try {
      adopted.length = 0;
      assert.equal(await server.sweepLeftWarmWorkers({}, { list, adopt: async (w) => { adopted.push(w.sessionId); } }), 0);
    } finally { release(); }
  });

  await t.test('nor what this process itself holds', async () => {
    const release = processes.hold('session', left);
    try {
      const adopted = [];
      await server.sweepOrphanTurns({}, { adopt: async (orphan) => { adopted.push(orphan.sessionId); } });
      await new Promise((r) => setImmediate(r));
      assert.ok(!adopted.includes(left));
    } finally { release(); }
  });
});

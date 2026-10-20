'use strict';

// Idle workers, evicted by the worker-eviction clock from session_workers
// (services/worker-eviction.js), against the FULL PostgreSQL schema: not by
// which process's registry has a worker, and never one something works on
// (a turn, a durable build, a recorded operation). The runtime is a fake.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const eviction = require('../src/services/worker-eviction');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('idle workers are the eviction clock\'s, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `worker_eviction_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('w', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, created_by) VALUES ('W', 'w', 'running', $1) RETURNING id", [user.id]);
  const session = async (extra = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn, workflow_owner)
     VALUES ($1, $2, 'b', 'active', $3::jsonb, $4) RETURNING id`,
    [app.id, user.id, extra.turn ? JSON.stringify(extra.turn) : null, extra.owner || null])).rows[0].id;
  const used = (id, ago) => pool.query(
    `INSERT INTO session_workers (session_id, last_used_at) VALUES ($1, NOW() - $2::interval)
     ON CONFLICT (session_id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at`, [id, ago]);
  // The runtime: the workers it runs, and what was evicted or destroyed.
  const runtime = { running: [], evicted: [], destroyed: [] };
  const worker = {
    listOrphanWorkers: async () => runtime.running.map((id) => ({ name: `usernode-worker-${id}`, sessionId: id, state: 'running' })),
    evictWorker: async (id) => { runtime.evicted.push(id); },
    destroyWorker: async (n) => { runtime.destroyed.push(n); },
    workerContainerName: (id) => `usernode-worker-${id}`,
  };
  const sweep = () => eviction.sweep(pool, { idleMs: 10 * 60 * 1000, deps: { worker } });
  const reset = () => { runtime.evicted.length = 0; runtime.destroyed.length = 0; };

  await t.test('a worker nobody used for the window is evicted, one used lately is kept, whichever process used them', async () => {
    reset();
    const idle = await session();
    const recent = await session();
    await used(idle, '11 minutes');
    await used(recent, '2 minutes');
    runtime.running = [idle, recent];
    await sweep();
    assert.deepEqual(runtime.evicted, [idle]);
    const { rows } = await pool.query('SELECT session_id FROM session_workers ORDER BY session_id');
    assert.deepEqual(rows.map((r) => r.session_id), [recent], 'the evicted worker\'s row goes with it');
  });

  await t.test('never a worker something works on: a turn, a durable build', async () => {
    reset();
    const turning = await session({ turn: { turnId: crypto.randomUUID(), phase: 'executing' } });
    await pool.query(`INSERT INTO wf_instances (machine, key, state, data, machine_version)
                      VALUES ('bot-build', 'run:9', 'building', '{}'::jsonb, 1)`).catch(async () => {
      const c = await pool.connect();
      try {
        await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
        await c.query(`INSERT INTO wf_instances (machine, key, state, data, machine_version) VALUES ('bot-build', 'run:9', 'building', '{}'::jsonb, 1)`);
        await c.query('COMMIT');
      } finally { c.release(); }
    });
    const building = await session({ owner: 'bot-build/run:9' });
    await used(turning, '1 hour');
    await used(building, '1 hour');
    runtime.running = [turning, building];
    await sweep();
    assert.deepEqual(runtime.evicted, []);
  });

  await t.test('a running worker with no row is counted as used from now; one whose change is gone is destroyed', async () => {
    reset();
    const unknown = await session();
    runtime.running = [unknown, 999999];
    await sweep();
    assert.deepEqual(runtime.evicted, []);
    const { rows: [row] } = await pool.query('SELECT last_used_at > NOW() - interval \'1 minute\' AS fresh FROM session_workers WHERE session_id = $1', [unknown]);
    assert.equal(row.fresh, true);
    assert.deepEqual(runtime.destroyed, ['usernode-worker-999999']);
  });

  await t.test('a worker used between the read and the claim is kept', async () => {
    reset();
    const raced = await session();
    await used(raced, '20 minutes');
    runtime.running = [raced];
    const realQuery = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (/DELETE FROM session_workers WHERE session_id = \$1 AND last_used_at = \$2/.test(sql)) {
        await realQuery('UPDATE session_workers SET last_used_at = NOW() WHERE session_id = $1', [raced]);
      }
      return realQuery(sql, params);
    };
    try { await sweep(); } finally { pool.query = realQuery; }
    assert.deepEqual(runtime.evicted, []);
  });
});

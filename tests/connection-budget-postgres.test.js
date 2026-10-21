'use strict';

// What every connection the platform opens says and how long it waits
// (src/db/connection-options.js; item 4, the connection budget), against
// PostgreSQL: a full pool fails a caller after its bounded wait instead of
// queueing it forever; each connection is named by its role and pool; a
// transaction left idle ends, and a dead peer is reaped. And the bus
// listener closes a connection that opened but could not LISTEN.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/connection-budget-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function freshPoolModule() {
  delete require.cache[require.resolve('../src/db/pool')];
  return require('../src/db/pool');
}

test('the main pool: named by its role, a bounded wait, and its sessions time out', { timeout: 30000 }, async (t) => {
  const probe = new Pool({ connectionString: DSN, max: 1, connectionTimeoutMillis: 2000 });
  try { await probe.query('SELECT 1'); } catch (err) {
    await probe.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  t.after(() => probe.end());
  const role = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = 'conductor';
  t.after(() => { if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role; });
  const { getPool } = freshPoolModule();
  const pool = getPool({ databaseUrl: DSN, dbPoolMax: 1, dbPoolWaitMs: 300 });
  t.after(() => pool.end());

  const held = await pool.connect();
  const { rows: [s] } = await held.query(`SELECT current_setting('application_name') AS name,
    current_setting('idle_in_transaction_session_timeout') AS idle_tx, current_setting('tcp_keepalives_idle') AS keepalive,
    current_setting('jit') AS jit`);
  assert.deepEqual(s, { name: 'homeroom-conductor', idle_tx: '1min', keepalive: '20', jit: 'off' });

  // Full: the next caller fails after its wait, not never.
  const started = Date.now();
  await assert.rejects(pool.connect(), /timeout/i);
  const waited = Date.now() - started;
  assert.ok(waited >= 250 && waited < 3000, `waited ${waited} ms`);
  held.release();
  // Free again: the next caller gets it.
  const again = await pool.connect();
  again.release();
});

test('the bus listener closes a connection that opened but could not LISTEN', async () => {
  const pgPath = require.resolve('pg');
  const real = require.cache[pgPath];
  const made = [];
  class FakeClient {
    constructor(options) { this.options = options; this.ended = false; this.listeners = new Map(); made.push(this); }
    on(event, fn) { this.listeners.set(event, fn); return this; }
    removeAllListeners(event) { this.listeners.delete(event); return this; }
    async connect() {}
    async query(sql) { if (/^LISTEN/.test(sql)) throw new Error('permission denied'); return { rows: [] }; }
    async end() { this.ended = true; }
  }
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { ...real.exports, Client: FakeClient } };
  delete require.cache[require.resolve('../src/services/ws-bus')];
  const bus = require('../src/services/ws-bus');
  try {
    bus.start({ connectionString: 'postgres://fake/db' });
    for (let i = 0; i < 50 && !made.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(made.length, 1);
    assert.equal(made[0].ended, true, 'closed, not left open beside the next try');
    assert.match(made[0].options.application_name, /^homeroom-[a-z]+-bus$/, 'named');
    assert.equal(made[0].options.connectionTimeoutMillis, 10000, 'a bounded connect');
  } finally {
    bus.stop();
    require.cache[pgPath] = real;
    delete require.cache[require.resolve('../src/services/ws-bus')];
  }
});

test('a draining process\'s pool shrinks: idle connections above it close now, busy ones when given back', { timeout: 30000 }, async (t) => {
  const probe = new Pool({ connectionString: DSN, max: 1, connectionTimeoutMillis: 2000 });
  try { await probe.query('SELECT 1'); } catch (err) {
    await probe.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  t.after(() => probe.end());
  const { shrinkPool, poolExcess } = require('../src/db/connection-options');
  const name = `drain-shrink-${process.pid}`;
  const pool = new Pool({ connectionString: DSN, max: 4, application_name: name, connectionTimeoutMillis: 300, idleTimeoutMillis: 60000 });
  const given = new Set();
  // Whatever an assertion left checked out goes back, so the pool can end.
  t.after(() => { for (const c of given) c.release(true); return pool.end(); });
  const back = (c) => { given.delete(c); c.release(); };
  const open = async () => (await probe.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [name])).rows[0].n;
  const until = async (n) => { for (let i = 0; i < 50 && (await open()) !== n; i++) await new Promise((r) => setTimeout(r, 20)); return open(); };

  const clients = await Promise.all(Array.from({ length: 4 }, () => pool.connect()));
  for (const c of clients) given.add(c);
  back(clients[2]);
  back(clients[3]);
  assert.equal(await open(), 4);
  assert.equal(shrinkPool(pool, 1), 1);
  assert.equal(await until(2), 2, 'the two idle ones closed at once');
  assert.equal(poolExcess(pool), 1, 'one still above its size, checked out (server.js drainUntilIdle reads it)');
  back(clients[0]);
  back(clients[1]);
  assert.equal(await until(1), 1, 'given back, the busy ones above it closed too');
  assert.equal(poolExcess(pool), 0);
  // And none is opened past it again: a second caller waits, then fails.
  const held = await pool.connect();
  given.add(held);
  await assert.rejects(pool.connect(), /timeout/i);
  back(held);
  assert.equal(await open(), 1);
});

'use strict';

// Session advisory locks on one dedicated connection per process
// (src/db/session-locks.js), against PostgreSQL, with two instances as two
// processes: a lock excludes the other process and orders this one's own
// holders; holding or waiting for one takes nothing from the pool; a key
// excludes an older release's transaction lock on it; the connection closes
// when no lock is held, and one that died is replaced.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/session-locks-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const { createSessionLocks, BUSY } = require('../src/db/session-locks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('session locks on a lock connection of their own', { timeout: 60000 }, async (t) => {
  const pool = new Pool({ connectionString: DSN, max: 1, connectionTimeoutMillis: 3000 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const other = new Pool({ connectionString: DSN, max: 2 });
  t.after(async () => { await pool.end(); await other.end(); });
  const a = createSessionLocks();
  const b = createSessionLocks();
  const key = [990001, Math.floor(Math.random() * 1e6)];

  await t.test('it excludes another process, which waits or is told it is busy', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = a.withSessionLock(pool, key, async () => { await gate; return 'a'; });
    await sleep(100);
    assert.equal(await b.ifSessionLockFree(pool, key, async () => 'b'), BUSY);
    const waiting = b.withSessionLock(pool, key, async () => 'b');
    await sleep(150);
    release();
    assert.deepEqual(await Promise.all([held, waiting]), ['a', 'b']);
  });

  await t.test('this process\'s own holders go one at a time (a session lock is reentrant)', async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = a.withSessionLock(pool, key, async () => { order.push('1:in'); await gate; order.push('1:out'); });
    await sleep(50);
    assert.equal(await a.ifSessionLockFree(pool, key, async () => 'x'), BUSY, 'busy here too');
    const second = a.withSessionLock(pool, key, async () => { order.push('2:in'); });
    await sleep(100);
    assert.deepEqual(order, ['1:in']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['1:in', '1:out', '2:in']);
  });

  await t.test('holding or waiting takes nothing from the pool', async () => {
    // The pool's one connection is in use by the work under the lock.
    const out = await a.withSessionLock(pool, key, async () => (await pool.query('SELECT 7 AS n')).rows[0].n);
    assert.equal(out, 7);
    const client = await pool.connect();
    try {
      // Pool empty: a lock still comes and goes.
      assert.equal(await a.withSessionLock(pool, key, async () => 'ok'), 'ok');
    } finally {
      client.release();
    }
  });

  await t.test('a key excludes an older release\'s transaction lock on it', async () => {
    const c = await other.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['repo-create-test']);
      assert.equal(await a.ifSessionLockFree(pool, { extended: 'repo-create-test' }, async () => 'x'), BUSY);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['signals-test']);
      assert.equal(await a.ifSessionLockFree(pool, { text: 'signals-test' }, async () => 'x'), BUSY);
      await c.query('COMMIT');
      assert.equal(await a.ifSessionLockFree(pool, { extended: 'repo-create-test' }, async () => 'free'), 'free');
    } finally {
      c.release();
    }
  });

  await t.test('a lock that cannot be asked for refuses the work, unless the caller runs unlocked then', async () => {
    const nowhere = { options: { connectionString: 'postgres://nobody:x@127.0.0.1:1/none' }, connect: async () => {} };
    const c = createSessionLocks({ makeClient: (cs) => new (require('pg').Client)({ connectionString: cs, connectionTimeoutMillis: 500 }) });
    await assert.rejects(c.withSessionLock(nowhere, key, async () => 'ran'));
    assert.equal(await c.withSessionLock(nowhere, key, async () => 'ran', { unlockedOnError: true }), 'ran');
  });

  await t.test('the connection closes when no lock is held, and one that died is replaced', async () => {
    await sleep(50);
    assert.equal(a.openConnections(), 0, 'closed with no lock held');
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = a.withSessionLock(pool, key, async () => { await gate; return 'held'; });
    await sleep(100);
    assert.equal(a.openConnections(), 1);
    await other.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'homeroom-%-locks' AND pid <> pg_backend_pid()`);
    await sleep(100);
    release();
    assert.equal(await held, 'held', 'the holder ran on');
    assert.equal(await b.withSessionLock(pool, key, async () => 'next'), 'next', 'the lock is free again');
    assert.equal(await a.withSessionLock(pool, key, async () => 'again'), 'again', 'a new connection');
  });
});

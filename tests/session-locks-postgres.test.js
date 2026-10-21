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
  const a = createSessionLocks({ idleMs: 0 });
  const b = createSessionLocks({ idleMs: 0 });
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

  await t.test('the connection stays open a while with no lock held, so the next lock does not wait for one', async () => {
    const c = createSessionLocks({ idleMs: 200 });
    await c.withSessionLock(pool, key, async () => {});
    assert.equal(c.openConnections(), 1, 'kept');
    await c.withSessionLock(pool, key, async () => {});
    assert.equal(c.openConnections(), 1, 'reused');
    await sleep(350);
    assert.equal(c.openConnections(), 0, 'closed once idle');
  });

  await t.test('a waiter whose lock connection ends goes on waiting on a new one, never running unlocked beside the holder', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let aIn = false;
    let bRanBesideA = null;
    const held = a.withSessionLock(pool, key, async () => { aIn = true; await gate; aIn = false; return 'a'; });
    await sleep(100);
    const waiting = b.withSessionLock(pool, key, async () => { bRanBesideA = aIn; return 'b'; }, { unlockedOnError: true });
    await sleep(150);
    // End only the waiter's lock connection (the one holding no lock).
    await other.query(`SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a WHERE a.application_name LIKE 'homeroom-%-locks'
      AND NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'advisory' AND l.granted)`);
    await sleep(1500);
    assert.equal(bRanBesideA, null, 'still waiting while the other holds it');
    release();
    assert.deepEqual(await Promise.all([held, waiting]), ['a', 'b']);
    assert.equal(bRanBesideA, false);
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

test('a lock statement not answered in time gives the connection up, and the waiter asks again on a new one', async () => {
  const made = [];
  class Stand {
    constructor() { this.n = made.length; this.ended = false; this.handlers = new Map(); made.push(this); }
    on(ev, fn) { this.handlers.set(ev, fn); return this; }
    async connect() {}
    async query(sql) {
      // The first connection went half-open: pg's query_timeout answers.
      if (this.n === 0) throw new Error('Query read timeout');
      return { rows: [{ got: true }] };
    }
    async end() { this.ended = true; }
  }
  const locks = createSessionLocks({ makeClient: () => new Stand(), idleMs: 0 });
  const pool = { options: { connectionString: 'postgres://stand/in' }, connect: async () => {} };
  assert.equal(await locks.withSessionLock(pool, [990003, 1], async () => 'ran'), 'ran');
  assert.equal(made.length, 2, 'a new connection');
  assert.equal(made[0].ended, true, 'the silent one given up');
});

test('a FATAL answer is a lost connection even before pg says it ended: the waiter asks again, never running unlocked', async () => {
  const made = [];
  let ranUnlocked = false;
  class Stand {
    constructor() { this.n = made.length; this.ended = false; made.push(this); }
    on() { return this; }
    async connect() {}
    async query() {
      // The backend was terminated: PostgreSQL's FATAL rejects the statement,
      // and pg's end event has not come yet.
      if (this.n === 0) throw Object.assign(new Error('terminating connection due to administrator command'), { severity: 'FATAL', code: '57P01' });
      return { rows: [{ got: true }] };
    }
    async end() { this.ended = true; }
  }
  const locks = createSessionLocks({ makeClient: () => new Stand(), idleMs: 0 });
  const pool = { options: { connectionString: 'postgres://stand/in' }, connect: async () => {} };
  const out = await locks.withSessionLock(pool, [990004, 1], async () => { ranUnlocked = made.length < 2; return 'ran'; }, { unlockedOnError: true });
  assert.equal(out, 'ran');
  assert.equal(ranUnlocked, false, 'under the lock, asked on a new connection');
  assert.equal(made[0].ended, true);

  // An ordinary statement error leaves the connection as it is.
  const kept = [];
  class Erring {
    constructor() { kept.push(this); this.ended = false; }
    on() { return this; }
    async connect() {}
    async query() { throw Object.assign(new Error('bad'), { severity: 'ERROR', code: '22023' }); }
    async end() { this.ended = true; }
  }
  const strict = createSessionLocks({ makeClient: () => new Erring(), idleMs: 60000 });
  await assert.rejects(strict.withSessionLock(pool, [990004, 2], async () => 'x'), /bad/);
  assert.deepEqual(kept.map((c) => c.ended), [false]);
});

test('a lock still held when its pool ends goes only after the pool\'s own connections: never before them', { timeout: 30000 }, async (t) => {
  const probe = new Pool({ connectionString: DSN, max: 1, connectionTimeoutMillis: 3000 });
  try { await probe.query('SELECT 1'); } catch (err) {
    await probe.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  t.after(() => probe.end());
  const locks = createSessionLocks({ idleMs: 0 });
  const pool = new Pool({ connectionString: DSN, max: 2 });
  const key = [990005, Math.floor(Math.random() * 1e6)];
  const held = async () => (await probe.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1::oid AND objid = $2::oid`, key)).rows[0].n;
  let release;
  const claim = locks.withSessionLock(pool, key, () => new Promise((r) => { release = r; }));
  await sleep(100);
  assert.equal(await held(), 1);
  // A connection still checked out: the pool's end waits for it.
  const busy = await pool.connect();
  const ended = pool.end();
  await sleep(200);
  assert.equal(await held(), 1, 'the lock outlasts the pool connection still open');
  busy.release();
  await ended;
  for (let i = 0; i < 50 && (await held()) > 0; i++) await sleep(20);
  assert.equal(await held(), 0, 'and goes once the pool has ended');
  release();
  await claim.catch(() => {});
});

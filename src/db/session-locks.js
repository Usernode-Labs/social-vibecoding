'use strict';

// Session advisory locks, held on ONE dedicated connection per process and
// database, never on a pooled one (item 4: workflow-foundation
// design-item4-connections.md).
//
// A lock held on a pooled connection keeps that connection out of the pool
// for as long as the work under it runs, and the work queries the same pool:
// once as many holders as the pool has connections wait for one more, the
// process stops. A lock that waits (pg_advisory_lock) held its connection
// while it waited, so callers queued behind one lock emptied the pool too.
// Here every lock of the process lives on its lock connection
// (`homeroom-<role>-locks`): holding a lock costs the pool nothing, and the
// connection budget counts one connection for all of them.
//
//   - A lock that waits is tried and tried again (pg_try_advisory_lock, 50 ms
//     doubling to a second): a blocking call would stop that one connection
//     from taking or giving back every other lock.
//   - Session locks are reentrant within a session, so the process orders its
//     own holders of a key itself (one at a time per key); the lock excludes
//     the other processes.
//   - The keys are the forms the callers always used ((int, int),
//     hashtext(text) or hashtextextended(text, 0)), so an older release
//     beside this one excludes the same: a session lock and a transaction
//     lock on one key exclude each other across sessions.
//   - The connection is opened when a lock is first taken and closed once the
//     process has held none for IDLE_MS. If it ends while locks are held (a failover), the
//     holders run on unprotected, as they did when a pooled connection
//     holding their lock dropped; the next lock opens a new connection.
//
// `pool` names the database (its connection string): the pg Pool the caller
// would otherwise have used. A pool that is not a pg Pool (a test's fake)
// runs the work unlocked, as callers always degraded.

const { Client } = require('pg');
const log = require('../services/logger');
const { connectionName, connectionOptions } = require('./connection-options');

const RETRY_MIN_MS = 50;
// How long the lock connection stays open with no lock held: a lock taken
// again soon (each revision of a proposal, each first turn) does not wait for
// a new connection.
const IDLE_MS = 30000;
const RETRY_MAX_MS = 1000;
const BUSY = Symbol('session-lock-busy');

function keySql(key) {
  if (key && typeof key === 'object' && 'text' in key) return { sql: 'hashtext($1)', params: [String(key.text)], id: `t:${key.text}` };
  if (key && typeof key === 'object' && 'extended' in key) {
    return { sql: 'hashtextextended($1, 0)', params: [String(key.extended)], id: `x:${key.extended}` };
  }
  const [a, b] = key;
  return { sql: '$1::int, $2::int', params: [Number(a), Number(b)], id: `k:${Number(a)}:${Number(b)}` };
}

function createSessionLocks({ makeClient = (connectionString) => new Client({
  connectionString, ...connectionOptions(null, { name: connectionName('locks'), idleInTransactionMs: 0 }),
}), idleMs = IDLE_MS } = {}) {
  // One lock connection per database, opened while any lock is held there.
  const byDatabase = new Map();
  // This process's holders, one at a time per key (session locks are
  // reentrant: two of them would both "take" it).
  const tails = new Map();

  // The lock connection belongs with its pool: ending the pool (a process
  // stopping, a test's database going) closes it, held or idle.
  const hooked = new WeakSet();
  function closeWithPool(pool, connectionString) {
    if (hooked.has(pool) || typeof pool.end !== 'function') return;
    hooked.add(pool);
    const end = pool.end.bind(pool);
    pool.end = async (...args) => {
      const entry = byDatabase.get(connectionString);
      if (entry && !entry.dead) {
        entry.dead = true;
        if (entry.idle) clearTimeout(entry.idle);
        byDatabase.delete(connectionString);
        await entry.queue.then(() => entry.client.end()).catch(() => {});
      }
      return end(...args);
    };
  }

  function connectionFor(connectionString) {
    let entry = byDatabase.get(connectionString);
    if (entry && !entry.dead) {
      if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }
      return entry;
    }
    entry = { users: 0, dead: false, ready: null, client: null, queue: Promise.resolve(), idle: null };
    byDatabase.set(connectionString, entry);
    const client = makeClient(connectionString);
    entry.client = client;
    const lost = (err) => {
      if (entry.dead) return;
      entry.dead = true;
      if (byDatabase.get(connectionString) === entry) byDatabase.delete(connectionString);
      if (entry.users) log.warn('session-locks', 'The lock connection ended while locks were held', { users: entry.users, err: err?.message || null });
    };
    client.on('error', lost);
    client.on('end', () => lost());
    entry.ready = client.connect().catch((err) => { lost(err); throw err; });
    return entry;
  }

  // One statement at a time on the lock connection.
  function onConnection(entry, sql, params) {
    const run = entry.queue.then(async () => {
      await entry.ready;
      if (entry.dead) throw new Error('The lock connection ended');
      return entry.client.query(sql, params);
    });
    entry.queue = run.catch(() => {});
    return run;
  }

  // No lock held on it: closed after idleMs unless one is taken meanwhile.
  function unused(connectionString, entry) {
    if (entry.users || entry.dead) return;
    const close = () => {
      if (entry.users || entry.dead) return;
      entry.dead = true;
      if (byDatabase.get(connectionString) === entry) byDatabase.delete(connectionString);
      entry.queue.then(() => entry.client.end()).catch(() => {});
    };
    if (!idleMs) { close(); return; }
    entry.idle = setTimeout(close, idleMs);
    if (entry.idle.unref) entry.idle.unref();
  }

  async function release(connectionString, entry, k) {
    try {
      if (!entry.dead) await onConnection(entry, `SELECT pg_advisory_unlock(${k.sql})`, k.params);
    } catch (err) {
      log.warn('session-locks', 'Could not give back a lock', { key: k.id, err: err.message });
    } finally {
      entry.users -= 1;
      unused(connectionString, entry);
    }
  }

  // Take `key` and run `fn` under it. `wait`: false answers BUSY at once when
  // another holds it (here or in another process).
  async function run(pool, key, fn, { wait, unlockedOnError = false }) {
    const connectionString = pool && pool.options && pool.options.connectionString;
    if (!connectionString || typeof pool.connect !== 'function') return fn();
    const k = keySql(key);
    const local = `${connectionString}\u0000${k.id}`;
    const prior = tails.get(local);
    if (prior && !wait) return BUSY;
    let done;
    const mine = new Promise((resolve) => { done = resolve; });
    const tail = (prior || Promise.resolve()).then(() => mine);
    tails.set(local, tail);
    try {
      await prior;
      closeWithPool(pool, connectionString);
      const entry = connectionFor(connectionString);
      entry.users += 1;
      let held = false;
      try {
        for (let delay = RETRY_MIN_MS; ; delay = Math.min(RETRY_MAX_MS, delay * 2)) {
          let r;
          try {
            ({ rows: [r] } = await onConnection(entry, `SELECT pg_try_advisory_lock(${k.sql}) AS got`, k.params));
          } catch (err) {
            // The lock could not be asked for (the database refused the
            // connection). A caller for whom that is never a reason to refuse
            // its work runs it unlocked, as it always degraded.
            if (!unlockedOnError) throw err;
            log.warn('session-locks', 'Lock unavailable, running unlocked', { key: k.id, err: err.message });
            break;
          }
          if (r && r.got) { held = true; break; }
          if (!wait) return BUSY;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return await fn();
      } finally {
        if (held) await release(connectionString, entry, k);
        else {
          entry.users -= 1;
          unused(connectionString, entry);
        }
      }
    } finally {
      done();
      if (tails.get(local) === tail) tails.delete(local);
    }
  }

  return {
    // Waits for the lock, then runs `fn` under it.
    withSessionLock: (pool, key, fn, opts = {}) => run(pool, key, fn, { ...opts, wait: true }),
    // Runs `fn` under the lock if it is free now; resolves BUSY otherwise.
    ifSessionLockFree: (pool, key, fn) => run(pool, key, fn, { wait: false }),
    // How many lock connections are open (the connection budget counts one).
    openConnections: () => [...byDatabase.values()].filter((e) => !e.dead).length,
  };
}

module.exports = { ...createSessionLocks(), createSessionLocks, BUSY };

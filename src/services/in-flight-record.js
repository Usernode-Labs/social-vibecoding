'use strict';
// A row that says "this process is doing this right now", for the other
// platform processes (the web Pods and the workflow worker share no memory).
// The tables are the "Work in flight" block at the end of schema.sql:
// app_deploys and session_busy. While a key is held, its row is written at
// once and again every HEARTBEAT_MS, so its heartbeat stays fresh; releasing
// it removes the row. A process that dies stops the heartbeat, and readers
// count only rows whose heartbeat is under two minutes old (`interval '2
// minutes'` in their SQL), so its rows read as nothing within two minutes.
// A process that stops cleanly removes its rows (releaseAll).
//
// Every write of one key waits for the one before it, across a release and
// the next hold: a key held again right after its release must not have its
// new row removed by the release's DELETE landing last.
//
// Best-effort, like the in-memory state it mirrors: a database error is
// logged and never fails the work it describes.

const crypto = require('node:crypto');
const log = require('./logger');

// This process, for the `holder` column. Random rather than a hostname: two
// processes can share one, and each must remove only its own rows.
const HOLDER = crypto.randomUUID();
const HEARTBEAT_MS = 30_000;

// Outside any preview-lifecycle run (services/preview-lifecycle.js): inside
// one, getPool() answers the run's guarded pool, which refuses every query
// once the run settles, and a heartbeat timer would keep that context.
function outsideRuns(fn) {
  const lifecycle = require('./preview-lifecycle');
  return typeof lifecycle.detach === 'function' ? lifecycle.detach(fn) : fn();
}

function pool() {
  return outsideRuns(() => {
    try {
      return require('../db/pool').getPool();
    } catch {
      return null;   // no pool in this process yet (a unit test): memory only
    }
  });
}

const instances = new Set();

// `write(pool, key, data)` upserts a held key's row (its heartbeat
// included); `remove(pool, key)` deletes it. Both run static statements.
function createHolds(name, { write, remove }) {
  const held = new Map();    // key -> { data, timer }
  const tails = new Map();   // key -> the last write queued for it

  function queue(key, run) {
    const p = pool();
    const prev = tails.get(key) || Promise.resolve();
    if (!p) return prev;
    const next = prev
      .then(() => run(p))
      .catch((err) => log.warn(name, 'Could not record work in flight', { err: err.message }));
    tails.set(key, next);
    next.then(() => { if (tails.get(key) === next) tails.delete(key); });
    return next;
  }

  const holds = {
    // Write the key's row now and every HEARTBEAT_MS until release(key).
    // Holding a held key again replaces what it writes.
    hold(key, data) {
      const entry = held.get(key) || { data, timer: null };
      entry.data = data;
      if (entry.timer) clearInterval(entry.timer);
      held.set(key, entry);
      queue(key, (p) => write(p, key, entry.data));
      entry.timer = outsideRuns(() => setInterval(() => queue(key, (p) => write(p, key, entry.data)), HEARTBEAT_MS));
      entry.timer.unref?.();
      return tails.get(key) || Promise.resolve();
    },
    release(key) {
      const entry = held.get(key);
      if (!entry) return Promise.resolve();
      held.delete(key);
      clearInterval(entry.timer);
      return queue(key, (p) => remove(p, key));
    },
    held: (key) => held.has(key),
    // Everything this process holds, released (a clean shutdown).
    releaseAll() {
      return Promise.all([...held.keys()].map((key) => holds.release(key)));
    },
    // Writes still on their way (tests, and shutdown before the pool closes).
    settled: () => Promise.all([...tails.values()]),
  };
  instances.add(holds);
  return holds;
}

// At shutdown, before the pool closes: remove this process's rows, so a
// replaced Pod does not leave work reading as in flight for two minutes.
async function releaseAll() {
  await Promise.all([...instances].map((h) => h.releaseAll()));
  await Promise.all([...instances].map((h) => h.settled()));
}

module.exports = { HOLDER, HEARTBEAT_MS, createHolds, releaseAll };

'use strict';
// A row that says "this process is doing this right now", for the other
// platform processes (the web Pods and the workflow worker share no memory).
// The tables are the "Work in flight" block at the end of schema.sql:
// app_deploys and session_busy. While a key is held, its upsert is written at
// once and again every HEARTBEAT_MS, so its heartbeat stays fresh; releasing
// it writes the removal after any write still on its way. A process that
// dies stops the heartbeat, and readers count only rows whose heartbeat is
// under two minutes old (`interval '2 minutes'` in their SQL), so its rows
// read as nothing within two minutes. The writes are functions of the pool,
// so each statement stays a static string where it is written.
//
// Best-effort, like the in-memory state it mirrors: a database error is
// logged and never fails the work it describes.

const crypto = require('node:crypto');
const log = require('./logger');

// This process, for the `holder` column. Random rather than a hostname: two
// processes can share one, and each must remove only its own rows.
const HOLDER = crypto.randomUUID();
const HEARTBEAT_MS = 30_000;

function pool() {
  try {
    return require('../db/pool').getPool();
  } catch {
    return null;   // no pool in this process yet (a unit test): memory only
  }
}

function createHolds(name) {
  const entries = new Map();   // key -> { chain, timer }

  function write(entry, run) {
    const p = pool();
    if (!p) return entry.chain;
    entry.chain = entry.chain
      .then(() => run(p))
      .catch((err) => log.warn(name, 'Could not record work in flight', { err: err.message }));
    return entry.chain;
  }

  return {
    // Run `upsert(pool)` now and every HEARTBEAT_MS until release(key).
    // Holding a held key again replaces what it writes.
    hold(key, upsert) {
      const entry = entries.get(key) || { chain: Promise.resolve(), timer: null };
      if (entry.timer) clearInterval(entry.timer);
      entries.set(key, entry);
      write(entry, upsert);
      entry.timer = setInterval(() => write(entry, upsert), HEARTBEAT_MS);
      entry.timer.unref?.();
      return entry.chain;
    },
    release(key, remove) {
      const entry = entries.get(key);
      if (!entry) return Promise.resolve();
      entries.delete(key);
      clearInterval(entry.timer);
      return write(entry, remove);
    },
    held: (key) => entries.has(key),
  };
}

module.exports = { HOLDER, HEARTBEAT_MS, createHolds };

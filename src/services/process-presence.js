'use strict';

// This process's presence, for what it records as working on a session
// (services/active-workers.js, recorded on the preview machine's instance).
// Such a record names this process (`holder()`), and a reader in any process
// counts it only while this process holds its presence lock
// (src/workflow/rules/presence.ts): one session-level advisory lock, keyed by
// the holder's name, on a connection this process keeps for as long as it
// lives. A crash or a release ends the connection, and with it every record
// at once, without a heartbeat.
//
// While the process holds records, losing that connection means a reader
// elsewhere already counts them as ended while the work goes on here: the
// process exits. Without records, the lock is taken again when the next one
// is made.

const crypto = require('crypto');
const os = require('os');
const { Client } = require('pg');
const log = require('./logger');
const { PROCESS_PRESENCE_LOCK } = require('./advisory-locks');

const bootId = crypto.randomUUID();
let state = null;      // { client, ready: Promise, lost }
let held = 0;          // records this process holds now

function holder() {
  return `${process.env.HOSTNAME || os.hostname()}:${process.pid}:${bootId}`;
}

function createPresence({ makeClient = (config) => new Client({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000,
  application_name: 'homeroom-presence',
}), onLost = () => process.exit(1) } = {}) {
  async function ensure(config) {
    if (state && !state.lost) return state.ready;
    const s = { client: makeClient(config), ready: null, lost: null };
    const lose = (err) => {
      if (s.lost) return;
      s.lost = err || new Error('Presence connection ended');
      if (held > 0) {
        log.error('process-presence', 'Presence lock lost while holding session records; restarting', { err: s.lost.message, held });
        onLost();
      }
    };
    s.client.on('error', lose);
    s.client.on('end', () => lose(null));
    s.ready = (async () => {
      await s.client.connect();
      await s.client.query('SELECT pg_advisory_lock($1, hashtext($2) & 2147483647)', [PROCESS_PRESENCE_LOCK, holder()]);
    })();
    state = s;
    try {
      await s.ready;
    } catch (err) {
      s.lost = err;
      if (state === s) state = null;
      await s.client.end().catch(() => {});
      throw err;
    }
    return s.ready;
  }

  return {
    holder,
    ensure,
    // Count a record this process holds, and release it.
    hold() { held += 1; },
    release() { held = Math.max(0, held - 1); },
    held: () => held,
    // Tests: forget the connection (the lock goes with it).
    async reset() {
      const s = state;
      state = null;
      held = 0;
      if (s) { s.lost = s.lost || new Error('reset'); await s.client.end().catch(() => {}); }
    },
  };
}

module.exports = { ...createPresence(), createPresence };

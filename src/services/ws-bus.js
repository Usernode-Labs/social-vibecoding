'use strict';

// Cross-instance fan-out for the WebSocket layer.
//
// ── The problem ───────────────────────────────────────────────────────
//
// Every broadcast in ./ws.js walks an in-memory Set of sockets belonging to
// THIS process: `globalClients`, or a room in `rooms`. That is complete and
// correct while the platform runs one pod — `platform.replicas: 1` in the
// Helm values, which is the shipped default.
//
// It fails silently at two. A client connects to whichever pod the load
// balancer picked; the event is emitted by whichever pod handled the request
// (or by the worker inside it). When those differ the event is delivered to
// nobody, no error is logged, and the symptom is a UI that looks frozen until
// the reader reloads the page. Roughly 1-1/N of every live update, for N pods,
// with no signal anywhere that it is happening.
//
// ── The transport ─────────────────────────────────────────────────────
//
// PostgreSQL LISTEN/NOTIFY, because the database is already a hard dependency
// and a shared one. No new service, no new failure domain that isn't already
// fatal, and delivery is at-most-once to currently-listening sessions — which
// is exactly the guarantee the WS layer already gives (every broadcast here is
// fire-and-forget; the client's `resyncCurrentView` on reconnect is what
// repairs a gap).
//
// ── The 8000-byte wall, and why oversize becomes a NUDGE ──────────────
//
// A NOTIFY payload is capped at 8000 bytes and the server rejects anything
// larger outright. Several payloads here can exceed that — a `cc_progress`
// frame, a chat message with a long body. Truncating them would deliver a
// corrupt event, which is worse than delivering none.
//
// So an oversize payload is not sent. What crosses instead is a nudge —
// `{ type: 'resync_hint' }` — to the SAME audience the payload would have
// reached, and the client answers it by re-pulling the view it is looking at.
// That is the identical recovery path a dropped socket already takes, so it
// needs no new client logic beyond one message type. The local instance still
// delivers the real payload to its own sockets; only the remote copy degrades.
//
// ── Self-delivery ─────────────────────────────────────────────────────
//
// The emitting process delivers locally AND publishes. Every envelope carries
// the emitter's instance id and a listener drops its own, so nothing is
// painted twice and local delivery keeps its current latency (no round trip
// through the database for the sockets already in hand).

const crypto = require('node:crypto');
const log = require('./logger');

const CHANNEL = 'usernode_ws';

// 8000 is the server's hard cap. The envelope around the payload is small but
// not free (instance id, kind, routing), so budget the inner JSON well under
// it rather than computing the exact remainder and living on the edge.
const MAX_PAYLOAD_BYTES = 7000;

// Identifies THIS process for the whole life of the process. Random rather
// than derived from a hostname or pod name: two pods can share a host, and a
// collision would make one of them drop the other's events as its own.
const INSTANCE_ID = crypto.randomUUID();

let _client = null;
let _onMessage = null;
let _connectionString = null;
let _stopped = true;
let _retryMs = 1000;
const RETRY_MAX_MS = 30000;

/** Publishes are best-effort; a bus outage must never break a local send. */
let _pool = null;

function _envelope(kind, routing, data) {
  return { i: INSTANCE_ID, k: kind, r: routing || null, d: data };
}

/**
 * Fan an already-locally-delivered event out to the other instances.
 *
 * Never throws and never returns a promise the caller has to handle: a
 * broadcast that reached this pod's sockets has already done its main job.
 */
function publish(kind, routing, data) {
  if (!_pool) return;
  let body;
  try {
    body = JSON.stringify(_envelope(kind, routing, data));
  } catch (err) {
    log.warn('ws-bus', 'payload is not serialisable', { kind, err: err.message });
    return;
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
    // Too big for NOTIFY. Send the nudge instead of a truncated lie.
    try {
      body = JSON.stringify({ i: INSTANCE_ID, k: kind, r: routing || null, o: 1 });
    } catch { return; }
    log.debug('ws-bus', 'payload oversize, sending resync nudge', { kind });
  }
  _pool.query('SELECT pg_notify($1, $2)', [CHANNEL, body])
    .catch((err) => log.warn('ws-bus', 'publish failed', { kind, err: err.message }));
}

function _handleNotification(msg) {
  if (!msg || msg.channel !== CHANNEL || !msg.payload) return;
  let env;
  try {
    env = JSON.parse(msg.payload);
  } catch {
    return;
  }
  // Our own echo. Already delivered locally, before it was ever published.
  if (!env || env.i === INSTANCE_ID) return;
  if (typeof _onMessage !== 'function') return;
  try {
    _onMessage({ kind: env.k, routing: env.r || null, data: env.d, oversize: !!env.o });
  } catch (err) {
    log.warn('ws-bus', 'delivery handler threw', { kind: env.k, err: err.message });
  }
}

async function _connect() {
  if (_stopped) return;
  const { Client } = require('pg');
  // A dedicated connection, NOT one borrowed from the pool: a LISTEN is a
  // property of the session and lasts as long as it does, so a pooled client
  // would either be held out of the pool forever or lose the subscription the
  // moment it was recycled.
  const client = new Client({ connectionString: _connectionString });
  client.on('notification', _handleNotification);
  client.on('error', (err) => {
    log.warn('ws-bus', 'listener error, reconnecting', { err: err.message });
    try { client.end().catch(() => {}); } catch { /* already gone */ }
    if (_client === client) _client = null;
    _scheduleReconnect();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    _client = client;
    _retryMs = 1000;
    log.info('ws-bus', 'listening for cross-instance events', { instance: INSTANCE_ID });
  } catch (err) {
    log.warn('ws-bus', 'listener connect failed, retrying', { err: err.message });
    _scheduleReconnect();
  }
}

function _scheduleReconnect() {
  if (_stopped) return;
  const delay = _retryMs;
  _retryMs = Math.min(_retryMs * 2, RETRY_MAX_MS);
  const t = setTimeout(() => { _connect(); }, delay);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Start the bus. Safe to call when the database is unreachable — publishing
 * degrades to a no-op and the listener retries, so a single-instance
 * deployment behaves exactly as it does today either way.
 */
function start({ pool, connectionString, onMessage }) {
  _pool = pool || null;
  _connectionString = connectionString || null;
  _onMessage = onMessage || null;
  _stopped = false;
  if (!_connectionString) {
    log.warn('ws-bus', 'no connection string — cross-instance fan-out disabled');
    return;
  }
  _connect();
}

async function stop() {
  _stopped = true;
  const client = _client;
  _client = null;
  if (client) {
    try { await client.end(); } catch { /* closing a dead socket */ }
  }
}

module.exports = {
  start, stop, publish,
  CHANNEL, MAX_PAYLOAD_BYTES, INSTANCE_ID,
  // Test seam: drive a notification without a database.
  _handleNotification,
};

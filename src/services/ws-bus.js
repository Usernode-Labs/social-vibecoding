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

// What a workflow machine decided, published inside its transition's
// transaction (src/workflow/platform.ts). It is no instance's own echo, so
// every instance delivers it, the one whose slot decided included, and it
// is not a peer: hearing one says nothing about who else is listening.
const WORKFLOW_SENDER = 'workflow';

let _client = null;
let _onMessage = null;
let _onListening = null;
let _connectionString = null;
let _stopped = true;
let _retryMs = 1000;
const RETRY_MAX_MS = 30000;

/** Publishes are best-effort; a bus outage must never break a local send. */
let _pool = null;

function _envelope(kind, routing, data) {
  return { i: INSTANCE_ID, k: kind, r: routing || null, d: data };
}

// ── Knowing when nobody else is listening (#4318) ────────────────────
//
// Every publish is a `SELECT pg_notify(...)` on the main pool. At one replica
// (the shipped default) nobody hears it: the only listener is this process,
// and it drops its own echo. So a publish is skipped while this instance
// KNOWS it is alone, and "knows" needs all of these at once:
//
//   * its own listener is connected, and has been for PEER_TTL_MS. A process
//     that is not listening cannot hear peers, so it can never conclude
//     there are none; after a reconnect it waits a whole window again;
//   * no envelope from another instance (a `hello`, or any event) arrived in
//     the last PEER_TTL_MS. Every instance running this code sends a
//     `hello` the moment it subscribes and every PEER_HELLO_MS after;
//   * a recent look at pg_stat_activity found no OTHER backend in this
//     database whose last statement was this channel's LISTEN. That is what
//     sees an instance running an older build, which sends no `hello`
//     (read with each hello, so never older than two of them). A
//     backend whose query text this role may not read counts as a listener,
//     so a permissions gap errs towards publishing.
//
// Any doubt — a failed look, a stale one, a peer heard once — means publish,
// which is what every instance did before. Being wrong in that direction
// costs one NOTIFY; being wrong in the other loses live updates.
const PEER_HELLO_MS = 10_000;
const PEER_TTL_MS = 35_000;
// A look at pg_stat_activity rides each hello; one older than two of them is
// stale and no longer counts.
const PEER_POLL_MS = PEER_HELLO_MS;
const HELLO_KIND = 'hello';
const LISTEN_STATEMENT = `LISTEN ${CHANNEL}`;

const _peers = {
  listenerSince: 0,          // when the current listener subscribed; 0 = not listening
  lastPeerAt: -Infinity,     // last envelope heard from another instance
  pollAt: -Infinity,         // when pg_stat_activity was last read successfully
  pollAlone: false,          // what that read said
};
let _peerTimer = null;

/** Pure: may a publish be skipped, given what is known? Exported for tests. */
function _isAlone(state, now) {
  if (!state || !state.listenerSince) return false;
  if (now - state.listenerSince < PEER_TTL_MS) return false;
  if (now - state.lastPeerAt < PEER_TTL_MS) return false;
  if (!state.pollAlone || now - state.pollAt > PEER_POLL_MS * 2) return false;
  return true;
}

function _sendRaw(kind, body) {
  _pool.query('SELECT pg_notify($1, $2)', [CHANNEL, body])
    .catch((err) => log.warn('ws-bus', 'publish failed', { kind, err: err.message }));
}

function _sayHello() {
  if (!_pool || !_peers.listenerSince) return;
  _sendRaw(HELLO_KIND, JSON.stringify({ i: INSTANCE_ID, k: HELLO_KIND }));
}

function _pollListeners() {
  const listener = _client;
  if (!_pool || !listener || !listener.processID) return;
  _pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> $1
        AND (query = $2 OR query = '<insufficient privilege>')`,
    [listener.processID, LISTEN_STATEMENT]
  ).then((res) => {
    const n = Number(res && res.rows && res.rows[0] && res.rows[0].n);
    _peers.pollAlone = Number.isFinite(n) && n === 0;
    _peers.pollAt = Date.now();
  }).catch(() => {
    _peers.pollAlone = false;
  });
}

function _startPeerTimer() {
  if (_peerTimer) return;
  _peerTimer = setInterval(() => {
    _sayHello();
    _pollListeners();
  }, PEER_HELLO_MS);
  if (typeof _peerTimer.unref === 'function') _peerTimer.unref();
}

function _encode(kind, routing, data) {
  let body;
  try {
    body = JSON.stringify(_envelope(kind, routing, data));
  } catch (err) {
    log.warn('ws-bus', 'payload is not serialisable', { kind, err: err.message });
    return null;
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
    // Too big for NOTIFY. Send the nudge instead of a truncated lie.
    try {
      body = JSON.stringify({ i: INSTANCE_ID, k: kind, r: routing || null, o: 1 });
    } catch { return null; }
    log.debug('ws-bus', 'payload oversize, sending resync nudge', { kind });
  }
  return body;
}

/**
 * Fan an already-locally-delivered event out to the other instances.
 *
 * Never throws and never returns a promise the caller has to handle: a
 * broadcast that reached this pod's sockets has already done its main job.
 */
function publish(kind, routing, data) {
  if (!_pool) return;
  if (_isAlone(_peers, Date.now())) return;
  const body = _encode(kind, routing, data);
  if (body == null) return;
  _sendRaw(kind, body);
}

// ── Batching a busy stream (#4318) ───────────────────────────────────
//
// A coding agent's run streams a progress line every few hundred
// milliseconds, and each one used to be its own NOTIFY. `publishBatched`
// keeps one queue per key (a session): the first event after a quiet spell
// goes out at once, and whatever follows within BATCH_WINDOW_MS rides in one
// `batch` envelope at the end of the window. So a key costs at most about
// 1000 / BATCH_WINDOW_MS notifications a second however fast it streams.
// Nothing is dropped or merged: the receiving instance replays every item,
// in order, through the same handler a single envelope reaches. A batch that
// would outgrow the NOTIFY budget is sent early, and an item too big on its
// own still becomes the oversize nudge for its audience.
const BATCH_WINDOW_MS = 250;
const _batches = new Map(); // key -> { items: [{k,r,d}], bytes, timer, lastFlushAt }

function _itemFor(kind, routing, data) {
  const item = { k: kind, r: routing || null, d: data };
  let json;
  try {
    json = JSON.stringify(item);
  } catch (err) {
    log.warn('ws-bus', 'payload is not serialisable', { kind, err: err.message });
    return null;
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES - 200) {
    const nudge = { k: kind, r: routing || null, o: 1 };
    return { item: nudge, bytes: Buffer.byteLength(JSON.stringify(nudge), 'utf8') };
  }
  return { item, bytes: Buffer.byteLength(json, 'utf8') };
}

function _flushBatch(key) {
  const q = _batches.get(key);
  if (!q) return;
  if (q.timer) { clearTimeout(q.timer); q.timer = null; }
  const items = q.items;
  q.items = [];
  q.bytes = 0;
  q.lastFlushAt = Date.now();
  if (!items.length) { _batches.delete(key); return; }
  if (!_pool || _isAlone(_peers, Date.now())) return;
  let body;
  try {
    // One item is an ordinary envelope; only a real batch needs the wrapper.
    body = items.length === 1
      ? JSON.stringify({ i: INSTANCE_ID, ...items[0] })
      : JSON.stringify({ i: INSTANCE_ID, k: 'batch', b: items });
  } catch { return; }
  _sendRaw(items.length === 1 ? items[0].k : 'batch', body);
}

// After a flush, keep the queue (with lastFlushAt) for one more window, so the
// next event waits for it; send what arrived meanwhile and look again, and
// forget the queue once a window passes with nothing new. Without the re-arm,
// a session that went quiet right after a timed flush kept its entry forever.
function _armTrailing(key, q) {
  q.timer = setTimeout(() => {
    q.timer = null;
    if (_batches.get(key) !== q) return;
    if (!q.items.length) { _batches.delete(key); return; }
    _flushBatch(key);
    _armTrailing(key, q);
  }, BATCH_WINDOW_MS);
  if (typeof q.timer.unref === 'function') q.timer.unref();
}

/**
 * Like publish, but events sharing `key` are sent at most once per
 * BATCH_WINDOW_MS, together and in order. Never throws.
 */
function publishBatched(key, kind, routing, data) {
  if (!_pool) return;
  if (_isAlone(_peers, Date.now())) return;
  const encoded = _itemFor(kind, routing, data);
  if (!encoded) return;
  const now = Date.now();
  let q = _batches.get(key);
  if (!q) {
    q = { items: [], bytes: 0, timer: null, lastFlushAt: -Infinity };
    _batches.set(key, q);
  }
  if (q.items.length && q.bytes + encoded.bytes > MAX_PAYLOAD_BYTES - 200) _flushBatch(key);
  q.items.push(encoded.item);
  q.bytes += encoded.bytes + 1;
  if (q.timer) return;
  const wait = q.lastFlushAt + BATCH_WINDOW_MS - now;
  if (wait <= 0) {
    _flushBatch(key);
    _armTrailing(key, q);
  } else {
    q.timer = setTimeout(() => {
      q.timer = null;
      if (_batches.get(key) !== q) return;
      _flushBatch(key);
      _armTrailing(key, q);
    }, wait);
    if (typeof q.timer.unref === 'function') q.timer.unref();
  }
}

/** Send everything still waiting in a batch window. Used at shutdown and by tests. */
function flushBatches() {
  for (const key of [..._batches.keys()]) _flushBatch(key);
}

/**
 * The NOTIFY body for a push a workflow transition publishes: the same
 * envelope as publish, from WORKFLOW_SENDER, and the same resync nudge in
 * place of a payload over the budget. Pure.
 */
function workflowBody(kind, routing, data) {
  const body = JSON.stringify({ i: WORKFLOW_SENDER, k: kind, r: routing || null, d: data });
  if (Buffer.byteLength(body, 'utf8') <= MAX_PAYLOAD_BYTES) return body;
  // The nudge keeps the message's type, so what a relay runs beside the
  // sockets (services/ws.js afterWorkflowPush) still runs for it.
  return JSON.stringify({ i: WORKFLOW_SENDER, k: kind, r: routing || null, o: 1, t: data && data.type ? String(data.type) : null });
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
  if (env.i === WORKFLOW_SENDER) {
    if (typeof _onMessage === 'function' && env.k !== HELLO_KIND) {
      _deliver({ kind: env.k, routing: env.r || null, data: env.d, oversize: !!env.o, type: env.t || null, fromWorkflow: true });
    }
    return;
  }
  // Anything from another instance proves it exists (see _isAlone).
  _peers.lastPeerAt = Date.now();
  if (env.k === HELLO_KIND) return;
  if (typeof _onMessage !== 'function') return;
  if (env.k === 'batch') {
    if (!Array.isArray(env.b)) return;
    for (const item of env.b) {
      if (!item || typeof item !== 'object') continue;
      _deliver({ kind: item.k, routing: item.r || null, data: item.d, oversize: !!item.o });
    }
    return;
  }
  _deliver({ kind: env.k, routing: env.r || null, data: env.d, oversize: !!env.o });
}

function _deliver(message) {
  try {
    _onMessage(message);
  } catch (err) {
    log.warn('ws-bus', 'delivery handler threw', { kind: message.kind, err: err.message });
  }
}

// ── A gap in listening is a gap in delivery (#4177) ──────────────────
//
// NOTIFY reaches only the sessions LISTENing when it is sent. While this
// listener is down (the database restarted, the connection dropped, the first
// connect is still retrying) every event another instance publishes is lost
// for this instance's sockets, and nothing tells them. So each time the
// listener is subscribed again, this instance's sockets are told to re-read
// what they show: the same nudge an oversize payload becomes. The very first
// subscription at boot tells nobody anything, because nobody is connected yet.
//
// The nudge makes every client re-read its screen, so it is rationed. A
// listener that keeps dropping (an idle timeout on the path to the database)
// would otherwise nudge everyone about once a second, and after a database
// restart every instance would nudge every client at the same moment. So it
// goes out at most once per HINT_MIN_INTERVAL_MS, and a later subscription
// within that window is covered by one nudge at its end; each is delayed by
// up to HINT_JITTER_MS so instances do not fire together.
const HINT_MIN_INTERVAL_MS = 30_000;
const HINT_JITTER_MS = 2_000;
let _lastHintAt = -Infinity;
let _hintTimer = null;

/** How long until the nudge may go out. Pure; exported for tests. */
function _hintDelay(now, lastHintAt, random) {
  return Math.max(0, lastHintAt + HINT_MIN_INTERVAL_MS - now) + Math.floor(random * HINT_JITTER_MS);
}

function _listening() {
  if (typeof _onListening !== 'function' || _hintTimer) return;
  _hintTimer = setTimeout(() => {
    _hintTimer = null;
    _lastHintAt = Date.now();
    if (typeof _onListening !== 'function') return;
    try {
      _onListening();
    } catch (err) {
      log.warn('ws-bus', 'listening handler threw', { err: err.message });
    }
  }, _hintDelay(Date.now(), _lastHintAt, Math.random()));
  if (typeof _hintTimer.unref === 'function') _hintTimer.unref();
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
    if (_client === client) {
      _client = null;
      // Not listening means not hearing peers: stop claiming to be alone.
      _peers.listenerSince = 0;
      _peers.pollAlone = false;
    }
    _scheduleReconnect();
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    _client = client;
    _retryMs = 1000;
    log.info('ws-bus', 'listening for cross-instance events', { instance: INSTANCE_ID });
    _listening();
    // Not alone until proven so, from this subscription on (_isAlone).
    _peers.listenerSince = Date.now();
    _peers.pollAlone = false;
    _sayHello();
    _pollListeners();
    _startPeerTimer();
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
 *
 * `onListening` runs each time the listener is subscribed (see `_listening`).
 */
function start({ pool, connectionString, onMessage, onListening }) {
  _pool = pool || null;
  _connectionString = connectionString || null;
  _onMessage = onMessage || null;
  _onListening = onListening || null;
  _stopped = false;
  if (!_connectionString) {
    log.warn('ws-bus', 'no connection string — cross-instance fan-out disabled');
    return;
  }
  _connect();
}

async function stop() {
  flushBatches();
  _stopped = true;
  if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
  if (_peerTimer) { clearInterval(_peerTimer); _peerTimer = null; }
  _peers.listenerSince = 0;
  _peers.pollAlone = false;
  const client = _client;
  _client = null;
  if (client) {
    try { await client.end(); } catch { /* closing a dead socket */ }
  }
}

module.exports = {
  start, stop, publish, publishBatched, flushBatches,
  CHANNEL, MAX_PAYLOAD_BYTES, INSTANCE_ID, WORKFLOW_SENDER, workflowBody,
  BATCH_WINDOW_MS, PEER_HELLO_MS, PEER_TTL_MS, PEER_POLL_MS,
  _isAlone,
  _peers,
  _batches,
  // Test seams: drive a notification, or a fresh subscription, without a
  // database.
  _handleNotification,
  _listening,
  _hintDelay,
  HINT_MIN_INTERVAL_MS,
};

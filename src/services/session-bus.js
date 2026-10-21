'use strict';

// A turn's stream: what a live turn shows a browser, as it happens, kept in
// Postgres (stream_events) so that a browser served by any platform process
// follows it, and resumes after a dropped connection, whichever process runs
// the turn.
//
// A stream is a change's (its id) or a conversation's (`agent:<id>`). A turn
// publishes every event it shows (each with its own `_seq`, which a browser
// dedupes by across channels); GET /api/sessions/:id/events and GET
// /api/agent-sessions/:id/events subscribe, and a browser that reconnects
// sends the last `_seq` it saw (Last-Event-Id) and is given everything after
// it. Before, this was a ring buffer in the process running the turn: a
// browser whose resume reached another process saw nothing.
//
//   publish(key, event)       the turn's event, written in publish order;
//                             a run of `token` events is joined into one
//                             row (their texts appended) within a beat
//   subscribe(key, cb, since) what comes after `since` (a `_seq`, or
//                             { afterId }), then everything new: woken by
//                             a NOTIFY on the WebSocket bus's channel, and
//                             read again every few seconds (a NOTIFY reaches
//                             only who listens when it is sent)
//   snapshot(key, opts)       the stream's rows, oldest first (a running
//                             turn's, by its `_seq` prefix)
//   findLast(key, predicate)  the newest event matching
//   clearSession(key)         a finished turn's rows, once its grace passed
//   subscriberCount(key)      how many browsers follow it now, on any
//                             process (stream_watchers, counted while their
//                             process holds its presence lock)
//
// Publishing never throws and never waits: a stream that cannot be written
// loses that event (logged), as a dropped socket would.

const log = require('./logger');
const pushes = require('../workflow/pushes.ts');
const { holderAliveSql } = require('../workflow/rules/presence.ts');

// A run of token events is joined within this long.
const TOKEN_JOIN_MS = 150;
// A subscriber reads again this often, whatever it heard.
const POLL_MS = 2000;
// Rows read at a time.
const READ_LIMIT = 500;
// What clearSession keeps: a turn that started this recently.
const CLEAR_KEEP_SECONDS = 25;
// The bus kind a published event's NOTIFY carries (services/ws.js relays it
// to wake()).
const STREAM_KIND = 'stream';

let poolRef = null;
let warned = false;

/**
 * Where the streams live: the platform's pool (server.js, at boot), or, for
 * a test that runs no database, `{ memory: true }`: the same rows kept in
 * this process (memoryPool below).
 */
function init({ pool = null, memory = false } = {}) {
  poolRef = memory ? memoryPool() : pool;
}

function db() {
  if (!poolRef && !warned) {
    warned = true;
    log.warn('session-bus', 'No database for turn streams: events are not kept');
  }
  return poolRef;
}

// The queries this module makes, answered from memory: a test's stand-in
// for stream_events and stream_watchers, never used by the platform.
function memoryPool() {
  const events = [];
  const watchers = [];
  let nextId = 0;
  const rows = (r) => ({ rows: r, rowCount: r.length });
  const ofKey = (key) => events.filter((e) => e.stream_key === key);
  return {
    options: {},
    memory: true,
    async query(sql, p = []) {
      if (sql.includes('INSERT INTO stream_events')) {
        nextId += 1;
        events.push({ id: nextId, stream_key: p[0], seq: p[1], event: JSON.parse(p[2]), at: Date.now() });
        return rows([{ id: nextId }]);
      }
      if (sql.includes('INSERT INTO stream_watchers')) {
        nextId += 1;
        watchers.push({ id: nextId, stream_key: p[0] });
        return rows([{ id: nextId }]);
      }
      if (sql.startsWith('DELETE FROM stream_watchers WHERE id')) {
        const i = watchers.findIndex((w) => w.id === p[0]);
        if (i >= 0) watchers.splice(i, 1);
        return rows([]);
      }
      if (sql.includes('COUNT(*)::int AS n FROM stream_watchers')) {
        return rows([{ n: watchers.filter((w) => w.stream_key === p[0]).length }]);
      }
      if (sql.includes('AND seq = $2')) {
        const hit = ofKey(p[0]).filter((e) => e.seq === p[1]).pop();
        return rows(hit ? [{ id: hit.id }] : []);
      }
      if (sql.includes('COALESCE(MAX(id), 0)')) {
        const all = ofKey(p[0]);
        return rows([{ id: all.length ? all[all.length - 1].id : 0 }]);
      }
      if (sql.includes('AND id > $2')) {
        return rows(ofKey(p[0]).filter((e) => e.id > p[1]).slice(0, p[2]).map((e) => ({ id: e.id, event: e.event })));
      }
      if (sql.includes('starts_with(seq')) {
        return rows(ofKey(p[0]).filter((e) => p[1] == null || e.seq.startsWith(p[1])).map((e) => ({ id: e.id, event: e.event })));
      }
      if (sql.includes('ORDER BY id DESC LIMIT')) {
        return rows(ofKey(p[0]).slice().reverse().slice(0, p[1]).map((e) => ({ event: e.event })));
      }
      if (sql.startsWith('DELETE FROM stream_events WHERE stream_key')) {
        const cutoff = Date.now() - p[1] * 1000;
        const upTo = ofKey(p[0]).filter((e) => e.event && e.event.type === 'done' && e.at < cutoff)
          .reduce((max, e) => Math.max(max, e.id), 0);
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i].stream_key === p[0] && events[i].id <= upTo) events.splice(i, 1);
        }
        return rows([]);
      }
      return rows([]);
    },
  };
}

// ── Publishing ────────────────────────────────────────────────────────

// Events waiting to be written, in publish order, and the token run each
// stream is joining.
const queue = [];
const joining = new Map(); // key -> { event, timer }
let draining = null;

const SAME_SHAPE = (a, b) => {
  const ka = Object.keys(a).filter((k) => k !== 'text' && k !== '_seq').sort();
  const kb = Object.keys(b).filter((k) => k !== 'text' && k !== '_seq').sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]));
};
const isToken = (e) => e.type === 'token' && typeof e.text === 'string';

function endJoin(key) {
  const j = joining.get(key);
  if (!j) return;
  joining.delete(key);
  clearTimeout(j.timer);
  queue.push({ key, event: j.event });
}

function publish(sessionId, event) {
  if (!event || !event._seq) return;
  const key = String(sessionId);
  const plain = JSON.parse(JSON.stringify(event));
  if (isToken(plain)) {
    const j = joining.get(key);
    if (j && SAME_SHAPE(j.event, plain)) {
      j.event = { ...j.event, text: j.event.text + plain.text, _seq: plain._seq };
      return;
    }
    endJoin(key);
    const timer = setTimeout(() => { endJoin(key); drain(); }, TOKEN_JOIN_MS);
    if (typeof timer.unref === 'function') timer.unref();
    joining.set(key, { event: plain, timer });
    return;
  }
  endJoin(key);
  queue.push({ key, event: plain });
  drain();
}

function drain() {
  if (draining) return draining;
  draining = (async () => {
    try {
      while (queue.length) {
        const { key, event } = queue.shift();
        await write(key, event);
      }
    } finally {
      draining = null;
    }
  })();
  return draining;
}

async function write(key, event) {
  const pool = db();
  if (!pool) return;
  try {
    const { rows: [row] } = await pool.query(
      `WITH e AS (INSERT INTO stream_events (stream_key, seq, event) VALUES ($1, $2, $3::jsonb) RETURNING id)
       SELECT e.id, pg_notify($4, json_build_object('i', $5::text, 'k', $6::text,
                'r', json_build_object('key', $1::text, 'id', e.id), 'd', json_build_object())::text) AS notified
         FROM e`,
      [key, String(event._seq), JSON.stringify(event), pushes.BUS_CHANNEL, pushes.WORKFLOW_SENDER, STREAM_KIND]);
    if (row) wake(key, Number(row.id));
  } catch (err) {
    log.warn('session-bus', 'A turn\'s event could not be kept', { key, type: event.type, err: err.message });
  }
}

/** Everything published so far, written (tests, and a process stopping). */
async function flush() {
  for (const key of [...joining.keys()]) endJoin(key);
  while (queue.length || draining) await drain();
}

// ── Following ─────────────────────────────────────────────────────────

const subs = new Set();
let pollTimer = null;

function ensurePoll() {
  if (pollTimer || !subs.size) return;
  pollTimer = setInterval(() => {
    if (!subs.size) { clearInterval(pollTimer); pollTimer = null; return; }
    for (const s of subs) pump(s);
  }, POLL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

/** A stream has a new row `id` (this process wrote it, or a NOTIFY said so). */
function wake(key, id = null) {
  const k = String(key);
  for (const s of subs) {
    if (s.key === k && (id == null || s.lastId == null || id > s.lastId)) pump(s);
  }
}

// Where a subscriber starts: after `since` (a `_seq` it saw, or
// { afterId }), else after what the stream holds now. An unknown `_seq`
// replays what the stream still holds, as the ring buffer did.
async function startId(pool, key, since) {
  if (since && typeof since === 'object' && Number.isFinite(Number(since.afterId))) return Number(since.afterId);
  if (since) {
    const { rows: [r] } = await pool.query(
      'SELECT id FROM stream_events WHERE stream_key = $1 AND seq = $2 ORDER BY id DESC LIMIT 1', [key, String(since)]);
    return r ? Number(r.id) : 0;
  }
  const { rows: [r] } = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM stream_events WHERE stream_key = $1', [key]);
  return Number(r.id);
}

// Reads what is new for subscriber `s` and hands it over, in order. One read
// at a time: a wake while it reads makes it read once more. Resolves once
// it has caught up.
function pump(s) {
  if (s.closed) return Promise.resolve();
  if (s.running) { s.again = true; return s.running; }
  const pool = db();
  if (!pool) return Promise.resolve();
  s.running = read(s, pool).finally(() => { s.running = null; });
  return s.running;
}

async function read(s, pool) {
  try {
    do {
      s.again = false;
      if (s.lastId == null) s.lastId = await startId(pool, s.key, s.since);
      let more = true;
      while (more && !s.closed) {
        const { rows } = await pool.query(
          'SELECT id, event FROM stream_events WHERE stream_key = $1 AND id > $2 ORDER BY id LIMIT $3',
          [s.key, s.lastId, READ_LIMIT]);
        for (const r of rows) {
          s.lastId = Number(r.id);
          if (s.closed) break;
          try { s.cb(r.event); } catch { /* the subscriber's own trouble */ }
        }
        more = rows.length === READ_LIMIT;
      }
    } while (s.again && !s.closed);
  } catch (err) {
    log.warn('session-bus', 'A stream could not be read', { key: s.key, err: err.message });
  }
}

/** Everything published here written and handed to this process's subscribers (tests). */
async function settle() {
  await flush();
  await Promise.all([...subs].map((s) => pump(s)));
}

/**
 * Follow stream `sessionId`: `cb(event)` for what comes after `since`, then
 * for everything new, in order. Counted as a watcher (subscriberCount) for
 * as long as it is followed. Returns the unsubscribe function.
 */
function subscribe(sessionId, cb, since = null) {
  const key = String(sessionId);
  const s = { key, cb, since, lastId: null, running: null, again: false, closed: false, watcher: null };
  subs.add(s);
  ensurePoll();
  pump(s);
  s.watcher = watch(key);
  return () => {
    if (s.closed) return;
    s.closed = true;
    subs.delete(s);
    void s.watcher.then((id) => unwatch(id));
  };
}

// ── Watchers ──────────────────────────────────────────────────────────

function presence() {
  return require('./process-presence');
}

async function watch(key) {
  const pool = db();
  if (!pool) return null;
  try {
    const p = presence();
    if (!pool.memory) await p.ensure({ databaseUrl: pool.options?.connectionString });
    const { rows: [r] } = await pool.query(
      'INSERT INTO stream_watchers (stream_key, holder) VALUES ($1, $2) RETURNING id', [key, p.holder()]);
    return r ? Number(r.id) : null;
  } catch (err) {
    log.warn('session-bus', 'A stream\'s watcher could not be counted', { key, err: err.message });
    return null;
  }
}

async function unwatch(id) {
  const pool = db();
  if (!pool || !id) return;
  await pool.query('DELETE FROM stream_watchers WHERE id = $1', [id]).catch(() => {});
}

/** How many browsers follow stream `sessionId` now, on any process. 0 when unknown. */
async function subscriberCount(sessionId) {
  const pool = db();
  if (!pool) return 0;
  try {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stream_watchers w WHERE w.stream_key = $1 AND ${holderAliveSql('w.holder')}`,
      [String(sessionId)]);
    return Number(r?.n) || 0;
  } catch {
    return 0;
  }
}

// ── Reading ───────────────────────────────────────────────────────────

/**
 * The stream's events, oldest first, with their row ids (`_id`): all it
 * still holds, or a running turn's (`seqPrefix`, the prefix its `_seq`s
 * share). Resolves [] when unknown.
 */
async function snapshot(sessionId, { seqPrefix = null } = {}) {
  const pool = db();
  if (!pool) return [];
  await flush();
  const { rows } = await pool.query(
    `SELECT id, event FROM stream_events
      WHERE stream_key = $1 AND ($2::text IS NULL OR starts_with(seq, $2))
      ORDER BY id LIMIT 2000`, [String(sessionId), seqPrefix]);
  return rows.map((r) => ({ ...r.event, _id: Number(r.id) }));
}

/**
 * Where stream `sessionId` is now (its newest row's id, 0 for none), for a
 * subscriber that must see everything from this moment on, published by
 * any process: subscribe with { afterId: position }.
 */
async function position(sessionId) {
  const pool = db();
  if (!pool) return 0;
  await flush();
  const { rows: [r] } = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM stream_events WHERE stream_key = $1', [String(sessionId)]);
  return Number(r.id);
}

/** The newest event of the stream matching `predicate`, or null. */
async function findLast(sessionId, predicate) {
  const pool = db();
  if (!pool) return null;
  await flush();
  const { rows } = await pool.query(
    'SELECT event FROM stream_events WHERE stream_key = $1 ORDER BY id DESC LIMIT $2', [String(sessionId), READ_LIMIT]);
  for (const r of rows) if (predicate(r.event)) return r.event;
  return null;
}

/**
 * A turn ended: its stream's rows go, up to its newest `done` past the
 * grace (a turn's end). A turn that started after it keeps every row of its
 * own, however long ago it started, wherever it runs. Callers wait the grace
 * a browser needs to replay the end first.
 */
function clearSession(sessionId) {
  const pool = db();
  if (!pool) return;
  const key = String(sessionId);
  void flush().then(() => pool.query(
    `DELETE FROM stream_events WHERE stream_key = $1
        AND id <= COALESCE((SELECT MAX(d.id) FROM stream_events d
                             WHERE d.stream_key = $1 AND d.event->>'type' = 'done'
                               AND d.created_at < NOW() - make_interval(secs => $2)), 0)`,
    [key, CLEAR_KEEP_SECONDS])).catch((err) => log.warn('session-bus', 'A finished turn\'s stream was not cleared', { key, err: err.message }));
}

/**
 * The retention clock's sweep: streams older than `maxAgeHours`, and
 * watchers whose process is gone.
 */
async function prune(pool = db(), { maxAgeHours = 6 } = {}) {
  if (!pool) return { events: 0, watchers: 0 };
  const events = await pool.query(
    'DELETE FROM stream_events WHERE created_at < NOW() - make_interval(hours => $1)', [maxAgeHours]);
  const watchers = await pool.query(
    `DELETE FROM stream_watchers w WHERE w.opened_at < NOW() - interval '1 minute' AND NOT ${holderAliveSql('w.holder')}`);
  return { events: events.rowCount || 0, watchers: watchers.rowCount || 0 };
}

/**
 * A turn a request asked for, relayed to it as server-sent events from
 * `afterId` (a `position` read before the turn was asked) until the turn's
 * own end (its `done` carrying `turnId`): the turn runs in a workflow process (services/turns.js), and its
 * events reach the request whichever process that is. A request that goes
 * leaves the turn running, as a dropped stream always did. The caller has
 * written the response's head.
 */
function relay(req, res, key, { afterId = 0, turnId = null, heartbeatMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let ended = false;
    let off = () => {};
    const heartbeat = setInterval(() => { try { res.write(':heartbeat\n\n'); } catch { /* client gone */ } }, heartbeatMs);
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      off();
      try { res.end(); } catch { /* already closed */ }
      resolve();
    };
    off = subscribe(key, (event) => {
      if (ended) return;
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
      // Its own turn's end (services/turns.js, turn/machine.ts
      // turnEndEvent): never an earlier turn's, still ending as this one is
      // asked, nor a later one's.
      if (event.type === 'done' && (turnId == null || event.turnId === String(turnId))) end();
    }, { afterId });
    req.on('close', end);
  });
}

module.exports = {
  init, publish, subscribe, relay, snapshot, position, findLast, clearSession, subscriberCount, wake, flush, settle, prune,
  STREAM_KIND, TOKEN_JOIN_MS,
};

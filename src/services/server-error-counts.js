'use strict';

// Server errors, counted: what each process answered on /api/, per minute,
// and every 5xx among it by route TEMPLATE, error type and first frame in
// this repository (platform signals, wave 2).
//
// Until now a 5xx was a log line and one process's 200-line ring, so a
// route that failed one request in ten for a day was seen only by somebody
// reading logs. Here every process keeps its own counts in memory
// (middleware/request-counts.js records each response as it finishes;
// middleware/error-handler.js leaves what it caught on res.locals) and
// flushes the minutes that have ended every 60 seconds:
//
//   server_request_minutes  (minute, pod)  requests, errors
//                           the `infra.server-errors` figure's rate
//   server_error_minutes    (minute, pod, method, route, status, err_type,
//                           frame)  count, one scrubbed sample
//                           the `server_errors` signal's observer
//                           (signal-observers/server-errors.js)
//   server_route_minutes    (minute, pod, method, route)  requests, streams,
//                           total_ms, max_ms, bytes: what each route cost,
//                           so a minute whose process was busy says which
//                           route kept it busy. Every response counts here,
//                           /api/ or not (the rest as `(non-api)`); an event
//                           stream counts, but its time does not (it is
//                           open for as long as its client likes). Only the
//                           ROUTE_ROWS costliest routes of a minute are kept
//                           by name, the rest as `(other)`, for
//                           ROUTE_RETENTION_DAYS.
//
// What a row may say is typed: the route as Express declared it
// (`/api/apps/:slug/issues/:n`, never the path a person requested), the
// error's constructor and code, and a `file:line` from a stack. The one
// message kept per row is scrubbed (platform-signal-evidence.js), cut to
// 300 characters, and still private: it can echo what a person sent, so the
// column is staging:private and never reaches a public request.
//
// Memory is bounded whatever happens: at most MAX_ERROR_KEYS distinct
// errors and MAX_ROUTE_KEYS distinct routes per minute (the rest still count
// in the minute's total, and in `(other)`) and MAX_MINUTES minutes held
// while the database refuses the flush.

const os = require('os');
const path = require('path');
const log = require('./logger');
const { scrubText } = require('./platform-signal-evidence');
const { ownFrames } = require('./platform-signal-observers');

const MINUTE_MS = 60 * 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const RETENTION_DAYS = 14;
// A busy minute writes up to ROUTE_ROWS rows per process, so the route costs
// are kept for an incident's look back, not a trend's.
const ROUTE_RETENTION_DAYS = 7;
const MAX_ERROR_KEYS = 500;
const MAX_ROUTE_KEYS = 500;
const ROUTE_ROWS = 40;
const MAX_MINUTES = 30;
const SAMPLE_CHARS = 300;
// The columns' widths (schema.sql), applied BEFORE a row's key is made, so
// two keys in memory are never one row in the database (an upsert that
// touches a row twice in one statement fails whole).
const WIDTH = Object.freeze({ pod: 64, method: 8, route: 160, errType: 64, frame: 160 });
const UNMATCHED = '(unmatched)';
// A response outside /api/ that no route declared (a static file, the shell,
// a pack): one row, never the path requested, which can carry a token.
const NON_API = '(non-api)';
// The routes past a minute's ROUTE_ROWS costliest (or past MAX_ROUTE_KEYS).
const OTHER = '(other)';
// This checkout's root, cut from a stack's paths so a frame is read
// relative to it wherever the repository lives (`/app` in the images).
const ROOT = path.resolve(__dirname, '..', '..') + path.sep;

// ── Pure helpers ────────────────────────────────────────────────────────

/** Pure: the start of `ms`'s minute, in epoch milliseconds (UTC). */
function minuteOf(ms) {
  return Math.floor(Number(ms) / MINUTE_MS) * MINUTE_MS;
}

/** Pure: this process's name in the tables. */
function podName(env = process.env, hostname = os.hostname) {
  return String(env.HOSTNAME || hostname() || 'unknown').slice(0, WIDTH.pod);
}

// Where middleware/request-counts.js keeps the router base a route matched
// under: express restores req.baseUrl as an error leaves a mounted router,
// so by the error handler's turn it no longer names the route's prefix.
const ROUTE_BASE = Symbol('server-error-counts.routeBase');

function routePathText(p) {
  if (Array.isArray(p)) return p.map(routePathText).join('|');
  if (p instanceof RegExp) return String(p);
  return String(p == null ? '' : p);
}

/**
 * Pure: the route a request matched, as Express declared it: the router's
 * base plus the route's path. `(unmatched)` when no route answered (a
 * middleware did, or nothing did). Never the raw path; a numeric or
 * uuid-like segment that reached the base from a mount path is written as
 * `:id` all the same.
 */
function routeTemplate(req) {
  const route = req && req.route;
  if (!route || route.path == null) return UNMATCHED;
  const base = req[ROUTE_BASE] != null ? req[ROUTE_BASE] : (req.baseUrl || '');
  const text = `${base}${routePathText(route.path)}`
    .replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{24,})(?=\/|$)/gi, '/:id');
  return text.slice(0, WIDTH.route) || UNMATCHED;
}

/** Pure: an HTTP method, as a column holds it. */
function methodOf(method) {
  return String(method || 'GET').toUpperCase().replace(/[^A-Z]/g, '').slice(0, WIDTH.method) || 'GET';
}

/**
 * Pure: an error's type: its constructor's name, and its code when it has a
 * short, typed one (`DatabaseError(42P01)`, `Error(ECONNREFUSED)`).
 */
function errorType(err) {
  if (!err || typeof err !== 'object') return '';
  const ctor = err.constructor && err.constructor !== Object ? err.constructor.name : '';
  const name = String(ctor || err.name || 'Error').replace(/[^A-Za-z0-9_$]/g, '').slice(0, 40) || 'Error';
  const code = err.code == null ? '' : String(err.code);
  const typed = /^[A-Za-z0-9_.-]{1,20}$/.test(code) ? code : '';
  return (typed ? `${name}(${typed})` : name).slice(0, WIDTH.errType);
}

/**
 * Pure: the first frame of `err`'s stack that is this repository's own
 * code, repo-relative (`src/routes/apps.js:120`), or ''. Only `at` lines
 * count, and the message is cut off first: a message can carry what a
 * person sent, newlines and all, and must not be able to name the frame.
 */
function firstFrame(err) {
  const stack = err && typeof err === 'object' ? String(err.stack || '') : '';
  if (!stack) return '';
  let body = stack;
  try {
    const head = String(err);
    if (head && body.startsWith(head)) body = body.slice(head.length);
  } catch { /* an error whose toString throws keeps its whole stack */ }
  const frames = body.split('\n')
    .filter((line) => /^\s*at\s/.test(line) && !/node_modules|node:internal/.test(line))
    .map((line) => line.split(ROOT).join(''))
    .join('\n');
  const frame = ownFrames(frames, 1)[0] || '';
  return /^(?:(?:src|worker|scripts|tools)\/[A-Za-z0-9_./-]+|server\.js):\d+$/.test(frame)
    ? frame.slice(0, WIDTH.frame)
    : '';
}

/** Pure: one message, as a row keeps it: scrubbed, on one line, capped. */
function sampleOf(message) {
  const s = scrubText(String(message == null ? '' : message)).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > SAMPLE_CHARS ? `${s.slice(0, SAMPLE_CHARS - 1)}…` : s;
}

/**
 * Pure: what middleware/error-handler.js leaves on res.locals for a 5xx it
 * answered: { errType, frame, message }. Never throws.
 */
function errorFacts(err) {
  try {
    return { errType: errorType(err), frame: firstFrame(err), message: err && err.message ? String(err.message) : '' };
  } catch {
    return { errType: '', frame: '', message: '' };
  }
}

// ── The counts ──────────────────────────────────────────────────────────

const errorKey = (e) => JSON.stringify([e.method, e.route, e.status, e.errType, e.frame]);
const routeKey = (r) => `${r.method} ${r.route}`;

function emptyMinute(minute) {
  return { minute, requests: 0, errors: 0, details: new Map(), dropped: 0, routes: new Map() };
}

function emptyRoute(method, route) {
  return { method, route, requests: 0, streams: 0, totalMs: 0, maxMs: 0, bytes: 0 };
}

/** Pure: `cost` added to the route row `into`. */
function addCost(into, cost) {
  into.requests += cost.requests || 0;
  into.streams += cost.streams || 0;
  into.totalMs += cost.totalMs || 0;
  into.maxMs = Math.max(into.maxMs, cost.maxMs || 0);
  into.bytes += cost.bytes || 0;
}

/** Pure: what one response cost: its time (not an event stream's) and its bytes. */
function costOf({ durationMs = null, bytes = null, stream = false } = {}) {
  const ms = !stream && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const sent = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
  return { requests: 1, streams: stream ? 1 : 0, totalMs: ms, maxMs: ms, bytes: sent };
}

/**
 * Pure: a minute's route rows as they are written: the `limit` costliest by
 * time (then bytes, then count) by name, and the rest folded into one
 * `(other)` row per method, so a minute writes a bounded number of rows.
 */
function costliestRoutes(routes, limit = ROUTE_ROWS) {
  const rows = [...routes.values()].map((r) => ({ ...r }));
  rows.sort((a, b) => (b.totalMs - a.totalMs) || (b.bytes - a.bytes) || (b.requests - a.requests)
    || (routeKey(a) < routeKey(b) ? -1 : 1));
  const kept = new Map();
  let names = 0;
  for (const r of rows) {
    const named = r.route !== OTHER && names < limit;
    if (named) {
      names += 1;
      kept.set(routeKey(r), r);
      continue;
    }
    const key = routeKey({ method: r.method, route: OTHER });
    const into = kept.get(key) || emptyRoute(r.method, OTHER);
    addCost(into, r);
    kept.set(key, into);
  }
  return [...kept.values()];
}

/**
 * One process's counts. The module's own instance is what the middleware
 * and the flush timer use; tests make their own.
 */
function createCounts({
  pod = podName(), maxErrorKeys = MAX_ERROR_KEYS, maxRouteKeys = MAX_ROUTE_KEYS, maxMinutes = MAX_MINUTES,
  routeRows = ROUTE_ROWS,
} = {}) {
  const minutes = new Map(); // minute (ms) → { minute, requests, errors, details, dropped, routes }

  function bucket(minute) {
    let b = minutes.get(minute);
    if (b) return b;
    // Held this many minutes already (the database has refused them): the
    // oldest goes, so memory stays bounded.
    while (minutes.size >= maxMinutes) {
      const oldest = Math.min(...minutes.keys());
      minutes.delete(oldest);
    }
    b = emptyMinute(minute);
    minutes.set(minute, b);
    return b;
  }

  function addDetail(b, entry, count, sample) {
    const key = errorKey(entry);
    const d = b.details.get(key);
    if (d) {
      d.count += count;
      if (!d.sample && sample) d.sample = sample;
      return;
    }
    if (b.details.size >= maxErrorKeys) { b.dropped += count; return; }
    b.details.set(key, { ...entry, count, sample: sample || null });
  }

  // Past MAX_ROUTE_KEYS distinct routes in a minute, a route counts in its
  // method's `(other)`.
  function addRoute(b, method, route, cost) {
    let r = b.routes.get(routeKey({ method, route }));
    if (!r && route !== OTHER && b.routes.size >= maxRouteKeys) return addRoute(b, method, OTHER, cost);
    if (!r) {
      r = emptyRoute(method, route);
      b.routes.set(routeKey(r), r);
    }
    addCost(r, cost);
    return undefined;
  }

  /**
   * One response that finished: its method, route template and status, and
   * for a 5xx what the error handler saw ({ errType, frame, message }, or
   * nothing when the route answered the 5xx itself). `api: false` for a
   * response outside /api/: it counts only in the route costs. What it cost
   * (`durationMs`, `bytes`, `stream`) is optional.
   */
  function record({
    method, route, status, error = null, now = Date.now(), api = true, durationMs = null, bytes = null, stream = false,
  } = {}) {
    const code = Number(status);
    const b = bucket(minuteOf(Number.isFinite(now) ? now : Date.now()));
    const m = methodOf(method);
    const r = String(route || UNMATCHED).slice(0, WIDTH.route);
    addRoute(b, m, api || r !== UNMATCHED ? r : NON_API, costOf({ durationMs, bytes, stream }));
    if (!api) return;
    b.requests += 1;
    if (!(code >= 500 && code <= 599)) return;
    b.errors += 1;
    const e = error && typeof error === 'object' ? error : {};
    addDetail(b, {
      method: m,
      route: r,
      status: code,
      errType: String(e.errType || '').slice(0, WIDTH.errType),
      frame: String(e.frame || '').slice(0, WIDTH.frame),
    }, 1, sampleOf(e.message));
  }

  // A flush the database refused: its minutes come back to be sent again,
  // less what the database already took.
  function putBack(taken, { requestsSent, routesSent = false }) {
    for (const t of taken) {
      const b = bucket(t.minute);
      if (!requestsSent) { b.requests += t.requests; b.errors += t.errors; }
      if (!routesSent) for (const r of t.routes.values()) addRoute(b, r.method, r.route, r);
      for (const d of t.details.values()) addDetail(b, d, d.count, d.sample);
      b.dropped += t.dropped;
    }
  }

  /**
   * Upsert every minute that has ended (all of them with `all`) and drop
   * them from memory; a minute the database refused stays for the next
   * flush. Never throws: resolves { minutes, routeRows, errorRows } sent.
   */
  async function flush(pool, opts = {}) {
    try {
      return await flushOnce(pool, opts);
    } catch (err) {
      log.warn('server-errors', 'Could not flush server error counts', { err: err.message });
      return { minutes: 0, routeRows: 0, errorRows: 0 };
    }
  }

  async function flushOnce(pool, { now = Date.now(), all = false } = {}) {
    const sent = { minutes: 0, routeRows: 0, errorRows: 0 };
    if (!pool) return sent;
    const current = minuteOf(now);
    const taken = [];
    for (const [minute, b] of minutes) {
      if (all || minute < current) { taken.push(b); minutes.delete(minute); }
    }
    // (A minute put back after its errors were refused has its totals and
    // routes sent already, and only its errors left to send.)
    const live = taken.filter((b) => b.requests || b.errors || b.details.size || b.routes.size);
    if (!live.length) return sent;
    const dropped = live.reduce((n, b) => n + b.dropped, 0);
    if (dropped) {
      log.warn('server-errors', 'More distinct server errors in a minute than are kept; the rest count only in the total', {
        dropped, cap: maxErrorKeys,
      });
      for (const b of live) b.dropped = 0;
    }
    const minuteIso = (ms) => new Date(ms).toISOString();
    const totals = live.filter((b) => b.requests || b.errors);
    if (totals.length) {
      try {
        await pool.query(REQUESTS_UPSERT_SQL, [
          totals.map((b) => minuteIso(b.minute)), pod,
          totals.map((b) => b.requests), totals.map((b) => b.errors),
        ]);
      } catch (err) {
        putBack(live, { requestsSent: false });
        log.warn('server-errors', 'Could not flush request counts; kept for the next flush', { err: err.message });
        return sent;
      }
      sent.minutes = totals.length;
    }
    const routes = [];
    for (const b of live) for (const r of costliestRoutes(b.routes, routeRows)) routes.push({ minute: b.minute, ...r });
    if (routes.length) {
      try {
        await pool.query(ROUTES_UPSERT_SQL, [
          routes.map((r) => minuteIso(r.minute)), pod,
          routes.map((r) => r.method), routes.map((r) => r.route), routes.map((r) => r.requests),
          routes.map((r) => r.streams), routes.map((r) => Math.round(r.totalMs * 1000) / 1000),
          routes.map((r) => Math.round(r.maxMs * 1000) / 1000), routes.map((r) => r.bytes),
        ]);
        sent.routeRows = routes.length;
      } catch (err) {
        putBack(live, { requestsSent: true });
        log.warn('server-errors', 'Could not flush route costs; kept for the next flush', { err: err.message });
        return sent;
      }
    }
    const rows = [];
    for (const b of live) for (const d of b.details.values()) rows.push({ minute: b.minute, ...d });
    if (!rows.length) return sent;
    try {
      await pool.query(ERRORS_UPSERT_SQL, [
        rows.map((r) => minuteIso(r.minute)), pod,
        rows.map((r) => r.method), rows.map((r) => r.route), rows.map((r) => r.status),
        rows.map((r) => r.errType), rows.map((r) => r.frame), rows.map((r) => r.count),
        rows.map((r) => r.sample),
      ]);
      sent.errorRows = rows.length;
    } catch (err) {
      putBack(live, { requestsSent: true, routesSent: true });
      log.warn('server-errors', 'Could not flush server errors; kept for the next flush', { err: err.message });
    }
    return sent;
  }

  /** What is held now, for tests: [{ minute, requests, errors, details: [...], dropped, routes: [...] }]. */
  function snapshot() {
    return [...minutes.values()]
      .sort((a, b) => a.minute - b.minute)
      .map((b) => ({
        minute: b.minute, requests: b.requests, errors: b.errors, dropped: b.dropped,
        details: [...b.details.values()].map((d) => ({ ...d })),
        routes: [...b.routes.values()].map((r) => ({ ...r })),
      }));
  }

  return { pod, record, flush, snapshot };
}

// ── The database ────────────────────────────────────────────────────────

// One statement per table, each row added to what another flush of the
// same minute already wrote (a minute put back after a refused flush, or a
// clock that stepped back).
const REQUESTS_UPSERT_SQL = `
  INSERT INTO server_request_minutes (minute, pod, requests, errors)
  SELECT t.minute, $2::text, t.requests, t.errors
    FROM unnest($1::timestamptz[], $3::int[], $4::int[]) AS t(minute, requests, errors)
  ON CONFLICT (minute, pod) DO UPDATE
     SET requests = server_request_minutes.requests + EXCLUDED.requests,
         errors = server_request_minutes.errors + EXCLUDED.errors`;

const ERRORS_UPSERT_SQL = `
  INSERT INTO server_error_minutes (minute, pod, method, route, status, err_type, frame, count, sample)
  SELECT t.minute, $2::text, t.method, t.route, t.status, t.err_type, t.frame, t.count, t.sample
    FROM unnest($1::timestamptz[], $3::text[], $4::text[], $5::smallint[], $6::text[], $7::text[],
                $8::int[], $9::text[]) AS t(minute, method, route, status, err_type, frame, count, sample)
  ON CONFLICT (minute, pod, method, route, status, err_type, frame) DO UPDATE
     SET count = server_error_minutes.count + EXCLUDED.count,
         sample = COALESCE(server_error_minutes.sample, EXCLUDED.sample)`;

const ROUTES_UPSERT_SQL = `
  INSERT INTO server_route_minutes (minute, pod, method, route, requests, streams, total_ms, max_ms, bytes)
  SELECT t.minute, $2::text, t.method, t.route, t.requests, t.streams, t.total_ms, t.max_ms, t.bytes
    FROM unnest($1::timestamptz[], $3::text[], $4::text[], $5::int[], $6::int[], $7::float8[],
                $8::float8[], $9::bigint[]) AS t(minute, method, route, requests, streams, total_ms, max_ms, bytes)
  ON CONFLICT (minute, pod, method, route) DO UPDATE
     SET requests = server_route_minutes.requests + EXCLUDED.requests,
         streams = server_route_minutes.streams + EXCLUDED.streams,
         total_ms = server_route_minutes.total_ms + EXCLUDED.total_ms,
         max_ms = GREATEST(server_route_minutes.max_ms, EXCLUDED.max_ms),
         bytes = server_route_minutes.bytes + EXCLUDED.bytes`;

const PRUNE_REQUESTS_SQL = 'DELETE FROM server_request_minutes WHERE minute < NOW() - make_interval(days => $1)';
const PRUNE_ERRORS_SQL = 'DELETE FROM server_error_minutes WHERE minute < NOW() - make_interval(days => $1)';
const PRUNE_ROUTES_SQL = 'DELETE FROM server_route_minutes WHERE minute < NOW() - make_interval(days => $1)';

/**
 * Remove rows older than RETENTION_DAYS, and route costs older than
 * ROUTE_RETENTION_DAYS (the leader, once a day). Never throws: resolves
 * { requests, errors, routes } removed, or null when it could not.
 */
async function prune(pool, { days = RETENTION_DAYS, routeDays = ROUTE_RETENTION_DAYS } = {}) {
  if (!pool) return null;
  try {
    const requests = await pool.query(PRUNE_REQUESTS_SQL, [days]);
    const errors = await pool.query(PRUNE_ERRORS_SQL, [days]);
    const routes = await pool.query(PRUNE_ROUTES_SQL, [routeDays]);
    return { requests: requests.rowCount || 0, errors: errors.rowCount || 0, routes: routes.rowCount || 0 };
  } catch (err) {
    log.warn('server-errors', 'Could not prune old server error counts', { err: err.message });
    return null;
  }
}

// ── This process ────────────────────────────────────────────────────────

const counts = createCounts();
let timer = null;
let flushing = null;

/**
 * Every process, at boot: flush this process's counts every 60 seconds, one
 * flush at a time. The timer is unref'd, so it never holds the process
 * open; a flush with nothing to send sends no query.
 */
function start({ pool, intervalMs = FLUSH_INTERVAL_MS } = {}) {
  if (timer || !pool) return;
  timer = setInterval(() => {
    if (flushing) return;
    flushing = counts.flush(pool).finally(() => { flushing = null; });
  }, intervalMs);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  // This process's counts.
  record: (entry) => counts.record(entry),
  flush: (pool, opts) => counts.flush(pool, opts),
  prune,
  start,
  stop,
  // Pure parts, and a fresh set of counts, for tests.
  createCounts,
  minuteOf,
  podName,
  routeTemplate,
  methodOf,
  errorType,
  firstFrame,
  sampleOf,
  errorFacts,
  costOf,
  costliestRoutes,
  ROUTE_BASE,
  UNMATCHED,
  NON_API,
  OTHER,
  REQUESTS_UPSERT_SQL,
  ROUTES_UPSERT_SQL,
  ERRORS_UPSERT_SQL,
  PRUNE_REQUESTS_SQL,
  PRUNE_ERRORS_SQL,
  PRUNE_ROUTES_SQL,
  FLUSH_INTERVAL_MS,
  RETENTION_DAYS,
  ROUTE_RETENTION_DAYS,
  MAX_ERROR_KEYS,
  MAX_ROUTE_KEYS,
  ROUTE_ROWS,
  MAX_MINUTES,
  SAMPLE_CHARS,
};

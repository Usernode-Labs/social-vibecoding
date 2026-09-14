'use strict';

/**
 * How much of the Postgres SERVER's connection budget is in use (#1771).
 *
 * Every pool in this codebase reports on itself — `status.js` has published
 * `pool.totalCount / idleCount / waitingCount` for a long time. Nothing has
 * ever read the number those are competing for. One Postgres container backs
 * the platform, every production app, and every staging preview, and its
 * `max_connections` is never set anywhere in the repo, so it is the stock
 * 100. A local pool reporting `total: 3, max: 60` looks healthy right up to
 * the moment the server refuses the fourth connection.
 *
 * That gap is half of what this issue is about. When the server ran out, the
 * preview's own queries threw, its API returned 500s, and the declared checks
 * recorded them as assertion failures on the proposal's diff — 65 of them
 * citing one endpoint. Nothing anywhere said "the database turned us away".
 *
 * The census is one cheap query against `pg_stat_activity`, surfaced on the
 * admin status screen next to the pool figures it has always shown, so the
 * fleet's arithmetic is visible before it stops working rather than after.
 */

const log = require('./../services/logger');

// 53300 too_many_connections — the server refused a new backend.
// 53400 configuration_limit_exceeded — the same wall from a different side.
const CONNECTION_LIMIT_CODES = new Set(['53300', '53400']);

// pg surfaces the SQLSTATE on `err.code` for a server-side refusal. The text
// fallback covers errors that arrive as plain strings from a driver layer
// that lost the field, which is exactly when a reader most needs the name.
const LIMIT_TEXT_RE = /too many clients already|remaining connection slots are reserved/i;

function isConnectionLimitError(err) {
  if (!err) return false;
  if (CONNECTION_LIMIT_CODES.has(String(err.code))) return true;
  return LIMIT_TEXT_RE.test(String(err.message || ''));
}

// The same wall seen from a LOG BLOB rather than from a thrown error.
//
// A staging preview that cannot get a connection does not hand the platform
// an Error object: it prints Postgres's complaint to stdout and exits, and
// all the checks pipeline ever holds is that text. Both halves of the wall
// appear there — the server's own refusal ("sorry, too many clients
// already"), and the per-database ceiling this issue adds ("too many
// connections for database"), which is the same event scoped to one
// preview. The bare SQLSTATE is matched too, for the driver layers that
// print the code and drop the sentence.
const LIMIT_LOG_RE = new RegExp([
  'sorry, too many clients already',
  'remaining connection slots are reserved',
  'too many connections for (database|role)',
  '\\b(53300|53400)\\b',
].join('|'), 'i');

// True when a log blob (container boot logs, stderr, a capture failure
// reason) shows the shared Postgres turning a connection away.
function mentionsConnectionLimit(text) {
  if (!text) return false;
  return LIMIT_LOG_RE.test(String(text));
}

// The one sentence every surface uses to say this. It lands in
// `chat_sessions.check_error_detail`, which the proposal card and the merge
// gate both render, so it is user-facing copy: no em dashes, and it leads
// with the thing the author most needs to know, which is that the diff is
// not the problem.
//
// `census` is optional — the numbers are the evidence when they are to
// hand, and the sentence has to work without them because a census cannot
// be taken on a server that is out of connections.
function connectionExhaustionMessage(census, { where = 'ran' } = {}) {
  const figures = census && census.max
    ? ` (${census.used} of ${census.max} server connections in use)`
    : '';
  return `Infrastructure problem, not this change: the shared Postgres server `
    + `ran out of connections${figures} while the preview ${where || 'ran'}. `
    + `Checks retry automatically once the fleet frees connections.`;
}

// At or above this share of max_connections, the server is one burst away
// from refusing work. A single check run opens up to `concurrency` (8)
// connections against one preview, so the last tenth is not headroom.
const SATURATION_RATIO = 0.9;

function isSaturated(census) {
  return !!(census && census.max > 0 && census.used / census.max >= SATURATION_RATIO);
}

/**
 * `{ max, used, idle, free, saturated, topDatabases }`, or null when the
 * census itself cannot run.
 *
 * Deliberately best-effort and non-throwing: every caller is a diagnostic on
 * a path that must not acquire a new failure mode. A census that cannot be
 * taken because the server is out of connections is itself the answer, and
 * the caller says so from the fact that it got null.
 */
async function connectionCensus(pool, { topN = 5 } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT current_setting('max_connections')::int AS max,
              count(*)::int AS used,
              count(*) FILTER (WHERE state = 'idle')::int AS idle
         FROM pg_stat_activity
        WHERE backend_type = 'client backend'`
    );
    const head = rows[0] || {};
    const max = Number(head.max) || 0;
    const used = Number(head.used) || 0;
    const census = {
      max,
      used,
      idle: Number(head.idle) || 0,
      free: Math.max(0, max - used),
      saturated: false,
      topDatabases: [],
    };
    census.saturated = isSaturated(census);
    // Which databases are holding them. This is the line that names the
    // culprit: a row per preview clone, biggest first.
    const { rows: byDb } = await pool.query(
      `SELECT datname, count(*)::int AS count
         FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND datname IS NOT NULL
        GROUP BY datname
        ORDER BY count DESC
        LIMIT $1`,
      [Math.max(1, Math.min(20, topN))]
    );
    census.topDatabases = byDb.map((r) => ({ name: r.datname, count: Number(r.count) || 0 }));
    return census;
  } catch (err) {
    log.warn('db', 'Connection census failed', {
      err: err.message,
      atLimit: isConnectionLimitError(err) || undefined,
    });
    return null;
  }
}

module.exports = {
  CONNECTION_LIMIT_CODES,
  SATURATION_RATIO,
  isConnectionLimitError,
  mentionsConnectionLimit,
  connectionExhaustionMessage,
  isSaturated,
  connectionCensus,
};

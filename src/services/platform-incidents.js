'use strict';

// Errors that should not happen, kept where admins see them (#4210). A bot
// build a restart or a lost worker cut short is picked up again on its own,
// and its person is not told when it carries on from its plan, so without a
// record here nobody would know how often it happens. Each incident is one
// `events` row (event_type 'platform_incident', its kind in the metadata),
// listed in the Homeroom bot console's Rollout health panel (recent).
// Written by the platform, never from what a person typed: `why` is one of
// the platform's own reasons ("the worker is gone"), so the rows hold
// nothing private.

const events = require('./events');
const log = require('./logger');
const { withTransaction } = require('./cli-auth');

const TYPE = events.EVENT_TYPES.PLATFORM_INCIDENT;

const KINDS = Object.freeze({
  BUILD_INTERRUPTED: 'build_interrupted',
});

// The kind as the page and the alerts say it (admin-incidents.tsx keeps the
// same words — it imports its own copy, so the two cannot share a module).
// A kind recorded but missing here still lists, under its raw value.
const LABELS = Object.freeze({
  [KINDS.BUILD_INTERRUPTED]: 'Build interrupted',
});

// The burst alert's noun, said the way the threshold reads ("3 builds
// interrupted in the last hour"). A kind without an entry falls back to
// "N unexpected errors (<kind>) in the last hour".
const BURST_NOUNS = Object.freeze({
  [KINDS.BUILD_INTERRUPTED]: 'builds interrupted',
});

// One kind reaching this many incidents inside BURST_WINDOW_HOURS pages the
// full admins straight away, once per window (see checkBurst). Tunable per
// kind in one place: add an entry to BURST_THRESHOLDS.
const BURST_THRESHOLD_DEFAULT = 3;
const BURST_THRESHOLDS = Object.freeze({});
const BURST_WINDOW_HOURS = 1;

// The daily summary goes out once, in this UTC hour (see digest). Off-peak
// for most people; skipped entirely if the leader is down for the whole hour.
const DIGEST_HOUR_UTC = 9;
// How often the leader's sweeper looks for the digest hour.
const DIGEST_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// The page's time ranges, and the default. Days are UTC days throughout.
const RANGES = Object.freeze([1, 7, 30]);
const LIST_DAYS = 7;
const LIST_LIMIT = 100;

// How far back the console looks, and how many it lists.
const RECENT_DAYS = 7;
const RECENT_LIMIT = 20;

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// Read at call time so tests can swap either without a database.
function defaultCreate(db, args) {
  return require('./notifications').createPlatformIncidentNotifications(db, args);
}
function defaultPublish(pool, row) {
  return require('./notifications').hydrateAndPush(pool, row);
}

// The page's day filter, clamped to the ranges it offers. A value the page
// cannot send (absent, a hand-typed query string) is the default.
function clampDays(days) {
  const n = Number(days);
  return RANGES.includes(n) ? n : LIST_DAYS;
}

/** One incident row, sanitised, as both readers return it. */
function toItem(row) {
  const m = row.metadata || {};
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    kind: String(m.kind || 'unknown'),
    app: row.app_slug || null,
    sessionId: num(row.session_id),
    runId: num(m.runId),
    issueNumber: num(m.issueNumber),
    why: m.why ? String(m.why).slice(0, 300) : null,
    outcome: m.outcome ? String(m.outcome) : null,
  };
}

/** Record one incident. Never throws; resolves when it is written (or skipped). */
function record(pool, { kind, appId = null, sessionId = null, detail = {} } = {}) {
  if (!kind) return Promise.resolve();
  const written = events.record(pool, {
    type: TYPE,
    appId: appId == null ? null : Number(appId),
    sessionId: sessionId == null ? null : Number(sessionId),
    metadata: { ...detail, kind },
  });
  // After the row is in, look for a burst — never in the caller's way: a
  // failed check costs the alert, not the incident, and resolving record()
  // does not wait for it.
  Promise.resolve(written)
    .then(() => checkBurst(pool, kind))
    .catch((err) => {
      log.warn('platform-incidents', 'Burst check failed', { kind, err: err.message });
    });
  return written;
}

/**
 * Count one kind in the burst window. Kept as its own query so the burst
 * check can recount inside its transaction, under the advisory lock.
 */
const BURST_COUNT_SQL = `SELECT COUNT(*)::int AS n FROM events
  WHERE event_type = $1 AND created_at > NOW() - make_interval(hours => $2)
    AND metadata->>'kind' = $3`;

/**
 * The threshold alert: one kind reaching its count inside the window pages
 * the full admins once per window. Runs in a transaction under an advisory
 * lock on the token prefix, so two processes recording at once cannot both
 * send, and dedupes on any platform_incident notification for the same kind
 * inside the window, read or not. deps.create / deps.publish / deps.staging
 * are injectable, as platform-limit-alerts does.
 */
async function checkBurst(pool, kind, deps = {}) {
  if (!kind || !LABELS[kind]) return { sent: false, reason: 'kind' };
  const create = deps.create || defaultCreate;
  const publish = deps.publish || defaultPublish;
  const staging = deps.staging ?? isStaging();
  const threshold = BURST_THRESHOLDS[kind] ?? BURST_THRESHOLD_DEFAULT;
  const prefix = `burst:${kind}`;

  const outcome = await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`platform_incident:${prefix}`]);
    const { rows: [count] = [] } = await db.query(BURST_COUNT_SQL, [TYPE, BURST_WINDOW_HOURS, kind]);
    const n = Number(count?.n) || 0;
    if (n < threshold) return { n, sent: false, reason: 'below' };
    // A preview's users table is a clone of production's, so a notification
    // there would reach real admins' phones about a throwaway copy — the
    // staging check outranks the window's de-dupe.
    if (staging) return { n, sent: false, reason: 'staging' };
    // notifications.detail is varchar(32): "burst:" + 20 + ":" + 4 fits.
    const token = `${prefix}:${Math.min(n, 9999)}`;
    const { rows: dup } = await db.query(
      `SELECT 1 FROM notifications
        WHERE kind = $1 AND split_part(detail, ':', 1) = 'burst'
          AND split_part(detail, ':', 2) = $2
          AND created_at > NOW() - make_interval(hours => $3)
        LIMIT 1`,
      ['platform_incident', kind, BURST_WINDOW_HOURS],
    );
    if (dup.length) return { n, sent: false, reason: 'dedupe' };
    const inserted = await create(db, { detail: token });
    return { n, sent: true, token, inserted };
  });

  if (outcome.sent) {
    log.warn('platform-incidents', 'Burst threshold reached', {
      kind, count: outcome.n, threshold, recipients: (outcome.inserted || []).length, staging,
    });
  }
  for (const row of outcome.inserted || []) {
    await Promise.resolve(publish(pool, row)).catch(() => {});
  }
  return { sent: outcome.sent, count: outcome.n, reason: outcome.reason };
}

/**
 * The daily summary, evaluated by the leader's sweeper (server.js). In the
 * digest hour and only then: when the past 24 hours logged at least one
 * incident, every full admin gets one notification for the day, never a
 * second. A quiet day, a staging host, or a leader down for the whole hour
 * sends nothing (no catch-up).
 */
async function digest(pool, { now = new Date() } = {}, deps = {}) {
  const create = deps.create || defaultCreate;
  const publish = deps.publish || defaultPublish;
  const staging = deps.staging ?? isStaging();
  if (now.getUTCHours() !== DIGEST_HOUR_UTC) return { sent: false, reason: 'hour' };
  const day = now.toISOString().slice(0, 10);

  const outcome = await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['platform_incident:digest']);
    const { rows: [count] = [] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE event_type = $1 AND created_at > NOW() - interval '24 hours'`,
      [TYPE],
    );
    const total = Number(count?.n) || 0;
    if (!total) return { total, sent: false, reason: 'quiet' };
    const { rows: dup } = await db.query(
      `SELECT 1 FROM notifications WHERE kind = $1 AND detail LIKE $2 LIMIT 1`,
      ['platform_incident', `digest:${day}:%`],
    );
    if (dup.length) return { total, sent: false, reason: 'dedupe' };
    if (staging) return { total, sent: false, reason: 'staging' };
    // notifications.detail is varchar(32), so the token carries only the
    // day and the total; the reader names the kind from its own kind list
    // while there is exactly one of them.
    const token = `digest:${day}:${Math.min(total, 9999)}`;
    const inserted = await create(db, { detail: token });
    return { total, sent: true, token, inserted };
  });

  if (outcome.sent) {
    log.info('platform-incidents', 'Daily digest sent', {
      day, total: outcome.total, recipients: (outcome.inserted || []).length, staging,
    });
  }
  for (const row of outcome.inserted || []) {
    await Promise.resolve(publish(pool, row)).catch(() => {});
  }
  return { sent: outcome.sent, total: outcome.total, reason: outcome.reason };
}

/**
 * The admin page's data: the incidents in a kind and day filter — items,
 * counts per kind per UTC day, per-kind totals — or null when they cannot
 * be read. The kind filter applies to everything; an unknown kind means
 * all kinds.
 */
async function list(pool, { kind, days, limit = LIST_LIMIT } = {}) {
  try {
    const nDays = clampDays(days);
    const k = kind && LABELS[kind] ? kind : null;
    const effLimit = Math.max(1, Math.min(Number(limit) || LIST_LIMIT, 500));
    const where = ['e.event_type = $1', 'e.created_at > NOW() - make_interval(days => $2)'];
    const params = [TYPE, nDays];
    if (k) {
      params.push(k);
      where.push(`e.metadata->>'kind' = $${params.length}`);
    }
    const cond = where.join(' AND ');
    const [{ rows }, { rows: dailyRows }, { rows: kindRows }, { rows: [count] = [] }] = await Promise.all([
      pool.query(
        `SELECT e.created_at, e.metadata, e.session_id, a.slug AS app_slug
           FROM events e LEFT JOIN apps a ON a.id = e.app_id
          WHERE ${cond}
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $${params.length + 1}`,
        [...params, effLimit],
      ),
      pool.query(
        `SELECT (e.created_at AT TIME ZONE 'UTC')::date::text AS day,
                e.metadata->>'kind' AS kind, COUNT(*)::int AS n
           FROM events e
          WHERE ${cond}
          GROUP BY 1, 2
          ORDER BY day DESC`,
        params,
      ),
      pool.query(
        `SELECT e.metadata->>'kind' AS kind, COUNT(*)::int AS n
           FROM events e
          WHERE ${cond}
          GROUP BY 1
          ORDER BY n DESC, kind`,
        params,
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM events e WHERE ${cond}`, params),
    ]);

    // Every known kind first (so the filter's options never depend on what
    // has been recorded), then anything else the range saw, under its raw
    // value.
    const nByKind = new Map(kindRows.map((r) => [String(r.kind), Number(r.n) || 0]));
    const seen = new Set();
    const kinds = [];
    for (const key of Object.keys(LABELS)) {
      kinds.push({ kind: key, label: LABELS[key], n: nByKind.get(key) || 0 });
      seen.add(key);
    }
    for (const [key, n] of nByKind) {
      if (!seen.has(key)) kinds.push({ kind: key, label: key, n });
    }

    const daily = [];
    let current = null;
    for (const r of dailyRows) {
      const day = String(r.day);
      if (!current || current.day !== day) {
        current = { day, counts: {}, total: 0 };
        daily.push(current);
      }
      const kindName = String(r.kind || 'unknown');
      current.counts[kindName] = (current.counts[kindName] || 0) + (Number(r.n) || 0);
      current.total += Number(r.n) || 0;
    }

    return {
      days: nDays,
      kind: k,
      limit: effLimit,
      kinds,
      daily,
      total: Number(count?.n) || rows.length,
      items: rows.map(toItem),
    };
  } catch (err) {
    log.warn('platform-incidents', 'Could not read incidents', { err: err.message });
    return null;
  }
}

/**
 * How many times a build of this run was interrupted and carried on from its
 * plan (outcome 'resumed') in the last `hours`. A resume keeps its run, so
 * the count of runs sent back (homeroom-bot.js restartedBuildsBefore) does
 * not see them. 0 when it cannot be read.
 */
async function resumesOfRun(pool, runId, { hours = 24 } = {}) {
  try {
    const { rows: [row] = [] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE event_type = $1 AND created_at > NOW() - make_interval(hours => $2)
          AND metadata->>'kind' = $3 AND metadata->>'runId' = $4 AND metadata->>'outcome' = 'resumed'`,
      [TYPE, hours, KINDS.BUILD_INTERRUPTED, String(Number(runId))],
    );
    return Number(row?.n) || 0;
  } catch (err) {
    log.warn('platform-incidents', 'Could not count a run\'s resumed builds', { runId, err: err.message });
    return 0;
  }
}

/**
 * The latest incidents, newest first, for the admin console:
 * { days, total, items: [{ at, kind, app, runId, issueNumber, why, outcome }] }.
 * Null when they cannot be read.
 */
async function recent(pool, { days = RECENT_DAYS, limit = RECENT_LIMIT } = {}) {
  try {
    const [{ rows }, { rows: [count] = [] }] = await Promise.all([
      pool.query(
        `SELECT e.created_at, e.metadata, a.slug AS app_slug
           FROM events e LEFT JOIN apps a ON a.id = e.app_id
          WHERE e.event_type = $1 AND e.created_at > NOW() - make_interval(days => $2)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $3`,
        [TYPE, days, limit],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM events
          WHERE event_type = $1 AND created_at > NOW() - make_interval(days => $2)`,
        [TYPE, days],
      ),
    ]);
    return {
      days,
      total: Number(count?.n) || rows.length,
      items: rows.map(toItem),
    };
  } catch (err) {
    log.warn('platform-incidents', 'Could not read recent incidents', { err: err.message });
    return null;
  }
}

module.exports = {
  KINDS,
  LABELS,
  BURST_NOUNS,
  BURST_THRESHOLD_DEFAULT,
  BURST_THRESHOLDS,
  BURST_WINDOW_HOURS,
  DIGEST_HOUR_UTC,
  DIGEST_SWEEP_INTERVAL_MS,
  RANGES,
  RECENT_DAYS,
  clampDays,
  record,
  checkBurst,
  digest,
  list,
  resumesOfRun,
  recent,
};

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

const TYPE = events.EVENT_TYPES.PLATFORM_INCIDENT;

const KINDS = Object.freeze({
  BUILD_INTERRUPTED: 'build_interrupted',
});

// How far back the console looks, and how many it lists.
const RECENT_DAYS = 7;
const RECENT_LIMIT = 20;

/**
 * Record one incident. Never throws; resolves when it is written (or
 * skipped). After the write succeeds it chains a best-effort threshold
 * check (platform-incident-alerts.js): a lazy require, every error caught
 * and logged, so a fake pool in a test that answers only the insert cannot
 * break the callers, and a burst of incidents cannot break a build.
 */
function record(pool, { kind, appId = null, sessionId = null, detail = {} } = {}) {
  if (!kind) return Promise.resolve();
  return events.record(pool, {
    type: TYPE,
    appId: appId == null ? null : Number(appId),
    sessionId: sessionId == null ? null : Number(sessionId),
    metadata: { ...detail, kind },
  }).then(() => {
    try {
      return require('./platform-incident-alerts').checkThreshold(pool, kind);
    } catch (err) {
      log.warn('platform-incidents', 'Threshold check could not start', { kind, err: err.message });
    }
  }).catch((err) => {
    log.warn('platform-incidents', 'Could not record an incident or run its check', { kind, err: err.message });
  });
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
 * How many incidents of one kind the last `hours` hold. The threshold
 * alert (platform-incident-alerts.js) reads this; it rides
 * idx_events_type_created, so no new index.
 * 0 when it cannot be read.
 */
async function countRecent(pool, kind, { hours = 1 } = {}) {
  try {
    const { rows: [row] = [] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE event_type = $1 AND created_at > NOW() - make_interval(hours => $2)
          AND metadata->>'kind' = $3`,
      [TYPE, hours, String(kind)],
    );
    return Number(row?.n) || 0;
  } catch (err) {
    log.warn('platform-incidents', 'Could not count recent incidents', { kind, err: err.message });
    return 0;
  }
}

/**
 * Counts per kind per UTC day, for the counts table on the admin's
 * Unexpected errors section: { <kind>: { 'YYYY-MM-DD': n } }, plus
 * `days` and the `kind` filter it was read under (null = all kinds).
 * Null when they cannot be read.
 */
async function countsByKindByDay(pool, { days = 7, kind = null } = {}) {
  try {
    const clauses = ['e.event_type = $1', 'e.created_at > NOW() - make_interval(days => $2)'];
    const args = [TYPE, days];
    if (kind) {
      args.push(String(kind));
      clauses.push(`e.metadata->>'kind' = $${args.length}`);
    }
    const { rows } = await pool.query(
      `SELECT e.metadata->>'kind' AS kind,
              to_char(date_trunc('day', e.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS n
         FROM events e
        WHERE ${clauses.join(' AND ')}
        GROUP BY 1, 2`,
      args,
    );
    const byKind = {};
    for (const r of rows) {
      const k = String(r.kind || 'unknown');
      (byKind[k] = byKind[k] || {})[String(r.day)] = Number(r.n) || 0;
    }
    return { days, kind: kind || null, byKind };
  } catch (err) {
    log.warn('platform-incidents', 'Could not count incidents by kind by day', { err: err.message });
    return null;
  }
}

/**
 * A filtered log for the admin's Unexpected errors section, newest first:
 * { days, kind, total, items: [{ at, kind, app, sessionId, runId,
 * issueNumber, why, outcome }] }. `kind` null lists every kind. The items
 * carry sessionId (events.session_id) so the app cell can link to the
 * change the incident belongs to. Null when they cannot be read.
 */
async function query(pool, { kind = null, days = 30, limit = 200 } = {}) {
  try {
    const clauses = ['e.event_type = $1', 'e.created_at > NOW() - make_interval(days => $2)'];
    const args = [TYPE, days];
    if (kind) {
      args.push(String(kind));
      clauses.push(`e.metadata->>'kind' = $${args.length}`);
    }
    const where = clauses.join(' AND ');
    const [{ rows }, { rows: [count] = [] }] = await Promise.all([
      pool.query(
        `SELECT e.created_at, e.session_id, e.metadata, a.slug AS app_slug
           FROM events e LEFT JOIN apps a ON a.id = e.app_id
          WHERE ${where}
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $${args.length + 1}`,
        [...args, limit],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM events e WHERE ${where}`,
        args,
      ),
    ]);
    return {
      days,
      kind: kind || null,
      total: Number(count?.n) || rows.length,
      items: rows.map((r) => {
        const m = r.metadata || {};
        return {
          at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          kind: String(m.kind || 'unknown'),
          app: r.app_slug || null,
          sessionId: Number.isFinite(Number(r.session_id)) && r.session_id != null ? Number(r.session_id) : null,
          runId: Number.isFinite(Number(m.runId)) && m.runId != null ? Number(m.runId) : null,
          issueNumber: Number.isFinite(Number(m.issueNumber)) && m.issueNumber != null ? Number(m.issueNumber) : null,
          why: m.why ? String(m.why).slice(0, 300) : null,
          outcome: m.outcome ? String(m.outcome) : null,
        };
      }),
    };
  } catch (err) {
    log.warn('platform-incidents', 'Could not read incidents', { err: err.message });
    return null;
  }
}

/**
 * The latest incidents, newest first, for the bot dashboard's Rollout
 * health panel: { days, total, items: [{ at, kind, app, runId,
 * issueNumber, why, outcome }] }. Null when they cannot be read.
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
      items: rows.map((r) => {
        const m = r.metadata || {};
        return {
          at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          kind: String(m.kind || 'unknown'),
          app: r.app_slug || null,
          runId: Number.isFinite(Number(m.runId)) && m.runId != null ? Number(m.runId) : null,
          issueNumber: Number.isFinite(Number(m.issueNumber)) && m.issueNumber != null ? Number(m.issueNumber) : null,
          why: m.why ? String(m.why).slice(0, 300) : null,
          outcome: m.outcome ? String(m.outcome) : null,
        };
      }),
    };
  } catch (err) {
    log.warn('platform-incidents', 'Could not read recent incidents', { err: err.message });
    return null;
  }
}

module.exports = {
  KINDS, RECENT_DAYS, record, resumesOfRun, recent,
  query, countsByKindByDay, countRecent,
};

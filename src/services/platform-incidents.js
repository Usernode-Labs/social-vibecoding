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

/** Record one incident. Never throws; resolves when it is written (or skipped). */
function record(pool, { kind, appId = null, sessionId = null, detail = {} } = {}) {
  if (!kind) return Promise.resolve();
  return events.record(pool, {
    type: TYPE,
    appId: appId == null ? null : Number(appId),
    sessionId: sessionId == null ? null : Number(sessionId),
    metadata: { ...detail, kind },
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

module.exports = { KINDS, RECENT_DAYS, record, resumesOfRun, recent };

'use strict';

// Alerts for the errors that should not happen (services/platform-incidents.js).
//
// Two bells, neither of them a ping per event — a build interruption rides
// every deploy, so pinging on the write would page admins on every rollout:
//
//   threshold  one kind crossing its line inside an hour alerts right away
//              ("Build interrupted 3 times in an hour"). While a full admin
//              still holds an unread alert for that kind, no second one is
//              sent: the unread de-dupe inside the INSERT collapses a burst
//              (and two Pods racing the same burst) to one row per admin.
//   digest     one bell a day, shortly after DIGEST_HOUR_UTC, when at least
//              one incident was logged since the previous digest. A quiet
//              day sends nothing at all. Taken under
//              PLATFORM_INCIDENT_DIGEST_LOCK so one instance sends it and
//              the others skip the hour (vote-digest.js's rule: a digest
//              sent twice is worse than one sent late).
//
// Recipients are the full admins, the audience platform_limit uses
// (is_admin AND NOT admin_readonly); view-only admins read the section but
// receive no rows. The threshold alert also pushes to the phone; the digest
// is bell-only — which is why only 'platform_incident' is registered as a
// push kind (schema.sql, mobile-push-preferences.js) and the digest kind
// deliberately is not.
//
// Evaluated two ways: right after an incident is written (the chain inside
// platform-incidents.record(), which is what catches a burst inside the
// hour), and the hourly sweep here, which is the digest's only clock and
// re-runs the threshold check as a backstop for a check a restart lost.

const log = require('./logger');
const { PLATFORM_INCIDENT_DIGEST_LOCK } = require('./advisory-locks');

// Incidents of one kind inside WINDOW_HOURS that alert right away. One map,
// so a later kind can carry its own line (THRESHOLD_DEFAULT until it does).
const THRESHOLD_DEFAULT = 3;
const THRESHOLDS = Object.freeze({ build_interrupted: 3 });
const WINDOW_HOURS = 1;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;
// The digest's hour, UTC: shortly after 06:00 the server is quietest.
const DIGEST_HOUR_UTC = 6;
// And this gap keeps a restart just before the hour from sending twice.
const DIGEST_MIN_GAP_HOURS = 20;

// The threshold the kind answers with.
function thresholdFor(kind) {
  const n = THRESHOLDS[String(kind)];
  return Number.isFinite(n) && n > 0 ? n : THRESHOLD_DEFAULT;
}

// Resolved at call time so tests can swap either, and so this module stays
// requireable from platform-incidents.js's record() chain without dragging
// the notification stack into every context that merely counts incidents.
function defaultCreateAlerts(db, args) {
  return require('./notifications').createPlatformIncidentAlertNotifications(db, args);
}
function defaultCreateDigest(db, args) {
  return require('./notifications').createPlatformIncidentDigestNotifications(db, args);
}
function defaultPublish(pool, row) {
  return require('./notifications').hydrateAndPush(pool, row);
}

/**
 * Alert when `kind` has crossed its line in the window. Never throws: the
 * caller's write already succeeded, so every failure is logged at warn and
 * reported as "not triggered".
 *
 * deps.create overrides createPlatformIncidentAlertNotifications
 * deps.publish overrides notifications.hydrateAndPush
 */
async function checkThreshold(pool, kind, deps = {}) {
  const out = { kind, triggered: false, count: 0, recipients: 0 };
  try {
    const incidents = require('./platform-incidents');
    const count = await incidents.countRecent(pool, kind, { hours: WINDOW_HOURS });
    out.count = count;
    if (!Number.isFinite(count) || count < thresholdFor(kind)) return out;

    const create = deps.create || defaultCreateAlerts;
    const publish = deps.publish || defaultPublish;
    // detail token "<kind>:<count>", read back by the push copy and the
    // bell's row renderer; both creators keep to varchar(32).
    const rows = await create(pool, { kind, count });
    out.triggered = rows.length > 0;
    out.recipients = rows.length;
    for (const row of rows) {
      await Promise.resolve(publish(pool, row)).catch(() => {});
    }
    if (out.triggered) {
      log.warn('platform-incidents', 'Unexpected-error threshold crossed', { kind, count, recipients: rows.length });
    }
  } catch (err) {
    log.warn('platform-incidents', 'Threshold check failed', { kind, err: err.message });
  }
  return out;
}

/**
 * The hourly sweep. Under the digest lock (so one instance sends it and the
 * rest skip the hour), it runs the threshold check for every known kind and
 * then decides the digest. Returns what it did, so a test can drive it
 * directly without waiting on the interval.
 *
 * deps.createAlerts / deps.createDigest / deps.publish — test overrides.
 * deps.staging — the preview rule (platform-limit-alerts.js): a preview's
 * users are a production clone, so it records and notifies nobody. The
 * threshold check keeps its own silent-to-nobody behaviour there; the
 * digest is skipped outright.
 */
async function sweep(pool, now = new Date(), deps = {}) {
  const result = { thresholdChecks: [], digest: null, busy: false };
  const client = await pool.connect();
  let locked = false;
  try {
    // Every instance runs this interval. A digest sent twice is worse than
    // one sent late, so an instance that cannot take the lock skips the
    // hour rather than waiting for it. Held for the whole sweep: the
    // threshold checks re-run behind it harmlessly (their unread de-dupe
    // collapses them anyway), but the digest decision must not race itself.
    const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [PLATFORM_INCIDENT_DIGEST_LOCK, 0]);
    if (lock.rows[0]?.acquired !== true) {
      result.busy = true;
      return result;
    }
    locked = true;

    const incidents = require('./platform-incidents');
    for (const kind of Object.values(incidents.KINDS)) {
      result.thresholdChecks.push(await checkThreshold(pool, kind, deps));
    }
    result.digest = await sweepDigest(pool, now, deps);
    return result;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [PLATFORM_INCIDENT_DIGEST_LOCK, 0]).catch(() => {});
    }
    client.release();
  }
}

/**
 * One sweep of the daily digest. Due only when all three hold: the hour has
 * come (UTC), the last digest is older than DIGEST_MIN_GAP_HOURS, and at
 * least one incident was logged since that digest (or since the same hour
 * the previous day when no digest row exists yet, so the first run covers
 * its own day rather than the table's whole history). Returns
 * { due, sent, count, skipped } — `skipped` names the condition that did
 * not hold.
 */
async function sweepDigest(pool, now = new Date(), deps = {}) {
  const out = { due: false, sent: 0, count: 0, skipped: null };
  try {
    if (deps.staging ?? (process.env.USERNODE_ENV === 'staging')) {
      out.skipped = 'staging';
      return out;
    }
    if (now.getUTCHours() < DIGEST_HOUR_UTC) {
      out.skipped = 'hour';
      return out;
    }
    const { rows: [last] = [] } = await pool.query(
      `SELECT id, created_at FROM notifications
        WHERE kind = 'platform_incident_digest'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const lastAt = last?.created_at ? new Date(last.created_at) : null;
    if (lastAt && !Number.isNaN(lastAt.getTime())
      && (now.getTime() - lastAt.getTime()) < DIGEST_MIN_GAP_HOURS * 60 * 60 * 1000) {
      out.skipped = 'recent';
      return out;
    }
    // Everything after the previous digest — or the last 24h when there has
    // never been one.
    const since = lastAt && !Number.isNaN(lastAt.getTime())
      ? lastAt
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const { rows: [countRow] = [] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE event_type = $1 AND created_at > $2`,
      [require('./events').EVENT_TYPES.PLATFORM_INCIDENT, since.toISOString()],
    );
    const count = Number(countRow?.n) || 0;
    if (!count) {
      out.skipped = 'quiet';
      return out;
    }
    const create = deps.createDigest || defaultCreateDigest;
    const publish = deps.publish || defaultPublish;
    const rows = await create(pool, { count });
    out.due = true;
    out.sent = rows.length;
    out.count = count;
    for (const row of rows) {
      // The digest stays in the bell: rows are never pushed to the phone.
      await Promise.resolve(publish(pool, row)).catch(() => {});
    }
    log.info('platform-incidents', 'Digest sent', { count, recipients: rows.length });
  } catch (err) {
    log.warn('platform-incidents', 'Digest sweep failed', { err: err.message });
  }
  return out;
}

function start(config) {
  if (timer) return;
  const { getPool } = require('../db/pool');
  const run = async () => {
    try {
      const result = await sweep(getPool(config));
      if (result.digest?.sent) log.info('platform-incidents', 'Sweep finished', result);
    } catch (err) {
      log.error('platform-incidents', 'Sweep failed', { err: err.message });
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS).unref?.();
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

let timer = null;

module.exports = {
  checkThreshold,
  sweep,
  sweepDigest,
  start,
  stop,
  thresholdFor,
  THRESHOLD_DEFAULT,
  THRESHOLDS,
  WINDOW_HOURS,
  SWEEP_INTERVAL_MS,
  DIGEST_HOUR_UTC,
  DIGEST_MIN_GAP_HOURS,
};
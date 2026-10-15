'use strict';

// Tell the full admins about errors that should not happen (#4296), without
// paging them on every deploy.
//
// services/platform-incidents.js records each incident as an `events` row
// (event_type 'platform_incident', its kind in the metadata). A ping per
// incident would fire on every deploy that interrupts a few bot builds, so
// this sends two things instead, both as the admin notification kind
// 'platform_incident' (beside 'platform_limit', in the same App alerts push
// category, so the same switch silences both):
//
//   digest  once a UTC day, from DIGEST_HOUR_UTC on, the previous UTC day's
//           incidents counted per kind. Nothing is sent for a day that had
//           none. "Once a day" is "no digest notification yet today" per
//           admin, so a restart or a second sweep cannot send it twice.
//   hour    straight away, when one kind reaches HOURLY_THRESHOLD incidents
//           in the last hour, and at most once per kind per hour: an admin
//           who had an hour alert for that kind in the last hour gets no
//           second one, read or not.
//
// Full admins only (is_admin AND NOT admin_readonly), like platform_limit:
// the section is readable by view-only admins, but the page goes to the
// people who can act. No app: an incident list belongs to the server.
//
// notifications.detail tokens (the drawer and the push copy parse them back):
//
//   "digest:<total>:<kind>=<n>,<kind>=<n>"   as many kinds as fit in 32
//                                            characters, most first; the
//                                            copy says how many more
//   "hour:<kind>:<n>"
//
// The decisions are pure (digestToken, hourAlerts, digestDue) so
// tests/platform-incident-alerts.test.js pins them without a database. The
// leader's sweep (server.js, startPlatformIncidentAlertSweeper) runs them
// every SWEEP_INTERVAL_MS, the same timer pattern the platform limit sweep
// uses.
//
// STAGING: a preview's users table is a clone of production's, so nothing
// is sent there (same stance as platform-limit-alerts.js).

const log = require('./logger');
const { withTransaction } = require('./cli-auth');
const incidents = require('./platform-incidents');

// One kind this many times within an hour is an alert of its own.
const HOURLY_THRESHOLD = 5;
// The digest goes out from this UTC hour (15:00 UTC is 8am in California).
const DIGEST_HOUR_UTC = 15;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DETAIL_MAX = 32;
const MAX_FIGURE = 99999;
const KIND_RE = /^[a-z][a-z0-9_]{0,23}$/;

function figure(n) {
  return Math.min(MAX_FIGURE, Math.max(0, Math.floor(Number(n) || 0)));
}

function startOfUtcDay(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** True from DIGEST_HOUR_UTC on, each UTC day. Pure. */
function digestDue(now = new Date()) {
  return new Date(now).getUTCHours() >= DIGEST_HOUR_UTC;
}

/**
 * The digest token for [{ kind, n }] (most first), or null when there was
 * nothing. Kinds that would not fit in 32 characters are left out; the total
 * still counts them. Pure.
 */
function digestToken(counts) {
  const rows = (counts || []).filter((c) => c && KIND_RE.test(c.kind) && Number(c.n) > 0);
  const total = rows.reduce((sum, c) => sum + figure(c.n), 0);
  if (!total) return null;
  let token = `digest:${figure(total)}:`;
  let first = true;
  for (const c of rows) {
    const part = `${first ? '' : ','}${c.kind}=${figure(c.n)}`;
    if (token.length + part.length > DETAIL_MAX) break;
    token += part;
    first = false;
  }
  return token;
}

/** "hour:<kind>:<n>", or null for a kind that cannot be one. Pure. */
function hourToken(kind, n) {
  if (!KIND_RE.test(String(kind || '')) || !(Number(n) > 0)) return null;
  return `hour:${kind}:${figure(n)}`;
}

/** The kinds past HOURLY_THRESHOLD in [{ kind, n }], as tokens. Pure. */
function hourAlerts(counts, threshold = HOURLY_THRESHOLD) {
  return (counts || [])
    .filter((c) => c && Number(c.n) >= threshold)
    .map((c) => ({ kind: c.kind, n: Number(c.n), detail: hourToken(c.kind, c.n) }))
    .filter((a) => a.detail);
}

const DIGEST_RE = /^digest:(\d{1,5}):((?:[a-z][a-z0-9_]{0,23}=\d{1,5})(?:,[a-z][a-z0-9_]{0,23}=\d{1,5})*)?$/;
const HOUR_RE = /^hour:([a-z][a-z0-9_]{0,23}):(\d{1,5})$/;

/**
 * Either { type: 'digest', total, kinds: [{ kind, n }] } or
 * { type: 'hour', kind, n }; null for anything else. Pure.
 */
function parseDetail(detail) {
  const s = String(detail || '');
  const d = DIGEST_RE.exec(s);
  if (d) {
    const kinds = d[2] ? d[2].split(',').map((p) => {
      const [kind, n] = p.split('=');
      return { kind, n: Number(n) };
    }) : [];
    return { type: 'digest', total: Number(d[1]), kinds };
  }
  const h = HOUR_RE.exec(s);
  if (h) return { type: 'hour', kind: h[1], n: Number(h[2]) };
  return null;
}

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// Resolved at call time so a test can swap either without a database.
function defaultCreate(db, args) {
  return require('./notifications').createPlatformIncidentNotifications(db, args);
}
function defaultPublish(pool, row) {
  return require('./notifications').hydrateAndPush(pool, row);
}

/**
 * One pass: the hour alerts, then the digest when it is due. Returns
 * { hour: [{ kind, n, recipients }], digest: { detail, recipients } | null }
 * and never sends one alert twice, however many sweeps race it.
 *
 * deps.create   overrides notifications.createPlatformIncidentNotifications
 * deps.publish  overrides notifications.hydrateAndPush
 * deps.staging  overrides the USERNODE_ENV check
 * deps.now      overrides the clock
 */
async function sweep(pool, deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const staging = deps.staging ?? isStaging();
  const create = deps.create || defaultCreate;
  const publish = deps.publish || defaultPublish;
  const summary = { hour: [], digest: null };

  const lastHour = await incidents.countByKind(pool, { since: new Date(now.getTime() - HOUR_MS) });
  const alerts = hourAlerts(lastHour);
  let digest = null;
  if (digestDue(now)) {
    const today = startOfUtcDay(now);
    const yesterday = new Date(today.getTime() - 24 * HOUR_MS);
    const detail = digestToken(await incidents.countByKind(pool, { since: yesterday, until: today }));
    if (detail) digest = { detail, since: today };
  }
  if (staging || (!alerts.length && !digest)) return summary;

  const inserted = await withTransaction(pool, async (db) => {
    // One sweep at a time, so the "already sent" check below sees the rows
    // the other one wrote.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['platform-incident-alerts']);
    const out = [];
    for (const a of alerts) {
      const rows = await create(db, {
        detail: a.detail,
        dedupePrefix: `hour:${a.kind}:`,
        since: new Date(now.getTime() - HOUR_MS),
      });
      summary.hour.push({ kind: a.kind, n: a.n, recipients: rows.length });
      out.push(...rows);
    }
    if (digest) {
      const rows = await create(db, { detail: digest.detail, dedupePrefix: 'digest:', since: digest.since });
      summary.digest = { detail: digest.detail, recipients: rows.length };
      out.push(...rows);
    }
    return out;
  });

  if (inserted.length) {
    log.info('platform-incidents', 'Unexpected events alert sent', {
      hour: summary.hour, digest: summary.digest, recipients: inserted.length,
    });
  }
  for (const row of inserted) {
    await Promise.resolve(publish(pool, row)).catch(() => {});
  }
  return summary;
}

module.exports = {
  HOURLY_THRESHOLD,
  DIGEST_HOUR_UTC,
  SWEEP_INTERVAL_MS,
  digestDue,
  digestToken,
  hourToken,
  hourAlerts,
  parseDetail,
  sweep,
};

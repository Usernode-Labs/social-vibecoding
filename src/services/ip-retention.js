'use strict';

// How long the platform keeps a person's IP address (#5132).
//
// One period for every IP the database holds: IP_RETENTION_DAYS, 180 days
// unless the deployment sets otherwise (whole days, 1 to 3650; anything else
// keeps 180). The privacy notice states this period, so change the two
// together. After it, the address is cleared and the row itself stays: a
// waitlist signup, a terms consent and a database-export audit row are still
// records the platform needs, only no longer with the address they came from.
//
// What this sweep clears, and the time each row is aged by:
//
//   waitlist_signups.ip           submitted_at
//   users.waitlist_ip             waitlist_submitted_at, else created_at
//   user_terms_consents.ip        responded_at
//   db_exports.ip                 requested_at
//
// The other places an address is kept already age out on their own, sooner
// than this period, and are not touched here:
//
//   cli_device_authorizations.request_ip   the row is deleted 24 hours after
//                                           it expires unused, or 30 days
//                                           after it was used, rejected or
//                                           cancelled (cli-auth.cleanupCliAuth)
//   cli_auth_rate_limits                   holds a SHA-256 key, never the
//                                           address, and goes a day after its
//                                           last use (same cleanup)
//   platform_processes.ip                  a platform pod's own address, not
//                                           a person's; gone 45 s after the
//                                           pod stops beating (processes.js)
//
// The server runs `purgeExpiredIps` daily on the leader's durable clock
// (server.js, `ip-retention`).

const DEFAULT_DAYS = 180; // six months
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

function retentionDays(env = process.env) {
  const raw = env.IP_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_DAYS;
  if (!/^\d+$/.test(String(raw).trim())) return DEFAULT_DAYS;
  const days = Number(String(raw).trim());
  if (!Number.isSafeInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return DEFAULT_DAYS;
  return days;
}

// Each entry clears one column on rows older than the period. `age` is the
// SQL expression a row is aged by. Literal SQL only: no name here comes from
// a caller.
const TARGETS = Object.freeze([
  Object.freeze({
    key: 'waitlistSignups',
    sql: `UPDATE waitlist_signups SET ip = NULL
           WHERE ip IS NOT NULL
             AND submitted_at < NOW() - make_interval(days => $1::int)`,
  }),
  Object.freeze({
    key: 'userWaitlistIps',
    sql: `UPDATE users SET waitlist_ip = NULL
           WHERE waitlist_ip IS NOT NULL
             AND COALESCE(waitlist_submitted_at, created_at) < NOW() - make_interval(days => $1::int)`,
  }),
  Object.freeze({
    key: 'termsConsents',
    sql: `UPDATE user_terms_consents SET ip = NULL
           WHERE ip IS NOT NULL
             AND responded_at < NOW() - make_interval(days => $1::int)`,
  }),
  Object.freeze({
    key: 'dbExports',
    sql: `UPDATE db_exports SET ip = NULL
           WHERE ip IS NOT NULL
             AND requested_at < NOW() - make_interval(days => $1::int)`,
  }),
]);

// Clears every address older than `days`. Each table is its own statement,
// so one that fails does not keep the others' addresses: the failure is
// reported after the rest have run.
async function purgeExpiredIps(pool, { days = retentionDays() } = {}) {
  const counts = {};
  let firstError = null;
  for (const target of TARGETS) {
    try {
      const result = await pool.query(target.sql, [days]);
      counts[target.key] = result.rowCount || 0;
    } catch (err) {
      counts[target.key] = 0;
      if (!firstError) firstError = err;
    }
  }
  if (firstError) {
    firstError.ipRetentionCounts = counts;
    throw firstError;
  }
  return counts;
}

module.exports = {
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS,
  TARGETS,
  retentionDays,
  purgeExpiredIps,
};

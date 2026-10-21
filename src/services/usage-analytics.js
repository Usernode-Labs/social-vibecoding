'use strict';

// "Share usage analytics" (#5097): a person's own choice whether Homeroom
// records how they use it. Off unless they switch it on, for every account,
// old and new (users.usage_analytics, schema.sql).
//
// What it covers is the usage analytics tied to an account:
//
//   ui_experience / ui_telemetry_delivery   the shell's UI telemetry
//       (services/ui-telemetry.js): screens visited and in what order, how
//       long a few actions took and whether they failed, page load times.
//       The admin Journey page reads its paths, next steps and "possibly
//       lost" visits from these rows.
//   first_session_moment   the made screen's moments
//       (services/first-session-moments.js).
//   dapp_opened            an app opened from the App tab
//       (services/app-openings.js).
//   live_build_opened / live_build_watched   watching a first version's
//       Live (services/first-version-live.js recordView).
//
// All of them go through ui-telemetry.isRecordable() or ask here directly,
// on the server, whatever the browser sends: an opted-out account's events
// are dropped on arrival. The shell also does not send them
// (uiTelemetryEligible on /api/auth/me).
//
// Not covered, because the platform needs them to work or to stay safe:
// security and audit logs, error logs, rate-limit records, and the records
// a feature reads back (votes, membership, the activity time a vote's
// threshold counts).
//
// Read fresh from the users row each time: a switch must take effect on the
// next request, and every caller is a rate-limited write that is about to
// touch the database anyway. Unreadable answers false, so a failed read never
// records somebody who did not say yes.

const log = require('./logger');

async function sharesUsageAnalytics(pool, userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const { rows } = await pool.query(
      'SELECT usage_analytics FROM users WHERE id = $1',
      [id]
    );
    return rows[0]?.usage_analytics === true;
  } catch (err) {
    log.warn('usage-analytics', 'Could not read the usage analytics choice', { userId: id, err: err && err.message });
    return false;
  }
}

/** Save the choice. Resolves the stored value, or null when there is no such account. */
async function setUsageAnalytics(pool, userId, enabled) {
  const { rows } = await pool.query(
    'UPDATE users SET usage_analytics = $1 WHERE id = $2 RETURNING usage_analytics',
    [enabled === true, Number(userId)]
  );
  return rows[0] ? rows[0].usage_analytics === true : null;
}

module.exports = {
  sharesUsageAnalytics,
  setUsageAnalytics,
};

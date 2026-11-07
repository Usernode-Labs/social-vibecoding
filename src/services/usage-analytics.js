'use strict';

// Usage analytics and Leave me out (Settings › Privacy).
//
// Homeroom keeps a record of how it is used, linked to each account. Part of
// it the product runs on and is kept for everyone: votes, messages, requests,
// projects, challenges and the daily app use a vote's threshold counts. The
// rest is screen usage data, recorded for everyone too unless the person
// leaves themselves out (users.usage_left_out_at; NULL is recorded):
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
// on the server, whatever the browser sends: a left-out account's events are
// dropped on arrival, and the shell does not send them either
// (uiTelemetryEligible on /api/auth/me). Leaving out also erases what was
// recorded of them, stops Google Analytics counting the person
// (ui-telemetry.countsInGoogleAnalytics), and takes their name off Journey's
// per-person views (services/journey-mask.js), which still count them in
// totals.
//
// Before this, #5593 (20 Oct 2026) made the same set opt-in behind "Share
// usage analytics" (users.usage_analytics), which nearly nobody switched on.
// That column is no longer read.
//
// Read fresh from the users row each time: a choice must take effect on the
// next request, and every caller is a rate-limited write that is about to
// touch the database anyway. Unreadable answers false, so a failed read never
// records somebody who may have left themselves out.

const log = require('./logger');

/** The event types Leave me out stops and erases. */
const SCREEN_USAGE_EVENT_TYPES = Object.freeze([
  'ui_experience',
  'ui_telemetry_delivery',
  'first_session_moment',
  'dapp_opened',
  'live_build_opened',
  'live_build_watched',
]);

/** Whether this account's screen usage data is recorded: true unless it left itself out. */
async function recordsUsage(pool, userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const { rows } = await pool.query(
      'SELECT usage_left_out_at FROM users WHERE id = $1',
      [id]
    );
    return !!rows[0] && rows[0].usage_left_out_at == null;
  } catch (err) {
    log.warn('usage-analytics', 'Could not read whether the account left itself out', { userId: id, err: err && err.message });
    return false;
  }
}

/**
 * The account's choice: `{ leftOut, leftOutAt }`, or null when there is no
 * such account. Throws when it cannot be read, so the Privacy page shows the
 * error rather than a guess.
 */
async function readChoice(pool, userId) {
  const { rows } = await pool.query('SELECT usage_left_out_at FROM users WHERE id = $1', [Number(userId)]);
  if (!rows[0]) return null;
  const at = rows[0].usage_left_out_at;
  return { leftOut: at != null, leftOutAt: at ? new Date(at).toISOString() : null };
}

/**
 * Leave the account out (`leftOut` true), or include it again. Leaving out
 * erases its screen usage data in the same transaction, so nothing recorded
 * before the tap outlives it; leaving out again keeps the first time.
 * Including it again records from then on: nothing erased comes back.
 * Resolves the stored choice, or null when there is no such account.
 */
async function setLeftOut(pool, userId, leftOut) {
  const id = Number(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users
          SET usage_left_out_at = CASE WHEN $2::boolean THEN COALESCE(usage_left_out_at, NOW()) ELSE NULL END
        WHERE id = $1
        RETURNING usage_left_out_at`,
      [id, leftOut === true]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    if (leftOut === true) {
      await client.query(
        'DELETE FROM events WHERE user_id = $1 AND event_type = ANY($2::text[])',
        [id, SCREEN_USAGE_EVENT_TYPES]
      );
    }
    await client.query('COMMIT');
    const at = rows[0].usage_left_out_at;
    return { leftOut: at != null, leftOutAt: at ? new Date(at).toISOString() : null };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* the original error wins */ }
    throw err;
  } finally {
    client.release();
  }
}

/** The ids of every account that left itself out, for Journey's masking. */
async function leftOutIds(pool) {
  const { rows } = await pool.query('SELECT id FROM users WHERE usage_left_out_at IS NOT NULL');
  return rows.map((r) => Number(r.id));
}

// An account made in the last 15 minutes, which is what the shell's sign_up
// event needs to know (#6314). The browser remembers having sent it, so the
// window only has to outlast a sign-up's redirects. Unreadable answers false.
const JUST_SIGNED_UP_MS = 15 * 60 * 1000;

async function justSignedUp(pool, userId, now = Date.now()) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const { rows } = await pool.query('SELECT created_at FROM users WHERE id = $1', [id]);
    const at = rows[0] ? new Date(rows[0].created_at).getTime() : NaN;
    return Number.isFinite(at) && now - at < JUST_SIGNED_UP_MS;
  } catch (err) {
    log.warn('usage-analytics', 'Could not read when the account was made', { userId: id, err: err && err.message });
    return false;
  }
}

module.exports = {
  SCREEN_USAGE_EVENT_TYPES,
  justSignedUp,
  leftOutIds,
  readChoice,
  recordsUsage,
  setLeftOut,
};

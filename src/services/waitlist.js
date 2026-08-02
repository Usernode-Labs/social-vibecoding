// Platform waitlist + platform-access grants (onboarding flow alignment).
//
// The waitlist is keyed by EMAIL, not by user (waitlist_signups in
// schema.sql): anyone can join from the public landing page with just an
// email, and an admin can release an email before its owner has an
// account. "Release" (released_at set) means: platform access is granted
// the moment a matching account exists — immediately if one already
// does, or at account creation via linkUserByEmail below.
//
// `users.has_platform_access` gates the SV platform surfaces (home /
// social / build — enforced in src/middleware/auth.js). It does NOT gate
// login-required child apps; any account may mint iframe tokens and use
// apps, per the onboarding doc's state ladder.
'use strict';

const log = require('./logger');

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

// Join the platform waitlist. Idempotent by email: re-joining is a
// silent no-op (the original submitted_at is kept) so the endpoint never
// discloses whether an email was already on the list. Returns
// { created } — created=false means the email already had a row.
async function joinWaitlist(pool, { email, ip = null, answers = null }) {
  const { rowCount } = await pool.query(
    `INSERT INTO waitlist_signups (email, ip, answers)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [email, ip, answers ? JSON.stringify(answers) : null]
  );
  return { created: rowCount > 0 };
}

// Grant platform access to a user (idempotent — re-granting keeps the
// original granted_at). Used by the release paths and by the signup
// surfaces that are invite-equivalent (activation codes, genesis wallet
// registration).
async function grantPlatformAccess(pool, userId) {
  await pool.query(
    `UPDATE users
        SET has_platform_access = TRUE,
            platform_access_granted_at = COALESCE(platform_access_granted_at, NOW())
      WHERE id = $1 AND has_platform_access = FALSE`,
    [userId]
  );
}

// Account-creation linkage: point the email's waitlist row (if any) at
// the new user, and if that row was already released, grant platform
// access on the spot — this is the doc's "released off the waitlist,
// create an account if you haven't already" arrow. Best-effort: a
// failure here must never fail the signup itself.
async function linkUserByEmail(pool, { userId, email }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !userId) return;
  try {
    const { rows } = await pool.query(
      `UPDATE waitlist_signups
          SET linked_user_id = $1
        WHERE email = $2
        RETURNING released_at`,
      [userId, normalized]
    );
    if (rows[0] && rows[0].released_at) {
      await grantPlatformAccess(pool, userId);
      log.info('waitlist', 'Released waitlist email registered — access granted', { userId });
    }
  } catch (err) {
    log.error('waitlist', 'linkUserByEmail failed', { userId, message: err.message });
  }
}

// Admin release of a waitlist row. Sets released_at (idempotent) and, if
// an account is already linked (or one exists with the same email),
// grants it platform access immediately. Returns the updated row or
// null when the id doesn't exist. `newly_released` distinguishes the
// first release from an idempotent re-release so the caller can send
// the "you're in" notification exactly once.
async function releaseWaitlistSignup(pool, signupId) {
  const { rows } = await pool.query(
    `WITH prev AS (
        SELECT released_at FROM waitlist_signups WHERE id = $1
     )
     UPDATE waitlist_signups w
        SET released_at = COALESCE(w.released_at, NOW())
      WHERE w.id = $1
      RETURNING w.id, w.email, w.released_at, w.linked_user_id,
                (SELECT prev.released_at FROM prev) IS NULL AS newly_released`,
    [signupId]
  );
  const row = rows[0];
  if (!row) return null;

  let userId = row.linked_user_id;
  if (!userId) {
    // The account may predate the waitlist row (or linkage was missed) —
    // resolve by email and backfill the link.
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [row.email]
    );
    if (userRows[0]) {
      userId = userRows[0].id;
      await pool.query(
        'UPDATE waitlist_signups SET linked_user_id = $1 WHERE id = $2',
        [userId, row.id]
      );
    }
  }
  if (userId) await grantPlatformAccess(pool, userId);
  return { ...row, linked_user_id: userId };
}

module.exports = {
  normalizeEmail,
  joinWaitlist,
  grantPlatformAccess,
  linkUserByEmail,
  releaseWaitlistSignup,
};

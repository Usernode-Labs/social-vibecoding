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

const crypto = require('crypto');
const log = require('./logger');
const { ANSWERS_VERSION } = require('./waitlist-questions');

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
// { created, moreToken } — created=false means the email already had a
// row, and moreToken is null in that case: the stage-2 capability link
// only goes to the FIRST join (and its email), never to whoever types
// the same address again later.
async function joinWaitlist(pool, { email, ip = null, answers = null }) {
  const moreToken = crypto.randomBytes(24).toString('hex');
  const stored = answers
    ? { _version: ANSWERS_VERSION, ...answers }
    : null;
  const { rowCount } = await pool.query(
    `INSERT INTO waitlist_signups (email, ip, answers, more_token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING`,
    [email, ip, stored ? JSON.stringify(stored) : null, moreToken]
  );
  const created = rowCount > 0;
  return { created, moreToken: created ? moreToken : null };
}

// Look up a signup by its stage-2 capability token. Returns the row
// (id, email, answers) or null.
async function getSignupByMoreToken(pool, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT id, email, answers FROM waitlist_signups WHERE more_token = $1`,
    [token]
  );
  return rows[0] || null;
}

// Merge a validated stage-2 payload into the signup's answers. Merging
// is section-wise (mirrors topochain's Participant::mergeAnswers): a
// re-submitted section replaces that section, untouched sections keep
// their previous value, so the form is re-openable and fillable over
// several visits. Returns the merged answers, or null when the token
// doesn't resolve.
async function mergeMoreAnswers(pool, token, patch) {
  const row = await getSignupByMoreToken(pool, token);
  if (!row) return null;
  const current = row.answers && typeof row.answers === 'object' ? row.answers : {};
  const merged = { ...current, ...patch, _version: ANSWERS_VERSION };
  await pool.query(
    `UPDATE waitlist_signups SET answers = $1 WHERE id = $2`,
    [JSON.stringify(merged), row.id]
  );
  return merged;
}

// Record an OAuth-verified social handle (github / x) on the signup.
// Verified handles live under answers.verified so they are distinct
// from the self-reported answers.handles entries.
async function setVerifiedHandle(pool, token, provider, handle) {
  const row = await getSignupByMoreToken(pool, token);
  if (!row) return null;
  const current = row.answers && typeof row.answers === 'object' ? row.answers : {};
  const verified = { ...(current.verified || {}), [provider]: handle };
  const merged = { ...current, verified, _version: ANSWERS_VERSION };
  await pool.query(
    `UPDATE waitlist_signups SET answers = $1 WHERE id = $2`,
    [JSON.stringify(merged), row.id]
  );
  return merged;
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
  getSignupByMoreToken,
  mergeMoreAnswers,
  setVerifiedHandle,
  grantPlatformAccess,
  linkUserByEmail,
  releaseWaitlistSignup,
};

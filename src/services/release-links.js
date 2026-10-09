'use strict';

// The waitlist release mail's one-time sign-in link (#4594).
//
// "Create my account" in the "you're in" mail signs its recipient in once,
// without a second email and a 6-digit code: following it proves the mailbox
// exactly as typing a code does, and from there it continues exactly as a
// code does (services/email-signup.js continueProvenEmail): a new account goes
// straight to its account step (a username, and a password or "Skip for
// now"), an account with nothing left to set up is signed in.
//
// It is NOT the waitlist row's `more_token`, which never expires, is reusable,
// is handed back to whoever submits the join form and is shown in the in-app
// waitlist card; #1548 made that one prefill-only on purpose, and it stays
// so. This is a separate credential with the properties a sign-in link needs:
//
//   - 32 random bytes, sent only in the release mail, and stored only as a
//     SHA-256 hash (`waitlist_release_links`, staging:private, masked in the
//     db console and denied to the debug role);
//   - bound to the waitlist row it was minted for and that row's address: a
//     row whose address changed, or that was un-released, spends nothing;
//   - single use, and good for RELEASE_LINK_TTL_MS (7 days);
//   - spent only by a POST from the page (POST /api/auth/release-link),
//     never by the GET that opens it, so the mail's click-tracking redirect
//     and the mail scanners that prefetch links cannot use it up. The mail
//     leaves this link out of click tracking (services/mail/tracking.js),
//     which would otherwise store the destination URL, token and all.
//
// Anything else (expired, used, unknown, malformed) answers one refusal, and
// the page falls back to the flow it had before: the address filled in and a
// code sent. Raw tokens are never logged.

const crypto = require('crypto');
const log = require('./logger');
const emailSignup = require('./email-signup');

const RELEASE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CLEANUP_LIMIT = 500;

const INVALID_MESSAGE = 'This sign-in link has expired or was already used.';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * A fresh link for one released waitlist row. Any earlier unspent link for
 * the same row stops working: the newest mail is the one to follow.
 * Returns the raw token, for the mail only.
 */
async function mint(pool, { signupId, email }) {
  const address = emailSignup.normalizeEmail(email);
  if (!signupId || !address) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RELEASE_LINK_TTL_MS);
  try {
    await pool.query(
      `DELETE FROM waitlist_release_links
        WHERE token_hash IN (
          SELECT token_hash FROM waitlist_release_links
           WHERE expires_at < NOW() - INTERVAL '1 day'
           LIMIT ${CLEANUP_LIMIT}
        )`
    );
  } catch (error) {
    log.warn('release-links', 'Expired link cleanup skipped', { message: error.message });
  }
  await pool.query(
    'DELETE FROM waitlist_release_links WHERE signup_id = $1 AND consumed_at IS NULL',
    [signupId]
  );
  await pool.query(
    `INSERT INTO waitlist_release_links (token_hash, signup_id, email, expires_at, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [hashToken(token), signupId, address, expiresAt]
  );
  return token;
}

/**
 * Spend a link: the mailbox is proven, so continue as an email code would.
 * Throws EmailSignupError `invalid_release_link` for anything that is not a
 * live, unspent link to a released row with the same address, and the
 * code's own refusals (an admin, an unconfirmed account with a password)
 * once the link is spent.
 */
async function spend(pool, rawToken, { createSession } = {}) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!TOKEN_RE.test(token)) {
    throw new emailSignup.EmailSignupError('invalid_release_link', INVALID_MESSAGE);
  }
  let email = null;
  const result = await emailSignup.withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT l.token_hash, l.email, l.expires_at, l.consumed_at,
              w.email AS signup_email, w.released_at
         FROM waitlist_release_links l
         JOIN waitlist_signups w ON w.id = l.signup_id
        WHERE l.token_hash = $1
        FOR UPDATE OF l`,
      [hashToken(token)]
    );
    const link = rows[0];
    if (!link || link.consumed_at || new Date(link.expires_at) <= new Date()
        || !link.released_at
        || emailSignup.normalizeEmail(link.signup_email) !== link.email) {
      return { invalid: true };
    }
    await client.query(
      'UPDATE waitlist_release_links SET consumed_at = NOW() WHERE token_hash = $1',
      [link.token_hash]
    );
    email = link.email;
    return emailSignup.continueProvenEmail(client, email, { createSession });
  });
  if (result.invalid) {
    throw new emailSignup.EmailSignupError('invalid_release_link', INVALID_MESSAGE);
  }
  const finished = await emailSignup.finishProvenEmail(pool, email, result);
  return { ...finished, email };
}

module.exports = { RELEASE_LINK_TTL_MS, TOKEN_RE, mint, spend, hashToken };

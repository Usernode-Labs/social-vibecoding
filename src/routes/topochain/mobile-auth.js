// Topochain v4 mobile auth (plan Task 8; SPEC §4.5 lines 850-854 for the
// endpoint list, 1588-1746 for the token model + throttling + the six
// endpoint contracts). Composed into src/routes/topochain/mobile.js (the
// mobile router mounts this module alongside its own __ping stub).
//
// Six endpoints, two auth stories:
//   - Public, throttled (check-email, login, otp/request, otp/verify):
//     share the ONE `topochainMobileAuthLimiter` bucket
//     (src/middleware/rate-limits.js), 10 req/min/IP, path NOT part of
//     the key (SPEC 1597).
//   - Token-gated (set-password, logout): `mobileTokenAuth`
//     (src/middleware/topochain-auth.js). set-password requires the
//     `set-password` ability specifically (with a route-specific 403
//     message, SPEC 1729); logout accepts ANY live token (`ability:
//     null`, SPEC 1734 "any valid token").
//
// v4 ENVELOPE NORMALIZATION (documented once, applies to every route
// below): SPEC 1588-1746's example bodies are all a bare `{"message":
// ...}` (errors) or an ad hoc success shape — that is v1/v3 source
// behavior. Per architecture decision #3 (SPEC §4.8), every response in
// this file is wrapped in the ONE v4 envelope (`ok`/`fail` from
// ./helpers): errors become `{"success": false, "error": "<same exact
// sentence>"}`, keeping the literal wording SPEC prescribes but replacing
// the envelope shape. EXCEPTION called out in the task brief: the two
// endpoints whose SPEC success body itself carries a "message" key
// (otp/request, logout) keep that key — it just now rides inside the
// success envelope (`{"success": true, "message": "..."}`) instead of
// being the whole body.
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { mobileTokenAuth, optionalSessionAuth, extractBearerToken } = require('../../middleware/topochain-auth');
const { topochainMobileAuthLimiter } = require('../../middleware/rate-limits');
const { sendOtpMail } = require('../../services/topochain/mailer');
const mail = require('../../services/mail');
const waitlist = require('../../services/waitlist');
const { ok, fail } = require('./helpers');

// ─── Constants (token model, SPEC 1588-1599; OTP model, SPEC 1675-1679) ──

const SESSION_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SET_PASSWORD_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes, single use
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OTP_ATTEMPTS = 5;

// Set-password's 403 (SPEC 1729) is a distinct sentence from
// mobileTokenAuth's generic "A set-password token is required." default —
// passed as an override so this ONE route gets the literal SPEC text
// without changing what every other set-password-gated route would say.
const SET_PASSWORD_FORBIDDEN_MESSAGE = 'This token cannot set a password.';

// Timing side-channel guard for /login (code review fix). A bcrypt
// compare against a REAL row's hash and a synchronous "no row" branch
// take measurably different wall-clock time — an attacker could time
// responses to tell "no account with this email" apart from "account
// exists, wrong password" even though both return the identical 401
// SPEC 1648 requires. Comparing against this fixed, precomputed hash
// whenever there's no real user (or password) row to compare against
// keeps every failure path doing one bcrypt compare, so all three
// failure modes (unknown email, no password set, wrong password) cost
// about the same. The plaintext behind this hash is never used to
// authenticate anything; only its shape (a valid bcrypt hash, so
// `compare` takes its normal code path) matters.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('topochain-timing-normalization-only', 12);

// ─── Validation helpers ──────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// `email`, `max:255` (every endpoint's request table). Normalizes to
// lower-case on success — OTP-created accounts always store/derive their
// email and username lower-cased (see otp/verify below), so every lookup
// in this file needs to compare against that same normalized form or a
// mixed-case login attempt would silently miss its own account.
function validateEmailField(rawEmail, details) {
  if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
    details.email = ['The email field is required.'];
    return null;
  }
  const trimmed = rawEmail.trim();
  if (trimmed.length > 255 || !EMAIL_RE.test(trimmed)) {
    details.email = ['The email must be a valid email address.'];
    return null;
  }
  return trimmed.toLowerCase();
}

// ─── Token issuance (Global Constraints #4) ──────────────────────────────

// 40-byte random hex bearer token, returned to the caller ONCE; only its
// sha256 hex digest is ever persisted (mobile_auth_tokens.token_hash).
async function issueToken(pool, userId, ability, ttlMs) {
  const rawToken = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    `INSERT INTO mobile_auth_tokens (user_id, token_hash, ability, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, ability, expiresAt]
  );
  return rawToken;
}

// Deletes exactly the ONE token presented on this request (never every
// token the user holds — logging out or completing set-password on one
// device must not silently sign the user out everywhere else, SPEC 1655/
// 1732/1746). No-op (nothing to delete) if the header is somehow absent,
// which can't happen on a route already gated by mobileTokenAuth.
async function revokePresentedToken(pool, req) {
  const presented = extractBearerToken(req);
  if (!presented) return;
  const tokenHash = crypto.createHash('sha256').update(presented).digest('hex');
  await pool.query('DELETE FROM mobile_auth_tokens WHERE token_hash = $1', [tokenHash]);
}

// ─── level + user payload (SPEC 1653: operator > member > guest) ────────

async function computeLevel(pool, userId, passwordSet) {
  const { rows } = await pool.query('SELECT 1 FROM onchain_accounts WHERE user_id = $1 LIMIT 1', [userId]);
  if (rows.length) return 'operator';
  return passwordSet ? 'member' : 'guest';
}

// The `user` object shared by /login and /set-password's login-shaped
// response (SPEC 1632-1642, 1722).
async function buildUserPayload(pool, user) {
  const level = await computeLevel(pool, user.id, !!user.password_set);
  return {
    id: Number(user.id),
    email: user.email,
    display_name: user.display_name,
    email_confirmed: !!user.email_confirmed,
    level,
  };
}

// ─── Router ───────────────────────────────────────────────────────────

// Rows an expired OTP leaves behind, and mail_deliveries past its
// retention. Both deletes are bounded by a LIMIT so this stays a small
// predictable statement on whatever request happens to trigger it, and
// every failure is swallowed: this is housekeeping riding on an
// always-200 endpoint, so it may never influence the response.
const OTP_CLEANUP_LIMIT = 2000;

async function cleanupExpiredMailState(pool) {
  try {
    await pool.query(
      `DELETE FROM mobile_otp_codes
        WHERE id IN (
          SELECT id FROM mobile_otp_codes
           WHERE expires_at < NOW() - INTERVAL '24 hours'
           LIMIT ${OTP_CLEANUP_LIMIT}
        )`
    );
  } catch (err) {
    log.warn('topochain-mobile-auth', 'Expired OTP cleanup skipped', { message: err.message });
  }
  await mail.pruneDeliveries(pool);
}

function topochainMobileAuthRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── POST /check-email (SPEC 1601-1619) ──────────────────────────────
  // Deliberate email-enumeration surface (SPEC 1619's own note) — that is
  // exactly why it shares the throttle bucket with the other three.
  router.post('/api/v4/mobile/auth/check-email', topochainMobileAuthLimiter, async (req, res) => {
    try {
      const details = {};
      const email = validateEmailField(req.body?.email, details);
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query('SELECT password_set FROM users WHERE email = $1', [email]);
      const user = rows[0];
      return ok(res, { exists: !!user, password_set: user ? !!user.password_set : false });
    } catch (err) {
      log.error('topochain-mobile-auth', 'POST /check-email failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /login (SPEC 1621-1655) ─────────────────────────────────────
  router.post('/api/v4/mobile/auth/login', topochainMobileAuthLimiter, async (req, res) => {
    try {
      const details = {};
      const email = validateEmailField(req.body?.email, details);
      const password = req.body?.password;
      if (typeof password !== 'string' || !password) {
        details.password = ['The password field is required.'];
      }
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `SELECT id, password, email, display_name, email_confirmed, password_set
           FROM users WHERE email = $1`,
        [email]
      );
      const user = rows[0];
      // Always run exactly one bcrypt.compare, real hash or the fixed
      // dummy one (see DUMMY_PASSWORD_HASH above) — an unknown email must
      // do comparable work to a known one, or response timing alone would
      // leak which case occurred.
      const passwordMatches = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);

      // SPEC 1648: ONE message for all three failure modes (unknown
      // email, no password set, wrong password) — never disclose which.
      if (!user || !user.password_set || !passwordMatches) {
        return fail(res, 401, 'Invalid email or password.');
      }

      // SPEC 1654-1655: concurrent sessions allowed (no revoke-others
      // here), email confirmation not required to log in (no check here).
      const token = await issueToken(pool, user.id, 'session', SESSION_TOKEN_TTL_MS);
      const userPayload = await buildUserPayload(pool, user);
      return ok(res, { token, user: userPayload });
    } catch (err) {
      log.error('topochain-mobile-auth', 'POST /login failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /otp/request (SPEC 1657-1679) ───────────────────────────────
  router.post('/api/v4/mobile/auth/otp/request', topochainMobileAuthLimiter, async (req, res) => {
    try {
      const details = {};
      const email = validateEmailField(req.body?.email, details);
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      // SPEC 1677: only the newest code is ever valid.
      await pool.query('DELETE FROM mobile_otp_codes WHERE email = $1 AND consumed_at IS NULL', [email]);

      // Opportunistic housekeeping. mobile_otp_codes only ever shed rows
      // for the email being re-requested, so every address that ever asked
      // for a code and never came back left a (bcrypt-hashed, long-expired)
      // row behind forever; mail_deliveries has its own 30-day retention.
      // Doing it here rather than on a timer keeps the platform free of
      // another background interval — this endpoint is exactly as busy as
      // the table it prunes.
      //
      // Best-effort and bounded: a failure here must not touch the
      // response, and note this runs BEFORE the throttle decision, so even
      // a request whose mail is suppressed still rotates the code above
      // and still does its share of the cleanup.
      await cleanupExpiredMailState(pool);

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      // Lower bcrypt cost than real passwords (auth.js uses 12): a 6-digit
      // code already has only 1e6 possibilities and is additionally bound
      // by the 5-attempt counter (below) and the shared IP throttle, so
      // the extra hashing cost buys little beyond slowing down this
      // already rate-limited endpoint.
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);
      await pool.query(
        `INSERT INTO mobile_otp_codes (email, code_hash, attempts, expires_at, created_at, updated_at)
         VALUES ($1, $2, 0, $3, NOW(), NOW())`,
        [email, codeHash, expiresAt]
      );

      // SPEC 1679: mail is sent whether or not the account exists — the
      // account itself is created later, at verify time.
      await sendOtpMail(config, email, code);

      // SPEC 1667: always 200, known or unknown address alike.
      return ok(res, { message: 'If that email can receive a code, one has been sent.' });
    } catch (err) {
      log.error('topochain-mobile-auth', 'POST /otp/request failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /otp/verify (SPEC 1681-1708) ────────────────────────────────
  router.post('/api/v4/mobile/auth/otp/verify', topochainMobileAuthLimiter, async (req, res) => {
    try {
      const details = {};
      const email = validateEmailField(req.body?.email, details);
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      if (!code) details.code = ['The code field is required.'];
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `SELECT id, code_hash, attempts, expires_at FROM mobile_otp_codes
          WHERE email = $1 AND consumed_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [email]
      );
      const otp = rows[0];

      // SPEC 1702/1707: ONE message covers every failure mode (no live
      // code, expired, five failed attempts already, or a wrong code,
      // which increments the counter below) — deliberately
      // indistinguishable so a client can't fingerprint which occurred.
      const invalidOrExpired = () => fail(res, 422, 'Invalid or expired code.');

      if (!otp) return invalidOrExpired();
      if (new Date(otp.expires_at) < new Date()) return invalidOrExpired();
      if (otp.attempts >= MAX_OTP_ATTEMPTS) return invalidOrExpired();

      const matches = await bcrypt.compare(code, otp.code_hash);
      if (!matches) {
        await pool.query('UPDATE mobile_otp_codes SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1', [otp.id]);
        return invalidOrExpired();
      }

      await pool.query('UPDATE mobile_otp_codes SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1', [otp.id]);

      // SPEC 1708: this endpoint creates accounts — an unknown email gets
      // a new user row, force-confirmed on success. An email that
      // already resolves to an existing user is left exactly as it was
      // (no confirmation-state change) — SPEC only describes the
      // creation branch's force-confirm; a judgment call to not extend
      // it to pre-existing accounts, documented here rather than assumed.
      const { rows: existingRows } = await pool.query(
        'SELECT id, email, display_name, email_confirmed, password_set, is_admin FROM users WHERE email = $1',
        [email]
      );
      let user = existingRows[0];

      // GUARD (security-review finding): because Global Constraints #7
      // folds every topochain user into the SHARED platform `users` table,
      // an unrestricted OTP flow would double as an unauthenticated
      // password RESET for any platform web account — including admins'
      // web-console logins — since /set-password below overwrites
      // `users.password` for whatever user this token points at. Refuse
      // to issue a set-password token when the resolved account is an
      // admin, or already has a real password (`password_set = TRUE`).
      // This preserves the SPEC §8.5 flow exactly: the 199 migrated
      // password-less participants (and every OTP-created account) have
      // `password_set = FALSE` and `is_admin = FALSE`, so they still set
      // their FIRST password here; only accounts that already own a
      // usable password are excluded. The response is the same generic
      // 422 as every other OTP failure (SPEC 1702/1707's one-message
      // rule) so this branch is not an "is this an admin / has this
      // account a password" oracle. The code was already consumed above,
      // keeping single-use semantics identical to the success path.
      if (user && (user.is_admin || user.password_set)) return invalidOrExpired();
      if (!user) {
        // Random, unusable bcrypt hash (nobody knows the plaintext) —
        // satisfies users.password NOT NULL without granting a usable
        // password; password_set stays FALSE until POST /set-password.
        const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        const { rows: createdRows } = await pool.query(
          `INSERT INTO users (username, password, email, email_confirmed, email_confirmed_at, password_set, is_admin)
           VALUES ($1, $2, $3, TRUE, NOW(), FALSE, FALSE)
           RETURNING id, email, display_name, email_confirmed, password_set`,
          [email, unusablePasswordHash, email]
        );
        user = createdRows[0];
        // Waitlist linkage (onboarding flow alignment): point any
        // waitlist row for this email at the new account; if the email
        // was already released, this grants platform access immediately.
        // Best-effort — never fails the signup.
        await waitlist.linkUserByEmail(pool, { userId: user.id, email });
      }

      const setPasswordToken = await issueToken(pool, user.id, 'set-password', SET_PASSWORD_TOKEN_TTL_MS);
      return ok(res, { set_password_token: setPasswordToken });
    } catch (err) {
      log.error('topochain-mobile-auth', 'POST /otp/verify failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /set-password (SPEC 1710-1732) ──────────────────────────────
  // Auth: set-password token ONLY — a session token authenticates but is
  // refused with the SPEC-literal 403 (forbiddenMessage override, see the
  // constant above), never the generic ability-mismatch text.
  router.post(
    '/api/v4/mobile/auth/set-password',
    mobileTokenAuth(config, { ability: 'set-password', forbiddenMessage: SET_PASSWORD_FORBIDDEN_MESSAGE }),
    async (req, res) => {
      try {
        const details = {};
        const password = req.body?.password;
        const confirmation = req.body?.password_confirmation;
        if (typeof password !== 'string' || password.length < 8) {
          details.password = ['The password must be at least 8 characters.'];
        }
        if (password !== confirmation) {
          details.password_confirmation = ['The password confirmation does not match.'];
        }
        if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

        // GUARD (security-review finding, consume-side twin of the
        // otp/verify issue-side check): even though otp/verify no longer
        // issues set-password tokens for admins or accounts with a real
        // password, re-check the CURRENT row state before overwriting
        // `users.password` — a token minted before the account gained a
        // password (or admin status) must not still be able to reset it.
        // Responds exactly like an invalid/expired token (mobileTokenAuth's
        // own 401), never a distinct message that would fingerprint the
        // account; the presented token is revoked just as a successful
        // consume would be (single-use either way).
        const { rows: guardRows } = await pool.query(
          'SELECT is_admin, password_set FROM users WHERE id = $1',
          [req.user.id]
        );
        const guard = guardRows[0];
        if (!guard || guard.is_admin || guard.password_set) {
          await revokePresentedToken(pool, req);
          return fail(res, 401, 'Unauthenticated.');
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await pool.query(
          'UPDATE users SET password = $1, password_set = TRUE WHERE id = $2',
          [passwordHash, req.user.id]
        );

        // SPEC 1732: single-use — delete the set-password token that
        // authenticated THIS request before issuing the fresh session.
        await revokePresentedToken(pool, req);

        const { rows } = await pool.query(
          'SELECT id, email, display_name, email_confirmed, password_set FROM users WHERE id = $1',
          [req.user.id]
        );
        const user = rows[0];

        // SPEC 1722: identical shape to /login, carrying a fresh 90-day
        // session token. Other existing sessions are not revoked.
        const token = await issueToken(pool, user.id, 'session', SESSION_TOKEN_TTL_MS);
        const userPayload = await buildUserPayload(pool, user);
        return ok(res, { token, user: userPayload });
      } catch (err) {
        log.error('topochain-mobile-auth', 'POST /set-password failed', { message: err.message });
        return fail(res, 500, 'Internal server error.');
      }
    }
  );

  // ── POST /from-session (platform-login unification) ──────────────────
  // Exchanges a live platform WEB session (the `session` cookie) for a
  // mobile bearer token, so the SV shell can log the user in ONCE on the
  // web surface and then hand the native app a credential over the JS
  // bridge (NATIVE-BRIDGE.md, bridge v4 `completeLogin`). This is the only
  // bridge between the two auth systems: everything else about the token
  // (ability, TTL, hashing, revocation) is identical to /login's output —
  // it IS issueToken with a cookie-shaped front door.
  //
  // Auth: session cookie (optionalSessionAuth + explicit user check, the
  // same pattern as the /challenges-api web reads in mobile.js). CSRF is a
  // non-issue: a forged cross-site POST could mint a token but can never
  // read the response, and the token is returned once, never persisted
  // in a cookie.
  //
  // Response: identical `{token, user}` shape to /login (SPEC 1632-1642)
  // so the native side can feed it to the same AuthSession model. Web-only
  // accounts (username/password, no email) are first-class here — `email`
  // rides as null; the native client keys off `user.id`.
  const fromSessionAuth = optionalSessionAuth(config);
  router.post(
    '/api/v4/mobile/auth/from-session',
    topochainMobileAuthLimiter,
    fromSessionAuth,
    async (req, res) => {
      try {
        if (!req.user) return fail(res, 401, 'Unauthenticated.');

        const { rows } = await pool.query(
          'SELECT id, email, display_name, email_confirmed, password_set FROM users WHERE id = $1',
          [req.user.id]
        );
        const user = rows[0];
        if (!user) return fail(res, 401, 'Unauthenticated.');

        const token = await issueToken(pool, user.id, 'session', SESSION_TOKEN_TTL_MS);
        const userPayload = await buildUserPayload(pool, user);
        return ok(res, { token, user: userPayload });
      } catch (err) {
        log.error('topochain-mobile-auth', 'POST /from-session failed', { message: err.message });
        return fail(res, 500, 'Internal server error.');
      }
    }
  );

  // ── POST /logout (SPEC 1734-1746) ────────────────────────────────────
  // Auth: any valid token — session OR set-password (`ability: null`
  // skips mobileTokenAuth's ability check entirely).
  router.post(
    '/api/v4/mobile/auth/logout',
    mobileTokenAuth(config, { ability: null }),
    async (req, res) => {
      try {
        // SPEC 1746: revokes ONLY the token used; other devices/sessions
        // stay signed in.
        await revokePresentedToken(pool, req);
        return ok(res, { message: 'Logged out.' });
      } catch (err) {
        log.error('topochain-mobile-auth', 'POST /logout failed', { message: err.message });
        return fail(res, 500, 'Internal server error.');
      }
    }
  );

  return router;
}

// computeLevel is exported alongside the router purely for direct unit
// testing (tests/topochain-mobile-auth.test.js) — its 'guest' branch is
// otherwise unreachable through this file's own two endpoints: /login and
// /set-password both require password_set = TRUE to even reach
// buildUserPayload, so 'guest' (password NOT set) can only ever surface
// later, from Task 9's /me (a still-valid SESSION token whose user's
// password_set was reset to false after the token was issued).
module.exports = { topochainMobileAuthRoutes, computeLevel };

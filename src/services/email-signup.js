'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const mail = require('./mail');
const waitlist = require('./waitlist');

const OTP_TTL_MS = 10 * 60 * 1000;
const SIGNUP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_CLEANUP_LIMIT = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class EmailSignupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailSignupError';
    this.code = code;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 255 && EMAIL_RE.test(email) ? email : null;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function cleanupExpiredState(pool) {
  try {
    await pool.query(
      `DELETE FROM mobile_otp_codes
        WHERE id IN (
          SELECT id FROM mobile_otp_codes
           WHERE expires_at < NOW() - INTERVAL '24 hours'
           LIMIT ${OTP_CLEANUP_LIMIT}
        )`
    );
    await pool.query(
      `DELETE FROM web_signup_sessions
        WHERE token_hash IN (
          SELECT token_hash FROM web_signup_sessions
           WHERE expires_at < NOW()
           LIMIT ${OTP_CLEANUP_LIMIT}
        )`
    );
  } catch (error) {
    log.warn('email-signup', 'Expired signup cleanup skipped', { message: error.message });
  }
  await mail.pruneDeliveries(pool);
}

// The mail layer suppresses a second `otp` message to the same address inside
// RULES.otp.minGapMs (src/services/mail/rate-limit.js). Minting a fresh code
// in that window used to delete the working one and then mail nothing, so a
// double-tap left the recipient holding a code the server had already thrown
// away. Inside the gap we keep the code that was actually delivered instead:
// still unused, still unexpired, so the mail already in their inbox works.
const OTP_REUSE_WINDOW_SECONDS = 60;

async function requestCode(pool, config, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new EmailSignupError('invalid_email', 'Enter a valid email address.');

  const reused = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id,
              (attempts = 0
               AND expires_at > NOW()
               AND created_at > NOW() - INTERVAL '${OTP_REUSE_WINDOW_SECONDS} seconds')
                AS reusable
         FROM mobile_otp_codes
        WHERE email = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
          FOR UPDATE`,
      [email]
    );
    if (rows[0] && rows[0].reusable) return true;
    // Outside the window, expired, or already guessed at: replace it.
    await client.query(
      'DELETE FROM mobile_otp_codes WHERE email = $1 AND consumed_at IS NULL',
      [email]
    );
    return false;
  });
  if (reused) return email;

  await cleanupExpiredState(pool);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await pool.query(
    `INSERT INTO mobile_otp_codes
       (email, code_hash, attempts, expires_at, created_at, updated_at)
     VALUES ($1, $2, 0, $3, NOW(), NOW())`,
    [email, codeHash, expiresAt]
  );
  await mail.sendOtpMail(config, email, code);
  return email;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

async function verifyCode(pool, rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!email || !code) {
    throw new EmailSignupError('invalid_or_expired_code', 'Invalid or expired code.');
  }

  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id, code_hash, attempts, expires_at
         FROM mobile_otp_codes
        WHERE email = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [email]
    );
    const otp = rows[0];
    if (!otp || new Date(otp.expires_at) < new Date() || otp.attempts >= MAX_OTP_ATTEMPTS) {
      return { invalid: true };
    }

    if (!await bcrypt.compare(code, otp.code_hash)) {
      await client.query(
        'UPDATE mobile_otp_codes SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1',
        [otp.id]
      );
      return { invalid: true };
    }

    await client.query(
      'UPDATE mobile_otp_codes SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [otp.id]
    );

    const { rows: existingRows } = await client.query(
      `SELECT id, is_admin, password_set
         FROM users
        WHERE lower(email) = lower($1)
        FOR UPDATE`,
      [email]
    );
    let user = existingRows[0] || null;
    if (user && (user.is_admin || user.password_set)) return { invalid: true };

    let created = false;
    if (!user) {
      const unusablePasswordHash = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        12
      );
      const { rows: createdRows } = await client.query(
        `INSERT INTO users
           (username, password, email, email_confirmed, email_confirmed_at,
            password_set, is_admin)
         VALUES ($1, $2, $3, TRUE, NOW(), FALSE, FALSE)
         RETURNING id, is_admin, password_set`,
        [email, unusablePasswordHash, email]
      );
      user = createdRows[0];
      created = true;
    }

    const signupToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SIGNUP_TTL_MS);
    await client.query(
      `INSERT INTO web_signup_sessions (token_hash, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at,
             created_at = NOW()`,
      [tokenHash(signupToken), user.id, expiresAt]
    );
    return { signupToken, expiresAt, userId: user.id, created };
  });

  if (result.invalid) {
    throw new EmailSignupError('invalid_or_expired_code', 'Invalid or expired code.');
  }
  if (result.created) {
    await waitlist.linkUserByEmail(pool, { userId: result.userId, email });
  }
  return result;
}

async function completePassword(pool, { signupToken, password, createSession }) {
  if (typeof signupToken !== 'string' || !/^[a-f0-9]{64}$/.test(signupToken)) {
    throw new EmailSignupError('invalid_signup_session', 'Your signup session expired. Request a new code.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new EmailSignupError('invalid_password', 'Password must be at least 8 characters.');
  }
  const passwordHash = await bcrypt.hash(password, 12);

  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT w.user_id, w.expires_at, u.username, u.is_admin,
              u.admin_readonly, u.password_set
         FROM web_signup_sessions w
         JOIN users u ON u.id = w.user_id
        WHERE w.token_hash = $1
        FOR UPDATE OF w, u`,
      [tokenHash(signupToken)]
    );
    const signup = rows[0];
    if (!signup || new Date(signup.expires_at) < new Date()) {
      return { invalid: true };
    }

    await client.query('DELETE FROM web_signup_sessions WHERE token_hash = $1', [tokenHash(signupToken)]);
    if (signup.is_admin || signup.password_set) return { invalid: true };

    await client.query(
      'UPDATE users SET password = $1, password_set = TRUE WHERE id = $2',
      [passwordHash, signup.user_id]
    );
    const session = await createSession(client, signup.user_id);
    return {
      session,
      user: {
        id: signup.user_id,
        username: signup.username,
        isAdmin: !!signup.is_admin,
        adminReadonly: !!signup.admin_readonly,
      },
    };
  });

  if (result.invalid) {
    throw new EmailSignupError('invalid_signup_session', 'Your signup session expired. Request a new code.');
  }
  return result;
}

module.exports = {
  EmailSignupError,
  OTP_TTL_MS,
  SIGNUP_TTL_MS,
  normalizeEmail,
  requestCode,
  verifyCode,
  completePassword,
};

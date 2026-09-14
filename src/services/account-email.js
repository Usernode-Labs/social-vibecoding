'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mail = require('./mail');
const { normalizeEmail } = require('./email-signup');

class AccountEmailError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      throw new AccountEmailError(409, 'That email cannot be linked to this account.');
    }
    throw error;
  } finally { client.release(); }
}

async function lockUser(client, userId) {
  const { rows } = await client.query(
    'SELECT email, email_confirmed, password, password_set, is_admin FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  if (!rows[0]) throw new AccountEmailError(404, 'Account not found.');
  return rows[0];
}

async function requestCode(pool, config, userId, rawEmail, currentPassword) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new AccountEmailError(400, 'Enter a valid email address.');
  const result = await transaction(pool, async (client) => {
    const user = await lockUser(client, userId);
    if (user.password_set && (typeof currentPassword !== 'string'
      || !currentPassword || currentPassword.length > 1024
      || !await bcrypt.compare(currentPassword, user.password))) {
      throw new AccountEmailError(401, 'Enter your current password.');
    }
    const { rows: owners } = await client.query(
      'SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [email, userId]
    );
    if (owners.length) throw new AccountEmailError(409, 'That email cannot be linked to this account.');
    const { rows } = await client.query(
      'SELECT *, created_at > NOW() - INTERVAL \'60 seconds\' AS recent FROM account_email_verifications WHERE user_id = $1',
      [userId]
    );
    // Do not invalidate a just-mailed code on a double tap or during the
    // recipient mail throttle. A deliberate resend is available after a minute.
    if (rows[0]?.recent) throw new AccountEmailError(429, 'Wait a minute before requesting another code.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await client.query(
      `INSERT INTO account_email_verifications
         (user_id, email, code_hash, password_hash, previous_email, attempts, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, NOW() + INTERVAL '10 minutes', NOW())
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email,
         code_hash = EXCLUDED.code_hash, password_hash = EXCLUDED.password_hash,
         previous_email = EXCLUDED.previous_email, attempts = 0,
         expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
      [userId, email, await bcrypt.hash(code, 10), user.password, user.email]
    );
    return { code };
  });
  await mail.send(config, { kind: 'account_email', to: email, code: result.code });
  return { email };
}

async function verifyCode(pool, userId, rawCode) {
  if (typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode.trim())) {
    throw new AccountEmailError(400, 'Enter the six-digit code.');
  }
  const result = await transaction(pool, async (client) => {
    const user = await lockUser(client, userId);
    const { rows } = await client.query(
      'SELECT *, expires_at > NOW() AS valid FROM account_email_verifications WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const proof = rows[0];
    if (!proof || !proof.valid || proof.attempts >= 5
      || proof.password_hash !== user.password || proof.previous_email !== user.email) return null;
    if (!await bcrypt.compare(rawCode.trim(), proof.code_hash)) {
      // Commit the failed attempt; throwing here would roll it back.
      await client.query('UPDATE account_email_verifications SET attempts = attempts + 1 WHERE user_id = $1', [userId]);
      return null;
    }
    await client.query(`UPDATE users SET email = $1, email_confirmed = TRUE,
      email_confirmed_at = NOW(), password_reset_token_hash = NULL,
      password_reset_expires_at = NULL WHERE id = $2`, [proof.email, userId]);
    await client.query('DELETE FROM account_email_verifications WHERE user_id = $1', [userId]);
    return { email: proof.email, verified: true, passwordRequired: !!user.password_set, recoveryAllowed: !user.is_admin };
  });
  if (!result) throw new AccountEmailError(400, 'Invalid or expired code. Request a new code if needed.');
  return result;
}

module.exports = { AccountEmailError, requestCode, verifyCode };

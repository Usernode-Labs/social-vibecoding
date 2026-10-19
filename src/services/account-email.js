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
  // A newly confirmed address: project invites waiting on it become this
  // account's (services/email-invites.js). Best-effort; never throws.
  await require('./email-invites').claimEmailInvites(pool, { userId, email: result.email });
  // And an account still waiting has its spot on the waitlist now that it
  // has a confirmed address (#4083). Best-effort; never throws.
  await require('./waitlist').ensureAccountSignup(pool, { userId });
  return result;
}

// ── A username change confirmed by email (#5281) ──────────────────────
//
// POST /api/me/username asks for the current password. An account made with
// an emailed code has none (password_set = FALSE and a random hash nobody
// knows), so it could not rename at all. This is its proof instead, and the
// route accepts it ONLY for such an account: one with a password still
// confirms with the password, whatever else it sends.
//
// The same shape as the address proof above: one live code per account in
// its own table (account_username_codes), only its bcrypt hash stored, ten
// minutes, five wrong guesses, a minute between requests. It goes to the
// account's CONFIRMED address and nowhere else, so the request carries no
// address to aim it at. It is bound to that address and to the password hash
// it was minted against, so adding a password or changing the address while
// a code is out makes it worthless. Admin accounts are refused outright:
// they may not sign in or recover by email either, and a rename of one must
// not rest on a mailbox.
const USERNAME_CODE_MAX_ATTEMPTS = 5;

function usernameCodeRefusal(user) {
  if (user.password_set) {
    return new AccountEmailError(409, 'This account has a password. Confirm the change with your password.');
  }
  if (user.is_admin) {
    return new AccountEmailError(409, 'Admin accounts confirm a username change with a password. Add a password first.');
  }
  if (!user.email || !user.email_confirmed) {
    return new AccountEmailError(409, 'Add and verify an email address first, or add a password, to confirm a username change.');
  }
  return null;
}

async function requestUsernameCode(pool, config, userId) {
  const result = await transaction(pool, async (client) => {
    const user = await lockUser(client, userId);
    const refusal = usernameCodeRefusal(user);
    if (refusal) throw refusal;
    const { rows } = await client.query(
      'SELECT created_at > NOW() - INTERVAL \'60 seconds\' AS recent FROM account_username_codes WHERE user_id = $1',
      [userId]
    );
    // A double tap keeps the code already in the inbox (the mail throttle
    // would drop a second send inside the same minute anyway).
    if (rows[0]?.recent) throw new AccountEmailError(429, 'Wait a minute before requesting another code.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await client.query(
      `INSERT INTO account_username_codes
         (user_id, email, code_hash, password_hash, attempts, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '10 minutes', NOW())
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email,
         code_hash = EXCLUDED.code_hash, password_hash = EXCLUDED.password_hash,
         attempts = 0, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
      [userId, user.email, await bcrypt.hash(code, 10), user.password]
    );
    return { code, email: user.email };
  });
  await mail.send(config, { kind: 'username_change', to: result.email, code: result.code });
  return { email: result.email };
}

// Checks the code WITHOUT spending it: the route still has the cooldown and
// the availability check to pass, and a name that turns out to be taken
// should not cost the person a fresh code. A wrong guess is counted and
// committed. Returns the stored hash, which consumeUsernameCode() needs to
// spend exactly this code; throws a 400 for anything else.
async function checkUsernameCode(pool, userId, rawCode) {
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new AccountEmailError(400, 'Enter the six-digit code.');
  const proof = await transaction(pool, async (client) => {
    const user = await lockUser(client, userId);
    const refusal = usernameCodeRefusal(user);
    if (refusal) throw refusal;
    const { rows } = await client.query(
      'SELECT code_hash, email, password_hash, attempts, expires_at > NOW() AS valid FROM account_username_codes WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const row = rows[0];
    if (!row || !row.valid || row.attempts >= USERNAME_CODE_MAX_ATTEMPTS
      || row.password_hash !== user.password || row.email !== user.email) return null;
    if (!await bcrypt.compare(code, row.code_hash)) {
      // Commit the failed attempt; throwing here would roll it back.
      await client.query('UPDATE account_username_codes SET attempts = attempts + 1 WHERE user_id = $1', [userId]);
      return null;
    }
    return { codeHash: row.code_hash };
  });
  if (!proof) throw new AccountEmailError(400, 'Invalid or expired code. Request a new code if needed.');
  return proof;
}

// Spends the code checkUsernameCode() accepted, right before the rename. One
// statement, so two submissions racing with the same code spend it once and
// only the one that did goes on to rename.
async function consumeUsernameCode(pool, userId, codeHash) {
  const { rowCount } = await pool.query(
    `DELETE FROM account_username_codes
      WHERE user_id = $1 AND code_hash = $2 AND expires_at > NOW() AND attempts < $3`,
    [userId, codeHash, USERNAME_CODE_MAX_ATTEMPTS]
  );
  return rowCount === 1;
}

module.exports = {
  AccountEmailError, requestCode, verifyCode,
  requestUsernameCode, checkUsernameCode, consumeUsernameCode,
};

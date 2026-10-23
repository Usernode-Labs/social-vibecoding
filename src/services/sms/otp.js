'use strict';

// Homeroom's own sign-in codes, for when Brevo or Twilio carries the text.
//
// Firebase writes, texts and checks its own codes. Brevo and Twilio only
// carry the message, so when one of them is the selected provider the
// platform makes the
// code, keeps only hashes of it, expires it after ten minutes, allows five
// tries and lets it work once. A row is keyed by the session its client was
// handed; the phone number is in the row, and neither the code nor the
// session is ever stored in the clear.
//
// The prefix is stable and part of the wire contract: firebase-phone-auth.js
// recognises `hr-sms-session.` sessions in exchangeCode so a code issued
// just before a provider switch can still be entered afterwards.

const crypto = require('crypto');

const SESSION_PREFIX = 'hr-sms-session.';
const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CODE_RE = /^[0-9]{6}$/;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Make and store a code for one number. Earlier unconsumed codes for the
 * number are dropped, so requesting again replaces the previous text.
 * Returns { sessionInfo, code } — the code exists only in the text and in
 * this return value; the row holds its hash.
 */
async function issue(pool, phoneNumber, { now = Date.now() } = {}) {
  if (!pool) throw new Error('issue requires a pool');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const sessionInfo = `${SESSION_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  await pool.query(
    'DELETE FROM sms_otp_codes WHERE phone_e164 = $1 AND consumed_at IS NULL',
    [phoneNumber]
  );
  await pool.query(
    `INSERT INTO sms_otp_codes (session_hash, phone_e164, code_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [
      sha256Hex(sessionInfo),
      phoneNumber,
      sha256Hex(`${sessionInfo}:${code}`),
      new Date(now + TTL_MS),
    ]
  );
  return { sessionInfo, code };
}

/**
 * Check a code against its session and spend it. Returns the phone number on
 * a match, null for an unknown session, an expired one, a sixth try or code,
 * or a second use. The attempt count goes up before the comparison, so a
 * brute-force loop gets exactly five.
 */
async function redeem(pool, sessionInfo, code) {
  if (!pool || typeof sessionInfo !== 'string' || !sessionInfo.startsWith(SESSION_PREFIX)) return null;
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (!CODE_RE.test(trimmed)) return null;

  const sessionHash = sha256Hex(sessionInfo);
  const expected = sha256Hex(`${sessionInfo}:${trimmed}`);

  const { rows } = await pool.query(
    `UPDATE sms_otp_codes
        SET attempts = attempts + 1
      WHERE session_hash = $1
        AND consumed_at IS NULL
        AND expires_at > NOW()
        AND attempts < $2
      RETURNING phone_e164, code_hash`,
    [sessionHash, MAX_ATTEMPTS]
  );
  const row = rows[0];
  if (!row || !sameHash(row.code_hash, expected)) return null;

  const spent = await pool.query(
    `UPDATE sms_otp_codes
        SET consumed_at = NOW()
      WHERE session_hash = $1 AND consumed_at IS NULL
      RETURNING phone_e164`,
    [sessionHash]
  );
  return spent.rows[0]?.phone_e164 || null;
}

async function cleanupExpired(pool) {
  await pool.query("DELETE FROM sms_otp_codes WHERE expires_at < NOW() - INTERVAL '1 hour'");
}

module.exports = {
  SESSION_PREFIX,
  TTL_MS,
  MAX_ATTEMPTS,
  issue,
  redeem,
  cleanupExpired,
  sha256Hex,
};

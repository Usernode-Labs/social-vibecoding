'use strict';

/**
 * The failure log behind Admin → SMS delivery's "Recent failures" table
 * (routes/admin.js GET /api/admin/sms/failures): one row per failed phone
 * linking/verification attempt, written from routes/phone-auth.js fail().
 *
 * The table (schema.sql phone_auth_failures) is deliberately narrow —
 * timestamp, kind, user id, the number's last four digits, this API's error
 * code, Firebase's own code when one was given, and the message the caller
 * saw. No phone number, no session material, no body echo: everything an
 * operator needs to say WHICH failure happened and to WHOM, and nothing
 * that widens the table past what its staging:private marking protects.
 *
 * recordFailure is best effort the way cleanupExpired is: a failed insert
 * is logged and swallowed, because a broken failure log must never turn a
 * caller's 422 into a 500, and a missing table (a test schema, a boot mid-
 * migration) must not spam the response path.
 */

const log = require('./logger');

const MESSAGE_MAX = 500; // an internal error's text is bounded, not echoed whole

/**
 * Record one failure. Fields:
 *   kind          'code_request' | 'verify' | 'link_request' | 'link_verify'
 *   userId        the signed-in account, or null (pre-sign-in legs)
 *   phoneLast4    the number's last four digits when this request carried
 *                 or produced one, else null
 *   errorCode     this API's code (PhoneAuthError.code, or 'internal')
 *   providerCode  Firebase's own code when it gave one, else null
 *   message       what the caller was told (or, for 'internal', the error's
 *                 own text, bounded)
 */
async function recordFailure(pool, { kind, userId, phoneLast4, errorCode, providerCode, message }) {
  if (!pool || !kind) return;
  try {
    await pool.query(
      `INSERT INTO phone_auth_failures
         (kind, user_id, phone_last4, error_code, provider_code, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        kind,
        Number.isSafeInteger(userId) && userId > 0 ? userId : null,
        typeof phoneLast4 === 'string' && /^[0-9]{4}$/.test(phoneLast4) ? phoneLast4 : null,
        String(errorCode || 'unknown').slice(0, 100),
        typeof providerCode === 'string' && providerCode ? providerCode.slice(0, 100) : null,
        String(message || '').slice(0, MESSAGE_MAX),
      ]
    );
  } catch (err) {
    log.warn('phone-auth', 'Failure log write failed', { err: err.message });
  }
}

/** The most recent failures, with the account names and a week's total. */
async function recentFailures(pool, limit = 50) {
  const { rows } = await pool.query(
    `SELECT f.id, f.kind, f.user_id, u.username, f.phone_last4,
            f.error_code, f.provider_code, f.message, f.created_at
       FROM phone_auth_failures f
       LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT $1`,
    [limit]
  );
  const { rows: counted } = await pool.query(
    `SELECT count(*)::int AS n
       FROM phone_auth_failures
      WHERE created_at > NOW() - INTERVAL '7 days'`
  );
  return { failures: rows, total7d: counted[0] ? counted[0].n : rows.length };
}

module.exports = { recordFailure, recentFailures, MESSAGE_MAX };
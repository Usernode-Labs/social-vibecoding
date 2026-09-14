'use strict';

const crypto = require('crypto');
const { NativeSessionProtocolError } = require('./native-session-protocol');

// Only the native HTTP owner receives this response. Cookie material must be
// installed in the OS WebView store and removed before replying to JavaScript.
async function restoreNativeWebSession(pool, { userId, auth, currentSessionToken }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same order as establishment/account recovery: user -> web session ->
    // attempt -> credential. The user lock also serializes a missing web row.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const { rows: origins } = await client.query(
      `SELECT web_session_incarnation_id FROM native_session_credentials
        WHERE credential_reference = $1 AND user_id = $2`,
      [auth.credentialReference, userId]
    );
    const incarnation = origins[0]?.web_session_incarnation_id;
    if (!incarnation) throw new NativeSessionProtocolError(401, 'unauthenticated', 'Unauthenticated.');

    const { rows: sessions } = await client.query(
      `SELECT token, user_id, native_session_incarnation_id, expires_at > NOW() AS live
         FROM sessions
        WHERE native_session_incarnation_id = $1 OR token = $2
        ORDER BY token FOR UPDATE`,
      [incarnation, currentSessionToken]
    );
    if (sessions.some((session) => session.token === currentSessionToken && session.live
        && (String(session.user_id) !== String(userId)
          || session.native_session_incarnation_id !== incarnation))) {
      throw new NativeSessionProtocolError(409, 'native_web_session_conflict', 'Another web session is already signed in.');
    }
    await client.query(
      'SELECT attempt_id FROM native_session_attempts WHERE attempt_id = $1 FOR UPDATE',
      [auth.attemptId]
    );
    const { rows: credentials } = await client.query(
      `SELECT c.credential_reference, c.attempt_id, c.expires_at
         FROM native_session_credentials c
         JOIN mobile_auth_tokens t ON t.id = c.mobile_auth_token_id AND t.user_id = c.user_id
        WHERE c.credential_reference = $1 AND c.credential_generation = $2
          AND c.user_id = $3 AND c.mobile_auth_token_id = $4
          AND c.attempt_id = $5 AND c.web_session_incarnation_id = $6
          AND c.state = 'valid' AND c.expires_at > NOW()
          AND t.ability = 'session' AND t.expires_at = c.expires_at
        FOR UPDATE OF c, t`,
      [auth.credentialReference, auth.credentialGeneration, userId, auth.tokenId, auth.attemptId, incarnation]
    );
    if (!credentials.length) throw new NativeSessionProtocolError(401, 'unauthenticated', 'Unauthenticated.');

    // Rotate even if the old row is live. Late requests carrying its token
    // cannot delete or authenticate the newly restored session.
    const token = crypto.randomBytes(32).toString('hex');
    await client.query('DELETE FROM sessions WHERE native_session_incarnation_id = $1', [incarnation]);
    const { rows } = await client.query(
      `INSERT INTO sessions (token, user_id, expires_at, native_session_incarnation_id,
                             native_session_credential_reference)
       VALUES ($1, $2, LEAST(NOW() + INTERVAL '7 days', $3::timestamptz), $4, $5)
       RETURNING expires_at`,
      [token, userId, credentials[0].expires_at, incarnation, auth.credentialReference]
    );
    await client.query('COMMIT');
    return {
      protocol: 2, userId: String(userId), attemptId: auth.attemptId,
      sessionToken: token, expiresAt: new Date(rows[0].expires_at).toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { restoreNativeWebSession };

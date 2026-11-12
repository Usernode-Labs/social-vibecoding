'use strict';

// Callers supply a source-code table alias, never request data. Ordinary web
// sessions retain their existing policy; native-restored sessions cannot
// outlive/recreate revoked native authority on any cookie-authenticated path.
function nativeWebSessionIsLive(alias) {
  return `(${alias}.native_session_credential_reference IS NULL OR EXISTS (
    SELECT 1 FROM native_session_credentials c JOIN mobile_auth_tokens t
      ON t.id = c.mobile_auth_token_id AND t.user_id = c.user_id
     WHERE c.credential_reference = ${alias}.native_session_credential_reference
       AND c.user_id = ${alias}.user_id AND c.state = 'valid' AND c.expires_at > NOW()
       AND t.ability = 'session' AND t.expires_at = c.expires_at
  ))`;
}

/**
 * Does this cookie's token name a session the auth middleware would honour?
 * The session-mint boundary (routes/auth.js SESSION_MINT_PATHS) and the
 * Apple and Google starts (routes/sign-in-providers.js) refuse to sign
 * anybody in over a live session, and must call live exactly what
 * middleware/auth.js does: unexpired, its native authority not revoked, its
 * account not synthetic. They used to read the expiry alone (#6619), so a
 * session whose native credential had been revoked was dead to every read,
 * which signed the person out, yet "already signed in" to every sign-in.
 */
async function sessionTokenIsLive(queryable, token) {
  if (!token) return false;
  const { rows } = await queryable.query(
    `SELECT 1 FROM sessions s
      WHERE s.token = $1 AND s.expires_at > NOW()
        AND ${nativeWebSessionIsLive('s')}
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.is_synthetic)
      LIMIT 1`,
    [token]
  );
  return rows.length > 0;
}

module.exports = { nativeWebSessionIsLive, sessionTokenIsLive };

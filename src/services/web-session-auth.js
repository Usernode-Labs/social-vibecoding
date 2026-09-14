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

module.exports = { nativeWebSessionIsLive };

'use strict';

const REASONS = new Set(['web_logout', 'account_recovery']);

function assertScope({ reason, userId, webSessionIncarnationId }) {
  if (!REASONS.has(reason)) throw new Error('invalid_native_session_revocation_reason');
  if (reason === 'web_logout'
      && (userId == null || typeof webSessionIncarnationId !== 'string')) {
    throw new Error('invalid_native_session_web_logout_scope');
  }
  if (reason === 'account_recovery' && userId == null) {
    throw new Error('invalid_native_session_account_recovery_scope');
  }
}

// One explicit revocation boundary for every protocol-2 close path. Callers
// must already be inside the transaction that owns their authentication row
// lock (exact cookie session or account recovery's user lock). Attempts are
// updated before credentials, matching exchange's
// attempt -> credential lock order and making retry/revocation linearizable.
async function revokeNativeSessionCredentials(client, scope) {
  assertScope(scope);
  const {
    reason, userId = null, webSessionIncarnationId = null,
  } = scope;

  let attemptResult;
  if (reason === 'web_logout') {
    attemptResult = await client.query(
      `UPDATE native_session_attempts
          SET state = 'revoked', updated_at = NOW()
        WHERE user_id = $1 AND web_session_incarnation_id = $2
          AND state IN ('ticketed', 'exchanged')
        RETURNING attempt_id`,
      [userId, webSessionIncarnationId]
    );
  } else {
    attemptResult = await client.query(
      `UPDATE native_session_attempts
          SET state = 'revoked', updated_at = NOW()
        WHERE user_id = $1
          AND state IN ('ticketed', 'exchanged')
        RETURNING attempt_id`,
      [userId]
    );
  }
  const { rows: attemptRows } = attemptResult;
  const attemptIds = attemptRows.map((row) => row.attempt_id);

  if (attemptIds.length) {
    await client.query(
      `UPDATE native_session_tickets
          SET state = 'revoked'
        WHERE attempt_id = ANY($1::varchar[])
          AND state IN ('issued', 'exchanged')`,
      [attemptIds]
    );
  }

  let credentialResult;
  if (reason === 'web_logout') {
    credentialResult = await client.query(
      `UPDATE native_session_credentials
          SET state = 'revoked', revocation_reason = 'web_logout', revoked_at = NOW()
        WHERE user_id = $1 AND web_session_incarnation_id = $2
          AND state = 'valid'
        RETURNING credential_reference, mobile_auth_token_id`,
      [userId, webSessionIncarnationId]
    );
  } else {
    credentialResult = await client.query(
      `UPDATE native_session_credentials
          SET state = 'revoked', revocation_reason = 'account_recovery', revoked_at = NOW()
        WHERE user_id = $1 AND state = 'valid'
        RETURNING credential_reference, mobile_auth_token_id`,
      [userId]
    );
  }
  const { rows: credentialRows } = credentialResult;

  const tokenIds = credentialRows
    .map((row) => row.mobile_auth_token_id)
    .filter((id) => id != null);
  if (tokenIds.length) {
    await client.query(
      'DELETE FROM mobile_auth_tokens WHERE id = ANY($1::bigint[])',
      [[...new Set(tokenIds.map(String))]]
    );
  }

  const credentialReferences = credentialRows
    .map((row) => row.credential_reference)
    .filter((reference) => typeof reference === 'string');
  if (credentialReferences.length) {
    await client.query(
      `UPDATE mobile_push_registrations
          SET session_expires_at = LEAST(session_expires_at, NOW()),
              updated_at = NOW()
        WHERE native_session_credential_reference = ANY($1::varchar[])`,
      [[...new Set(credentialReferences)]]
    );
  }

  return {
    attemptsRevoked: attemptIds.length,
    credentialsRevoked: credentialRows.length,
  };
}

module.exports = { revokeNativeSessionCredentials };

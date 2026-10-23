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

// Mobile explicit logout carries only the bearer that names one exact native
// credential. Keep this boundary narrower than web logout: another credential
// for the same account or web incarnation is not authority to revoke here.
async function revokeExactNativeSessionCredential(client, {
  userId,
  attemptId,
  credentialReference,
  credentialGeneration,
  mobileAuthTokenId,
}) {
  if (userId == null
      || typeof attemptId !== 'string'
      || typeof credentialReference !== 'string'
      || !Number.isSafeInteger(credentialGeneration)
      || credentialGeneration <= 0
      || mobileAuthTokenId == null) {
    throw new Error('invalid_exact_native_session_revocation_scope');
  }

  // Preserve establishment's attempt -> ticket -> credential lock order.
  await client.query(
    `UPDATE native_session_attempts
        SET state = 'revoked', updated_at = NOW()
      WHERE attempt_id = $1 AND user_id = $2
        AND state IN ('ticketed', 'exchanged')`,
    [attemptId, userId]
  );
  await client.query(
    `UPDATE native_session_tickets
        SET state = 'revoked'
      WHERE attempt_id = $1
        AND state IN ('issued', 'exchanged')`,
    [attemptId]
  );

  const { rows } = await client.query(
    `UPDATE native_session_credentials
        SET state = 'revoked', revocation_reason = 'web_logout', revoked_at = NOW()
      WHERE credential_reference = $1
        AND credential_generation = $2
        AND user_id = $3
        AND attempt_id = $4
        AND mobile_auth_token_id = $5
        AND state = 'valid'
      RETURNING credential_reference`,
    [
      credentialReference,
      credentialGeneration,
      userId,
      attemptId,
      mobileAuthTokenId,
    ]
  );

  if (rows.length) {
    await client.query(
      `UPDATE mobile_push_registrations
          SET session_expires_at = LEAST(session_expires_at, NOW()),
              updated_at = NOW()
        WHERE native_session_credential_reference = $1`,
      [credentialReference]
    );
    await client.query(
      `DELETE FROM mobile_auth_tokens
        WHERE id = $1 AND user_id = $2`,
      [mobileAuthTokenId, userId]
    );
  }

  return { credentialRevoked: rows.length === 1 };
}

// #4938: Settings › Linked phones unlinks one phone, which is one native
// installation of this exact account. Every still-valid credential the
// account holds on that installation is revoked; another account on the same
// phone, and the account's other phones, are untouched. The caller is the
// signed-in web session acting on its own account, so the closed reason is
// the web's (as the native app's own logout uses it). The revoked credential
// also ends any web session restored from it (web-session-auth.js).
async function revokeInstallationNativeSessionCredentials(client, {
  userId,
  installationId,
}) {
  if (userId == null || typeof installationId !== 'string' || !installationId) {
    throw new Error('invalid_installation_native_session_revocation_scope');
  }

  // Attempts first, then tickets, then credentials: establishment's order.
  const { rows: attemptRows } = await client.query(
    `UPDATE native_session_attempts a
        SET state = 'revoked', updated_at = NOW()
       FROM native_session_credentials c
      WHERE c.attempt_id = a.attempt_id
        AND c.user_id = $1 AND c.installation_id = $2 AND c.state = 'valid'
        AND a.user_id = $1
        AND a.state IN ('ticketed', 'exchanged')
      RETURNING a.attempt_id`,
    [userId, installationId]
  );
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

  const { rows: credentialRows } = await client.query(
    `UPDATE native_session_credentials
        SET state = 'revoked', revocation_reason = 'web_logout', revoked_at = NOW()
      WHERE user_id = $1 AND installation_id = $2 AND state = 'valid'
      RETURNING credential_reference, mobile_auth_token_id`,
    [userId, installationId]
  );

  const tokenIds = credentialRows
    .map((row) => row.mobile_auth_token_id)
    .filter((id) => id != null);
  if (tokenIds.length) {
    await client.query(
      'DELETE FROM mobile_auth_tokens WHERE id = ANY($1::bigint[]) AND user_id = $2',
      [[...new Set(tokenIds.map(String))], userId]
    );
  }

  const credentialReferences = credentialRows.map((row) => row.credential_reference);
  if (credentialReferences.length) {
    await client.query(
      `UPDATE mobile_push_registrations
          SET session_expires_at = LEAST(session_expires_at, NOW()),
              updated_at = NOW()
        WHERE native_session_credential_reference = ANY($1::varchar[])
          AND user_id = $2`,
      [[...new Set(credentialReferences)], userId]
    );
  }

  return { credentialsRevoked: credentialRows.length };
}

module.exports = {
  revokeNativeSessionCredentials,
  revokeExactNativeSessionCredential,
  revokeInstallationNativeSessionCredentials,
};

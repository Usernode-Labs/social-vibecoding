'use strict';

const crypto = require('crypto');
const { iso } = require('../../routes/topochain/helpers');
const {
  PROTOCOL,
  AUDIENCE,
  DESIRED_RUNTIME,
  TICKET_TTL_MS,
  CREDENTIAL_TTL_MS,
  ticketRequestSchema,
  exchangeRequestSchema,
  sha256Hex,
  makeOpaque,
  ticketRequestDigest,
  validateInstallationKeys,
  exchangeSemanticDigest,
  verifyPossessionProof,
  compactEncryptCredential,
  sealReplay,
  openReplay,
} = require('./native-session-crypto');

class NativeSessionProtocolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'NativeSessionProtocolError';
    this.status = status;
    this.code = code;
  }
}

function protocolError(status, code, message) {
  throw new NativeSessionProtocolError(status, code, message);
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function exactAttempt(row, expected) {
  return row
    && row.attempt_id === expected.attemptId
    && Number(row.protocol) === PROTOCOL
    && String(row.user_id) === String(expected.userId)
    && row.web_session_incarnation_id === expected.webSessionIncarnationId
    && row.desired_runtime === DESIRED_RUNTIME
    && row.network_id === expected.network.id
    && row.chain_id === expected.network.chainId
    && row.request_digest === expected.requestDigest;
}

function exactInstallation(row, { installation, keys, userId }) {
  if (!row) return false;
  const possession = row.possession_public_jwk || {};
  const envelope = row.envelope_public_jwk || {};
  return row.installation_id === installation.id
    && Number(row.key_generation) === installation.keyGeneration
    && String(row.user_id) === String(userId)
    && row.possession_key_id === keys.possessionKeyId
    && row.possession_key_thumbprint === keys.possessionKeyThumbprint
    && possession.kty === keys.possessionJwk.kty
    && possession.crv === keys.possessionJwk.crv
    && possession.x === keys.possessionJwk.x
    && possession.y === keys.possessionJwk.y
    && row.envelope_key_id === keys.envelopeKeyId
    && row.envelope_key_thumbprint === keys.envelopeKeyThumbprint
    && envelope.kty === keys.envelopeJwk.kty
    && envelope.n === keys.envelopeJwk.n
    && envelope.e === keys.envelopeJwk.e;
}

function ensureExchangeTuple(row, request, ticketHash, network) {
  if (!row) protocolError(401, 'invalid_native_session_ticket', 'Invalid native session ticket.');
  if (row.attempt_id !== request.attemptId
      || row.desired_runtime !== request.desiredRuntime
      || row.request_digest !== request.requestDigest
      || row.ticket_hash !== ticketHash
      || row.network_id !== network.id
      || row.chain_id !== network.chainId) {
    protocolError(409, 'native_session_attempt_conflict', 'The native session attempt does not match its original request.');
  }
}

async function loadExchange(client, ticketHash, { lock = false } = {}) {
  const result = lock
    ? await client.query(
      `SELECT a.attempt_id, a.protocol, a.user_id, a.web_session_incarnation_id,
              a.desired_runtime, a.network_id, a.chain_id, a.request_digest,
              a.state AS attempt_state,
              t.id AS ticket_id, t.ticket_hash, t.exchange_challenge,
              t.state AS ticket_state, t.issued_at, t.expires_at
         FROM native_session_tickets t
         JOIN native_session_attempts a ON a.attempt_id = t.attempt_id
        WHERE t.ticket_hash = $1
        FOR UPDATE OF a, t`,
      [ticketHash]
    )
    : await client.query(
      `SELECT a.attempt_id, a.protocol, a.user_id, a.web_session_incarnation_id,
              a.desired_runtime, a.network_id, a.chain_id, a.request_digest,
              a.state AS attempt_state,
              t.id AS ticket_id, t.ticket_hash, t.exchange_challenge,
              t.state AS ticket_state, t.issued_at, t.expires_at
         FROM native_session_tickets t
         JOIN native_session_attempts a ON a.attempt_id = t.attempt_id
        WHERE t.ticket_hash = $1`,
      [ticketHash]
    );
  const { rows } = result;
  return rows[0] || null;
}

async function replayExchange(client, { row, request, keys, exchangeDigest, config }) {
  const { rows } = await client.query(
    `SELECT c.credential_reference, c.credential_generation,
            c.exchange_request_digest, c.state,
            c.installation_id, c.installation_key_generation, c.expires_at,
            e.encrypted_response, e.response_digest
       FROM native_session_credentials c
       JOIN native_session_credential_envelopes e
         ON e.credential_reference = c.credential_reference
      WHERE c.attempt_id = $1
      FOR UPDATE OF c, e`,
    [request.attemptId]
  );
  const credential = rows[0];
  if (!credential || credential.state !== 'valid') {
    protocolError(409, 'native_session_credential_revoked', 'The native session credential is no longer valid.');
  }
  if (new Date(credential.expires_at) <= new Date()) {
    protocolError(410, 'native_session_credential_expired', 'The native session credential has expired.');
  }
  if (credential.exchange_request_digest !== exchangeDigest
      || credential.installation_id !== request.installation.id
      || Number(credential.installation_key_generation) !== request.installation.keyGeneration) {
    protocolError(409, 'native_session_attempt_conflict', 'The native session attempt does not match its original exchange.');
  }

  const { rows: keyRows } = await client.query(
    `SELECT installation_id, key_generation, user_id,
            possession_key_id, possession_key_thumbprint, possession_public_jwk,
            envelope_key_id, envelope_key_thumbprint, envelope_public_jwk
       FROM native_installation_key_generations
      WHERE installation_id = $1 AND key_generation = $2`,
    [request.installation.id, request.installation.keyGeneration]
  );
  if (!exactInstallation(keyRows[0], { installation: request.installation, keys, userId: row.user_id })) {
    protocolError(409, 'native_session_installation_conflict', 'The installation key generation is already bound to different keys.');
  }

  return openReplay({
    kind: 'exchange',
    key: credential.credential_reference,
    encryptedResponse: credential.encrypted_response,
    responseDigest: credential.response_digest,
    dataEncryptionKey: config.dataEncryptionKey,
  });
}

async function provisionWallet(client, userId) {
  const { rows: seasonRows } = await client.query(
    `SELECT id FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
        AND starts_at <= NOW() AND ends_at >= NOW()
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  if (!seasonRows.length) {
    protocolError(422, 'native_session_no_active_season', 'No active season is available.');
  }
  const seasonId = Number(seasonRows[0].id);

  const { rows: existingRows } = await client.query(
    `SELECT id, address, public_key, secret_key, season_event_id
       FROM onchain_accounts
      WHERE user_id = $1 AND season_id = $2
      ORDER BY (season_event_id IS NULL) DESC, id ASC
      LIMIT 1`,
    [userId, seasonId]
  );
  let account = existingRows[0] || null;
  let newlyAllocated = false;
  if (!account) {
    const { rows: availableRows } = await client.query(
      `SELECT id, address, public_key, secret_key, season_event_id
         FROM onchain_accounts
        WHERE user_id IS NULL AND is_used = FALSE
          AND season_id = $1 AND season_event_id IS NULL
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [seasonId]
    );
    if (!availableRows.length) {
      protocolError(409, 'native_session_wallet_pool_exhausted', 'No on-chain accounts are available for the current season.');
    }
    account = availableRows[0];
    await client.query(
      `UPDATE onchain_accounts
          SET user_id = $1, is_used = TRUE, used_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [userId, account.id]
    );
    newlyAllocated = true;
  }

  await client.query(
    `INSERT INTO user_enrollments
       (season_event_id, user_id, season_id, registered_at, created_at, updated_at)
     SELECT NULL, $1, $2, NOW(), NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM user_enrollments
         WHERE user_id = $1 AND season_id = $2
      )
     ON CONFLICT DO NOTHING`,
    [userId, seasonId]
  );
  return { ...account, seasonId, newlyAllocated };
}

function buildCredentialPlaintext({
  row, request, keys, ticketHash, exchangeDigest, credentialReference,
  bearerToken, bearerExpiresAt, account, bpReleased,
}) {
  return {
    protocol: PROTOCOL,
    attemptId: request.attemptId,
    ticketRequestDigest: request.requestDigest,
    exchangeRequestDigest: exchangeDigest,
    ticketHash,
    subject: { userId: String(row.user_id) },
    network: { id: row.network_id, chainId: row.chain_id },
    installation: {
      id: request.installation.id,
      keyGeneration: request.installation.keyGeneration,
      possessionKeyId: keys.possessionKeyId,
      possessionKeyThumbprint: keys.possessionKeyThumbprint,
      envelopeKeyId: keys.envelopeKeyId,
      envelopeKeyThumbprint: keys.envelopeKeyThumbprint,
    },
    credential: {
      reference: credentialReference,
      generation: 1,
      bearerToken,
      bearerExpiresAt: iso(bearerExpiresAt),
    },
    account: {
      address: account.address,
      publicKey: account.public_key,
      secretKey: account.secret_key,
      seasonId: account.seasonId,
      seasonEventId: account.season_event_id == null ? null : Number(account.season_event_id),
      newlyAllocated: account.newlyAllocated,
      blockProductionReleased: bpReleased,
    },
  };
}

class NativeSessionProtocol {
  constructor({ pool, config, now = () => new Date() }) {
    this.pool = pool;
    this.config = config;
    this.now = now;
  }

  get enabled() {
    return !!(this.config.nativeSessionV2Network && this.config.dataEncryptionKey);
  }

  async createTicket({ sessionToken, body }) {
    const parsed = ticketRequestSchema.safeParse(body);
    if (!parsed.success) {
      protocolError(422, 'invalid_native_session_ticket_request', 'The native session ticket request is invalid.');
    }
    if (!sessionToken) protocolError(401, 'unauthenticated', 'Unauthenticated.');
    const request = parsed.data;
    const network = this.config.nativeSessionV2Network;

    return withTransaction(this.pool, async (client) => {
      const now = this.now();
      const { rows: sessionRows } = await client.query(
        `SELECT token, user_id, native_session_incarnation_id
           FROM sessions
          WHERE token = $1 AND expires_at >= $2
          FOR UPDATE`,
        [sessionToken, now]
      );
      const session = sessionRows[0];
      if (!session) protocolError(401, 'unauthenticated', 'Unauthenticated.');

      let incarnationId = session.native_session_incarnation_id;
      if (!incarnationId) {
        incarnationId = makeOpaque('nsw_');
        await client.query(
          `INSERT INTO native_session_web_incarnations (id, user_id, created_at)
           VALUES ($1, $2, $3)`,
          [incarnationId, session.user_id, now]
        );
        await client.query(
          `UPDATE sessions SET native_session_incarnation_id = $1 WHERE token = $2`,
          [incarnationId, sessionToken]
        );
      }

      const requestDigest = ticketRequestDigest({
        attemptId: request.attemptId,
        userId: session.user_id,
        webSessionIncarnationId: incarnationId,
        network,
      });

      await client.query(
        `INSERT INTO native_session_attempts
           (attempt_id, protocol, user_id, web_session_incarnation_id,
            desired_runtime, network_id, chain_id, request_digest,
            state, created_at, updated_at)
         VALUES ($1, 2, $2, $3, 'running', $4, $5, $6, 'ticketed', $7, $7)
         ON CONFLICT (attempt_id) DO NOTHING`,
        [request.attemptId, session.user_id, incarnationId,
          network.id, network.chainId, requestDigest, now]
      );
      const { rows: attemptRows } = await client.query(
        `SELECT attempt_id, protocol, user_id, web_session_incarnation_id,
                desired_runtime, network_id, chain_id, request_digest, state
           FROM native_session_attempts WHERE attempt_id = $1 FOR UPDATE`,
        [request.attemptId]
      );
      const attempt = attemptRows[0];
      if (!exactAttempt(attempt, {
        attemptId: request.attemptId,
        userId: session.user_id,
        webSessionIncarnationId: incarnationId,
        network,
        requestDigest,
      })) {
        protocolError(409, 'native_session_attempt_conflict', 'The native session attempt is already bound to a different request.');
      }
      if (attempt.state === 'revoked') {
        protocolError(409, 'native_session_attempt_revoked', 'The native session attempt is no longer valid.');
      }

      const { rows: ticketRows } = await client.query(
        `SELECT ticket_hash, encrypted_response, response_digest, state, expires_at
           FROM native_session_tickets WHERE attempt_id = $1 FOR UPDATE`,
        [request.attemptId]
      );
      const existing = ticketRows[0];
      if (existing) {
        if (existing.state === 'revoked') {
          protocolError(409, 'native_session_attempt_revoked', 'The native session attempt is no longer valid.');
        }
        // A committed exact attempt is a durable retry key, not a request to
        // mint another credential. Its encrypted byte-exact ticket response
        // remains replayable after the issuance window; the exchange replay
        // still enforces credential validity and revocation. An unexchanged
        // expired ticket stays terminal.
        if (new Date(existing.expires_at) <= now &&
            attempt.state !== 'exchanged') {
          protocolError(410, 'native_session_ticket_expired', 'The native session ticket has expired.');
        }
        return openReplay({
          kind: 'ticket',
          key: request.attemptId,
          encryptedResponse: existing.encrypted_response,
          responseDigest: existing.response_digest,
          dataEncryptionKey: this.config.dataEncryptionKey,
        });
      }

      const ticket = makeOpaque('nst_');
      const ticketHash = sha256Hex(ticket);
      const exchangeChallenge = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + TICKET_TTL_MS);
      const rawJson = JSON.stringify({
        success: true,
        data: {
          protocol: PROTOCOL,
          attemptId: request.attemptId,
          desiredRuntime: DESIRED_RUNTIME,
          ticket,
          requestDigest,
          exchangeChallenge,
          network,
          issuedAt: iso(now),
          expiresAt: iso(expiresAt),
        },
      });
      const sealed = sealReplay({
        kind: 'ticket', key: request.attemptId, rawJson,
        dataEncryptionKey: this.config.dataEncryptionKey,
      });
      await client.query(
        `INSERT INTO native_session_tickets
           (attempt_id, ticket_hash, exchange_challenge, audience,
            encrypted_response, response_digest, state, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'issued', $7, $8)`,
        [request.attemptId, ticketHash, exchangeChallenge, AUDIENCE,
          sealed.encryptedResponse, sealed.responseDigest, now, expiresAt]
      );
      return rawJson;
    });
  }

  async exchange({ body }) {
    const parsed = exchangeRequestSchema.safeParse(body);
    if (!parsed.success) {
      protocolError(422, 'invalid_native_session_exchange_request', 'The native session exchange request is invalid.');
    }
    const request = parsed.data;
    let keys;
    try {
      keys = validateInstallationKeys(request.installation);
    } catch {
      protocolError(422, 'invalid_native_session_installation_keys', 'The native session installation keys are invalid.');
    }
    const ticketHash = sha256Hex(request.ticket);
    const exchangeDigest = exchangeSemanticDigest(request, keys);
    const network = this.config.nativeSessionV2Network;

    return withTransaction(this.pool, async (client) => {
      let row = await loadExchange(client, ticketHash);
      ensureExchangeTuple(row, request, ticketHash, network);

      if (row.attempt_state === 'exchanged') {
        row = await loadExchange(client, ticketHash, { lock: true });
        ensureExchangeTuple(row, request, ticketHash, network);
        if (!verifyPossessionProof({
          request, keys, ticketHash, exchangeChallenge: row.exchange_challenge, network,
        })) {
          protocolError(401, 'invalid_native_session_possession_proof', 'Invalid installation proof.');
        }
        return replayExchange(client, {
          row, request, keys, exchangeDigest, config: this.config,
        });
      }

      // Lock order is user -> exact live web session -> attempt/ticket. Account
      // recovery uses the same user-first order; web logout locks the session
      // then credentials and never takes the user lock. This makes exchange
      // and both close paths serialize without a late credential crossing the
      // close boundary.
      const { rows: userRows } = await client.query(
        'SELECT id, bp_released_at FROM users WHERE id = $1 FOR UPDATE',
        [row.user_id]
      );
      if (!userRows.length) protocolError(401, 'unauthenticated', 'Unauthenticated.');
      const now = this.now();
      const { rows: liveSessionRows } = await client.query(
        `SELECT token FROM sessions
          WHERE native_session_incarnation_id = $1
            AND user_id = $2 AND expires_at >= $3
          FOR KEY SHARE`,
        [row.web_session_incarnation_id, row.user_id, now]
      );

      row = await loadExchange(client, ticketHash, { lock: true });
      ensureExchangeTuple(row, request, ticketHash, network);
      if (row.attempt_state === 'exchanged') {
        if (!verifyPossessionProof({
          request, keys, ticketHash, exchangeChallenge: row.exchange_challenge, network,
        })) {
          protocolError(401, 'invalid_native_session_possession_proof', 'Invalid installation proof.');
        }
        return replayExchange(client, {
          row, request, keys, exchangeDigest, config: this.config,
        });
      }
      if (!liveSessionRows.length) protocolError(401, 'unauthenticated', 'Unauthenticated.');
      if (row.attempt_state === 'revoked' || row.ticket_state === 'revoked') {
        protocolError(409, 'native_session_attempt_revoked', 'The native session attempt is no longer valid.');
      }
      if (new Date(row.expires_at) <= now) {
        protocolError(410, 'native_session_ticket_expired', 'The native session ticket has expired.');
      }
      if (!verifyPossessionProof({
        request, keys, ticketHash, exchangeChallenge: row.exchange_challenge, network,
      })) {
        protocolError(401, 'invalid_native_session_possession_proof', 'Invalid installation proof.');
      }

      await client.query(
        `INSERT INTO native_installation_key_generations
           (installation_id, key_generation, user_id,
            possession_key_id, possession_key_thumbprint, possession_public_jwk,
            envelope_key_id, envelope_key_thumbprint, envelope_public_jwk,
            created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10)
         ON CONFLICT DO NOTHING`,
        [request.installation.id, request.installation.keyGeneration, row.user_id,
          keys.possessionKeyId, keys.possessionKeyThumbprint, JSON.stringify(keys.possessionJwk),
          keys.envelopeKeyId, keys.envelopeKeyThumbprint, JSON.stringify(keys.envelopeJwk), now]
      );
      const { rows: installationRows } = await client.query(
        `SELECT installation_id, key_generation, user_id,
                possession_key_id, possession_key_thumbprint, possession_public_jwk,
                envelope_key_id, envelope_key_thumbprint, envelope_public_jwk
           FROM native_installation_key_generations
          WHERE installation_id = $1 AND key_generation = $2
          FOR UPDATE`,
        [request.installation.id, request.installation.keyGeneration]
      );
      if (!exactInstallation(installationRows[0], {
        installation: request.installation, keys, userId: row.user_id,
      })) {
        protocolError(409, 'native_session_installation_conflict', 'The installation key generation is already bound to different keys.');
      }

      const account = await provisionWallet(client, row.user_id);
      const bearerToken = crypto.randomBytes(40).toString('hex');
      const bearerHash = sha256Hex(bearerToken);
      const bearerExpiresAt = new Date(now.getTime() + CREDENTIAL_TTL_MS);
      const { rows: tokenRows } = await client.query(
        `INSERT INTO mobile_auth_tokens
           (user_id, token_hash, ability, expires_at, created_at)
         VALUES ($1, $2, 'session', $3, $4)
         RETURNING id`,
        [row.user_id, bearerHash, bearerExpiresAt, now]
      );
      const mobileTokenId = tokenRows[0]?.id;
      if (mobileTokenId == null) throw new Error('native_session_mobile_token_insert_failed');

      const credentialReference = makeOpaque('nsc_');
      const credentialPlaintext = buildCredentialPlaintext({
        row, request, keys, ticketHash, exchangeDigest, credentialReference,
        bearerToken, bearerExpiresAt, account,
        bpReleased: !!userRows[0].bp_released_at,
      });
      const compactJwe = await compactEncryptCredential(credentialPlaintext, keys);
      const rawJson = JSON.stringify({
        success: true,
        data: {
          protocol: PROTOCOL,
          attemptId: request.attemptId,
          requestDigest: request.requestDigest,
          credentialReference,
          credentialGeneration: 1,
          envelope: {
            format: 'compact-jwe',
            algorithm: 'RSA-OAEP',
            encryption: 'A256GCM',
            keyId: keys.envelopeKeyId,
            compactJwe,
          },
        },
      });
      const sealed = sealReplay({
        kind: 'exchange', key: credentialReference, rawJson,
        dataEncryptionKey: this.config.dataEncryptionKey,
      });

      await client.query(
        `INSERT INTO native_session_credentials
           (credential_reference, credential_generation, attempt_id, user_id,
            web_session_incarnation_id, installation_id,
            installation_key_generation, mobile_auth_token_id, account_id,
            network_id, chain_id, exchange_request_digest, state,
            created_at, expires_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, 'valid', $12, $13)`,
        [credentialReference, request.attemptId, row.user_id,
          row.web_session_incarnation_id, request.installation.id,
          request.installation.keyGeneration, mobileTokenId, account.id,
          row.network_id, row.chain_id, exchangeDigest, now, bearerExpiresAt]
      );
      await client.query(
        `INSERT INTO native_session_credential_envelopes
           (credential_reference, compact_jwe, compact_jwe_digest,
            encrypted_response, response_digest, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [credentialReference, compactJwe, sha256Hex(compactJwe),
          sealed.encryptedResponse, sealed.responseDigest, now]
      );
      await client.query(
        `UPDATE native_session_tickets SET state = 'exchanged'
          WHERE attempt_id = $1 AND state = 'issued'`,
        [request.attemptId]
      );
      await client.query(
        `UPDATE native_session_attempts
            SET state = 'exchanged', updated_at = $2
          WHERE attempt_id = $1 AND state = 'ticketed'`,
        [request.attemptId, now]
      );
      return rawJson;
    });
  }
}

module.exports = {
  NativeSessionProtocol,
  NativeSessionProtocolError,
  withTransaction,
  exactAttempt,
  exactInstallation,
  provisionWallet,
  buildCredentialPlaintext,
};

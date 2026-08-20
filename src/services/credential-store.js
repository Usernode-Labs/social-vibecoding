'use strict';

// Generic user AI credential store (plan.md PR2).
//
// Generalizes users.anthropic_key_enc/_last4 so a second provider
// (openrouter) can be stored without stacking another pair of columns.
// One row per (user_id, provider, purpose):
//
//   provider = 'anthropic' | 'openrouter'
//   purpose  = 'coding_agent' | 'app_llm'
//
// For this feature the new credential is provider='openrouter',
// purpose='coding_agent'. The encryption envelope is unchanged
// (src/services/secrets.js AES-256-GCM keyed by config.dataEncryptionKey),
// so Anthropic ciphertext was copied into the generic table without
// decrypt/re-encrypt (see schema backfill).
//
// Security contract (applies to every consumer):
//   - Only rows with status === 'valid' are usable; unverified / invalid
//     / revoked rows never yield a secret.
//   - Revocation is authoritative: once a row is 'revoked' (tombstoned),
//     the secret is unrecoverable and NEVER falls back to legacy storage,
//     even if stale legacy ciphertext remains.
//   - Legacy dual-writes are ATOMIC with the generic write: they run in
//     one transaction on one connection, so a failure cannot leave the two
//     stores split, and failures are propagated to the caller (never
//     swallowed into a "success").

const crypto = require('crypto');
const log = require('./logger');
const secrets = require('./secrets');

const PROVIDERS = ['anthropic', 'openrouter'];
const PURPOSES = ['coding_agent', 'app_llm'];
// Supported status values. Only 'valid' is usable; the rest are explicitly
// non-usable states we constrain at the store boundary.
const VALID_STATUS = 'valid';
const REVOKED_STATUS = 'revoked';
const SUPPORTED_STATUSES = [VALID_STATUS, REVOKED_STATUS, 'unverified', 'invalid', 'expired', 'disabled'];

// Legacy column pair that the Anthropic coding-agent credential predates.
const LEGACY_ANTHROPIC_COLUMNS = {
  secretEnc: 'anthropic_key_enc',
  secretLast4: 'anthropic_key_last4',
};

function assertProviderPurpose(provider, purpose) {
  if (!PROVIDERS.includes(provider)) throw new Error(`credential-store: unknown provider ${provider}`);
  if (!PURPOSES.includes(purpose)) throw new Error(`credential-store: unknown purpose ${purpose}`);
}

function assertStatus(status) {
  if (!SUPPORTED_STATUSES.includes(status)) {
    throw new Error(`credential-store: unsupported status ${status}`);
  }
}

// Server-side HMAC fingerprint for audit/correlation, never returned to
// clients. Derived from config.dataEncryptionKey so it stays keyed on
// server material the same way the envelope is (a dedicated fingerprint
// key env var can replace this in a later version without a rotation).
function fingerprint(plaintext, dataKey) {
  if (!dataKey) throw new Error('credential-store: dataEncryptionKey required');
  return crypto
    .createHmac('sha256', String(dataKey))
    .update(String(plaintext))
    .digest('hex');
}

// ── Transaction helper ────────────────────────────────────────────────
// Runs `fn(client)` inside a single transaction on a checked-out
// connection, committing on success and rolling back + rethrowing on any
// failure. Guarantees the generic and legacy writes are atomic.

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Generic CRUD (canonical source) ───────────────────────────────────

// Upsert a credential row for (provider, purpose) on a specific client.
// `status` defaults to 'valid' only when verification has happened;
// callers that store an unverified key pass 'unverified' explicitly so
// verified_at stays NULL and the row is not usable until verified.
// `verifiedAt` (default: now) is applied only for verified writes.
async function upsertOnClient({ client, userId, provider, purpose, secretEnc, secretLast4, secretFingerprint, status = VALID_STATUS, verified = true }) {
  assertProviderPurpose(provider, purpose);
  assertStatus(status);
  // Terminal state: a revocation tombstone must only be written through
  // revoke() (which clears credential material and sets revoked_at). An
  // upsert accepting status='revoked' would store the supplied
  // ciphertext/fingerprint and clear revoked_at, resurrecting material on
  // a row that is supposed to be dead (review F4).
  if (status === REVOKED_STATUS) {
    throw new Error('credential-store: revoked status must be written via revoke()');
  }
  if (!userId) throw new Error('credential-store: userId required');
  if (typeof secretEnc !== 'string') throw new Error('credential-store: secretEnc required');

  // status and verified must agree. A row with status='valid' is usable by
  // readSecret (which keys only on status), so verified=false with
  // status=valid would leave a usable secret with no verified_at. Derive
  // the pair: only 'valid' is verified, and verified_at is set only then
  // (review P2 status/verified coupling).
  if (status === VALID_STATUS && verified === false) {
    throw new Error('credential-store: status=valid requires verified=true');
  }
  const isVerified = status === VALID_STATUS;
  const verifiedAtExpr = isVerified ? 'NOW()' : 'NULL';
  // Prefer the derived status when a caller passes a mismatched verified
  // flag on a non-valid status (verified=true + unverified is nonsensical).
  if (verified === true && status !== VALID_STATUS) {
    throw new Error('credential-store: verified=true requires status=valid');
  }
  const { rows } = await client.query(
    `INSERT INTO credentials.user_ai_credentials
       (user_id, provider, purpose, secret_enc, secret_last4, secret_fingerprint, status, verified_at, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${verifiedAtExpr}, 1)
     ON CONFLICT (user_id, provider, purpose) DO UPDATE SET
       secret_enc = EXCLUDED.secret_enc,
       secret_last4 = EXCLUDED.secret_last4,
       secret_fingerprint = EXCLUDED.secret_fingerprint,
       status = EXCLUDED.status,
       verified_at = EXCLUDED.verified_at,
       revoked_at = NULL,
       revision = credentials.user_ai_credentials.revision + 1,
       updated_at = NOW()
     RETURNING id, revision, status, secret_last4`,
    [userId, provider, purpose, secretEnc, secretLast4, secretFingerprint || null, status]
  );
  return rows[0] || null;
}

// Public upsert for providers that have no dual-write legacy path (e.g.
// openrouter). Anthropic coding-agent credentials MUST go through
// writeAnthropicCodingAgent so the legacy users.anthropic_key_* columns
// stay in lockstep — a bare upsert would leave two different active
// secrets (review P2 dual-write bypass).
async function upsert(opts) {
  const { provider, purpose } = opts;
  if (provider === 'anthropic' && purpose === 'coding_agent') {
    throw new Error(
      'credential-store: anthropic/coding_agent must use writeAnthropicCodingAgent()'
    );
  }
  const { pool } = opts;
  return withTransaction(pool, (client) => upsertOnClient({ client, ...opts }));
}

// Managed OpenRouter provisioning needs the encrypted credential write and
// its ownership metadata in the same transaction as the managed-key record.
// Keeping this helper here avoids duplicating the encryption/fingerprint
// contract in the provisioning service.
async function writeOpenRouterCodingAgentOnClient({
  client, userId, apiKey, dataKey, metadata = {},
}) {
  const encrypted = secrets.encrypt(apiKey, dataKey);
  const saved = await upsertOnClient({
    client,
    userId,
    provider: 'openrouter',
    purpose: 'coding_agent',
    secretEnc: encrypted,
    secretLast4: apiKey.slice(-4),
    secretFingerprint: fingerprint(apiKey, dataKey),
    status: VALID_STATUS,
    verified: true,
  });
  await client.query(
    `UPDATE credentials.user_ai_credentials
        SET metadata = $2, updated_at = NOW()
      WHERE id = $1`,
    [saved.id, metadata],
  );
  return saved;
}

// Disable/re-enable a retained credential without exposing or replacing its
// ciphertext. Only valid credentials are decryptable by readSecret().
async function setStatusOnClient({ client, userId, provider, purpose, status }) {
  assertProviderPurpose(provider, purpose);
  if (![VALID_STATUS, 'disabled'].includes(status)) {
    throw new Error(`credential-store: cannot retain secret with status ${status}`);
  }
  const { rows } = await client.query(
    `UPDATE credentials.user_ai_credentials
        SET status = $4,
            verified_at = CASE WHEN $4 = 'valid' THEN NOW() ELSE NULL END,
            last_error_code = CASE WHEN $4 = 'disabled' THEN 'admin_disabled' ELSE NULL END,
            revision = revision + 1,
            updated_at = NOW()
      WHERE user_id = $1 AND provider = $2 AND purpose = $3
        AND secret_enc IS NOT NULL
      RETURNING id, revision, status, secret_last4`,
    [userId, provider, purpose, status],
  );
  return rows[0] || null;
}

async function revokeOnClient({ client, userId, provider, purpose }) {
  assertProviderPurpose(provider, purpose);
  const { rows } = await client.query(
    `INSERT INTO credentials.user_ai_credentials
       (user_id, provider, purpose, status, revision, revoked_at)
     VALUES ($1, $2, $3, 'revoked', 1, NOW())
     ON CONFLICT (user_id, provider, purpose) DO UPDATE SET
       secret_enc = NULL,
       secret_last4 = NULL,
       secret_fingerprint = NULL,
       status = 'revoked',
       verified_at = NULL,
       revoked_at = NOW(),
       revision = credentials.user_ai_credentials.revision + 1,
       updated_at = NOW()
     RETURNING id, revision, status`,
    [userId, provider, purpose],
  );
  return rows[0] || null;
}

// Revoke (tombstone) a credential row. Authoritative: clears the generic
// secret AND, for the Anthropic coding-agent credential, the legacy
// users.anthropic_key_* columns in the same transaction, so a tombstoned
// row can never be resurrected from stale legacy ciphertext. Never
// physically deletes.
async function revoke({ pool, userId, provider, purpose }) {
  assertProviderPurpose(provider, purpose);
  if (!userId) return null;
  return withTransaction(pool, async (client) => {
    // Upsert-tombstone, NOT a plain UPDATE. The INSERT ... ON CONFLICT
    // targets the SAME unique index (user_id, provider, purpose) that
    // save/upsert writes, so a concurrent first-save and this delete
    // serialize on that row lock. Even when no generic row has been saved
    // yet, we INSERT (and thereby lock) the tombstone row — a plain UPDATE
    // would affect zero rows and acquire no lock, letting a delete commit
    // after a save while the generic key stays valid (review F1).
    const revoked = await revokeOnClient({ client, userId, provider, purpose });
    // Authoritative revocation must also clear any stale legacy ciphertext
    // so a later legacy-first fallback can't re-expose the deleted key.
    if (provider === 'anthropic' && purpose === 'coding_agent') {
      await client.query(
        `UPDATE users SET ${LEGACY_ANTHROPIC_COLUMNS.secretEnc} = NULL,
                          ${LEGACY_ANTHROPIC_COLUMNS.secretLast4} = NULL
         WHERE id = $1`,
        [userId]
      );
    }
    return revoked;
  });
}

// Read the credential ROW (not the secret) for display: last4, status,
// revision, verifiedAt. Never returns the encrypted or plaintext secret.
async function readMetadata({ pool, userId, provider, purpose }) {
  assertProviderPurpose(provider, purpose);
  if (!userId) return null;
  const { rows } = await pool.query(
    `SELECT id, provider, purpose, secret_last4, status, revision,
            verified_at, revoked_at, last_error_code, metadata
     FROM credentials.user_ai_credentials
     WHERE user_id = $1 AND provider = $2 AND purpose = $3`,
    [userId, provider, purpose]
  );
  return rows[0] || null;
}

// Read + decrypt the secret. Only a 'valid' generic row is usable.
// When the generic row exists but is not valid (unverified/invalid/
// revoked), revocation/state is AUTHORITATIVE and we never fall back to
// the legacy column. Legacy fallback happens ONLY when the generic row is
// genuinely absent (e.g. a brand-new install where the backfill hasn't
// run yet during the migration window).
async function readSecret({ pool, userId, provider, purpose, dataKey, expectedRevision }) {
  assertProviderPurpose(provider, purpose);
  if (!userId) return null;

  // Single-statement read: status and secret_enc are fetched together so
  // both come from the SAME row snapshot. Reading valid metadata and then
  // the ciphertext in a separate query lets a concurrent replacement flip
  // the row to unverified/invalid between the two reads yet still return
  // the newly-saved secret (review F4). A lone SELECT never fully
  // serializes readers, but co-locating the status check and the secret in
  // one statement removes the two-query gap the finding describes.
  const { rows } = await pool.query(
    `SELECT status, secret_last4, secret_enc, revision
     FROM credentials.user_ai_credentials
     WHERE user_id = $1 AND provider = $2 AND purpose = $3`,
    [userId, provider, purpose]
  );
  const row = rows[0];

  // Generic row exists and is valid → decrypt from the SAME row.
  if (row && row.status === VALID_STATUS && row.secret_enc) {
    // Atomic revision check (review P2): the revision and secret are read
    // in the SAME statement, so a token minted for for revision N can
    // never receive revision N+1's key via a read/replace race.
    if (expectedRevision != null && row.revision !== expectedRevision) {
      return null;
    }
    const dec = secrets.decrypt(row.secret_enc, dataKey);
    if (dec) return dec;
    // Decrypt/read failure on a VALID row is a real error, not a fallback:
    // we must not silently substitute a stale legacy key for a valid
    // generic one (that could resurrect an older key the user replaced).
    log.warn('credential-store', 'generic credential decrypt failed; refusing fallback', { userId, provider, purpose });
    return null;
  }

  // Generic row exists but is not usable (unverified/invalid/revoked):
  // state is authoritative — do NOT fall back to legacy.
  if (row) return null;

  // No generic row: compatible legacy fallback for Anthropic coding-agent
  // only, during the migration window (backfill not yet present).
  if (provider === 'anthropic' && purpose === 'coding_agent') {
    return readLegacyAnthropic({ pool, userId, dataKey });
  }
  return null;
}

// ── Legacy Anthropic compatibility (dual-read/dual-write) ─────────────

async function readLegacyAnthropic({ pool, userId, dataKey }) {
  try {
    const { rows } = await pool.query(
      `SELECT ${LEGACY_ANTHROPIC_COLUMNS.secretEnc} AS enc
       FROM users WHERE id = $1`,
      [userId]
    );
    const enc = rows[0]?.enc;
    if (enc) {
      const dec = secrets.decrypt(enc, dataKey);
      if (dec) return dec;
      log.warn('credential-store', 'legacy anthropic decrypt failed; treating as none', { userId });
    }
  } catch (err) {
    log.warn('credential-store', 'legacy anthropic read failed', { userId, err: err.message });
  }
  return null;
}

// Dual-write a new Anthropic coding-agent key to BOTH the generic row
// and the legacy users columns ATOMICALLY in one transaction. Any failure
// rolls back both and propagates to the caller — a replace/delete can
// never return success while the other store is left stale.
async function writeAnthropicCodingAgent({ pool, userId, apiKey, dataKey, status = VALID_STATUS, verified = true }) {
  const encrypted = secrets.encrypt(apiKey, dataKey);
  const last4 = apiKey.slice(-4);
  const fp = fingerprint(apiKey, dataKey);
  return withTransaction(pool, async (client) => {
    const generic = await upsertOnClient({
      client, userId, provider: 'anthropic', purpose: 'coding_agent',
      secretEnc: encrypted, secretLast4: last4, secretFingerprint: fp,
      status, verified,
    });
    // Mirror the credential into the legacy users.anthropic_key_* columns
    // ONLY when VALID. Legacy consumers (e.g. src/services/limits.js
    // loadUserApiKey) read those columns unconditionally and ignore status,
    // so a non-valid (unverified/invalid) key must never appear there as a
    // live key. Critically, a non-valid REPLACEMENT must atomically CLEAR
    // the legacy columns in the same transaction — otherwise a status-blind
    // consumer keeps using the previously-valid key A after the user
    // submitted an unverified/invalid replacement B (review F3). Non-valid
    // keys live only in the generic store; legacy is cleared, not skipped.
    if (status === VALID_STATUS) {
      await client.query(
        `UPDATE users SET ${LEGACY_ANTHROPIC_COLUMNS.secretEnc} = $1,
                          ${LEGACY_ANTHROPIC_COLUMNS.secretLast4} = $2
         WHERE id = $3`,
        [encrypted, last4, userId]
      );
    } else {
      await client.query(
        `UPDATE users SET ${LEGACY_ANTHROPIC_COLUMNS.secretEnc} = NULL,
                          ${LEGACY_ANTHROPIC_COLUMNS.secretLast4} = NULL
         WHERE id = $1`,
        [userId]
      );
    }
    return generic;
  });
}

// Dual-write a delete/revoke of the Anthropic coding-agent key. The
// generic tombstone + legacy clear happen atomically (see revoke above).
async function deleteAnthropicCodingAgent({ pool, userId }) {
  await revoke({ pool, userId, provider: 'anthropic', purpose: 'coding_agent' });
  return true;
}

module.exports = {
  PROVIDERS,
  PURPOSES,
  SUPPORTED_STATUSES,
  VALID_STATUS,
  REVOKED_STATUS,
  fingerprint,
  withTransaction,
  upsert,
  writeOpenRouterCodingAgentOnClient,
  setStatusOnClient,
  revokeOnClient,
  revoke,
  readMetadata,
  readSecret,
  readLegacyAnthropic,
  writeAnthropicCodingAgent,
  deleteAnthropicCodingAgent,
  LEGACY_ANTHROPIC_COLUMNS,
};

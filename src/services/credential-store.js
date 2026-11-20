'use strict';

// Generic user AI credential store (plan.md PR2).
//
// Generalized users.anthropic_key_enc/_last4 so a second provider
// (openrouter) could be stored without stacking another pair of columns.
// One row per (user_id, provider, purpose):
//
//   provider = 'openrouter'   ('anthropic' rows are history: people's own
//                              Anthropic keys were removed in task 2275,
//                              and every such row is a revoked tombstone)
//   purpose  = 'coding_agent' | 'app_llm'
//
// The encryption envelope is src/services/secrets.js AES-256-GCM keyed by
// config.dataEncryptionKey.
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

// The table's CHECK still allows 'anthropic' for the tombstones; nothing
// here reads or writes one any more.
const PROVIDERS = ['openrouter'];
const PURPOSES = ['coding_agent', 'app_llm'];
// Supported status values. Only 'valid' is usable; the rest are explicitly
// non-usable states we constrain at the store boundary.
const VALID_STATUS = 'valid';
const REVOKED_STATUS = 'revoked';
const SUPPORTED_STATUSES = [VALID_STATUS, REVOKED_STATUS, 'unverified', 'invalid', 'expired', 'disabled'];

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

// Public upsert.
async function upsert(opts) {
  assertProviderPurpose(opts.provider, opts.purpose);
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

// Merge a few fields into one credential's stored key-info without touching
// its ciphertext, status or revision. Used when a managed key's remote
// allowance is changed after issuance (#2119); a personal key's key-info is
// rewritten whole on every save and has no need of this.
async function mergeKeyInfoOnClient({ client, userId, provider, purpose, keyInfo }) {
  assertProviderPurpose(provider, purpose);
  const { rows } = await client.query(
    `UPDATE credentials.user_ai_credentials
        SET metadata = jsonb_set(metadata, '{keyInfo}',
              COALESCE(metadata->'keyInfo', '{}'::jsonb) || $4::jsonb),
            updated_at = NOW()
      WHERE user_id = $1 AND provider = $2 AND purpose = $3
      RETURNING id`,
    [userId, provider, purpose, keyInfo],
  );
  return rows.length > 0;
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
        SET status = $4::varchar(16),
            verified_at = CASE WHEN $4::varchar(16) = 'valid' THEN NOW() ELSE NULL END,
            last_error_code = CASE WHEN $4::varchar(16) = 'disabled' THEN 'admin_disabled' ELSE NULL END,
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

// Revoke (tombstone) a credential row. Authoritative: clears the secret.
// Never physically deletes.
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
    return revokeOnClient({ client, userId, provider, purpose });
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

  // Generic row exists but is not usable (unverified/invalid/revoked), or
  // there is no row at all.
  return null;
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
  mergeKeyInfoOnClient,
  setStatusOnClient,
  revokeOnClient,
  revoke,
  readMetadata,
  readSecret,
};

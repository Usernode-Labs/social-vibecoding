'use strict';

// One-use confirmation tokens for Global Chat writes. Only a SHA-256 token
// hash and an AES-GCM sealed copy of the exact normalized input are stored.
// The bearer token is returned once to the authenticated client and is never
// placed in model context, logs, or transcript payloads.

const crypto = require('node:crypto');
const secrets = require('../secrets');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

class ActionConfirmationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActionConfirmationError';
    this.code = code;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function normalizedJson(input) {
  let json;
  try { json = JSON.stringify(stableValue(input)); } catch { json = null; }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 1024 * 1024) {
    throw new ActionConfirmationError('invalid_action', 'The action input is not bounded JSON.');
  }
  return json;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sealedInput(json, dataKey) {
  return { version: 1, ciphertext: secrets.encrypt(json, dataKey) };
}

function openedInput(value, dataKey) {
  if (!value || value.version !== 1 || typeof value.ciphertext !== 'string') {
    throw new ActionConfirmationError('invalid_action', 'The prepared action cannot be read.');
  }
  const json = secrets.decrypt(value.ciphertext, dataKey);
  if (!json) throw new ActionConfirmationError('invalid_action', 'The prepared action cannot be read.');
  let parsed;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ActionConfirmationError('invalid_action', 'The prepared action input is invalid.');
  }
  return { json, input: parsed };
}

function validateIdentity({ userId, threadId, capabilityId }) {
  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    throw new ActionConfirmationError('invalid_action', 'A user is required.');
  }
  if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) {
    throw new ActionConfirmationError('invalid_action', 'A valid thread is required.');
  }
  if (typeof capabilityId !== 'string' || !CAPABILITY_RE.test(capabilityId)) {
    throw new ActionConfirmationError('invalid_action', 'A valid capability is required.');
  }
  return { userId: numericUserId, threadId, capabilityId };
}

async function prepareAction(pool, {
  userId,
  threadId,
  capabilityId,
  input,
  objectRevision = null,
  dataKey,
  now = new Date(),
  ttlMs = DEFAULT_TTL_MS,
}) {
  const identity = validateIdentity({ userId, threadId, capabilityId });
  if (!dataKey) throw new ActionConfirmationError('invalid_action', 'Action encryption is unavailable.');
  const revision = objectRevision == null ? null : String(objectRevision);
  if (revision != null && (!revision || revision.length > 255 || /[\u0000-\u001f\u007f]/.test(revision))) {
    throw new ActionConfirmationError('invalid_action', 'The object revision is invalid.');
  }
  const issuedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(issuedAt.valueOf())) throw new ActionConfirmationError('invalid_action', 'Invalid action time.');
  const boundedTtl = Math.max(1_000, Math.min(MAX_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
  const expiresAt = new Date(issuedAt.valueOf() + boundedTtl);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const json = normalizedJson(input);
  const inputHash = sha256(json);
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO global_chat_action_tokens
       (id, token_hash, user_id, thread_id, capability_id, normalized_input,
        input_hash, object_revision, expires_at, created_at)
     SELECT $1, $2, $3, t.id, $5, $6::jsonb, $7, $8, $9, $10
       FROM global_chat_threads t
      WHERE t.id = $4 AND t.user_id = $3 AND t.archived_at IS NULL
     RETURNING id`,
    [
      id,
      tokenHash,
      identity.userId,
      identity.threadId,
      identity.capabilityId,
      JSON.stringify(sealedInput(json, dataKey)),
      inputHash,
      revision,
      expiresAt,
      issuedAt,
    ],
  ).then((result) => {
    if (!result.rows.length) {
      throw new ActionConfirmationError('thread_not_found', 'That Global Chat thread is unavailable.');
    }
  });
  return {
    token,
    capabilityId: identity.capabilityId,
    inputHash,
    objectRevision: revision,
    expiresAt: expiresAt.toISOString(),
  };
}

async function consumeAction(pool, {
  token,
  userId,
  threadId,
  capabilityId = null,
  dataKey,
  resolveObjectRevision = null,
  now = new Date(),
}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new ActionConfirmationError('invalid_or_expired_action', 'This confirmation is invalid or expired.');
  }
  const identity = validateIdentity({
    userId,
    threadId,
    capabilityId: capabilityId || 'action.pending',
  });
  if (!dataKey) throw new ActionConfirmationError('invalid_action', 'Action encryption is unavailable.');
  const checkedNow = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(checkedNow.valueOf())) throw new ActionConfirmationError('invalid_action', 'Invalid action time.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, capability_id, normalized_input, input_hash, object_revision, expires_at
         FROM global_chat_action_tokens
        WHERE token_hash = $1 AND user_id = $2 AND thread_id = $3
          AND consumed_at IS NULL AND expires_at > $4
        FOR UPDATE`,
      [sha256(token), identity.userId, identity.threadId, checkedNow],
    );
    const row = rows[0];
    if (!row || (capabilityId && row.capability_id !== capabilityId)) {
      throw new ActionConfirmationError('invalid_or_expired_action', 'This confirmation is invalid or expired.');
    }
    const opened = openedInput(row.normalized_input, dataKey);
    if (sha256(opened.json) !== row.input_hash) {
      throw new ActionConfirmationError('invalid_action', 'The prepared action no longer matches its input.');
    }
    if (row.object_revision != null && typeof resolveObjectRevision === 'function') {
      const current = await resolveObjectRevision({
        client,
        capabilityId: row.capability_id,
        input: structuredClone(opened.input),
      });
      if (String(current ?? '') !== String(row.object_revision)) {
        throw new ActionConfirmationError(
          'stale_action',
          'This item changed after the confirmation was prepared. Review the updated action.',
        );
      }
    }
    const consumed = await client.query(
      `UPDATE global_chat_action_tokens
          SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id`,
      [row.id, checkedNow],
    );
    if (!consumed.rows.length) {
      throw new ActionConfirmationError('invalid_or_expired_action', 'This confirmation was already used.');
    }
    await client.query('COMMIT');
    return {
      capabilityId: row.capability_id,
      input: opened.input,
      inputHash: row.input_hash,
      objectRevision: row.object_revision || null,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  ActionConfirmationError,
  consumeAction,
  normalizedJson,
  openedInput,
  prepareAction,
  sealedInput,
  sha256,
};

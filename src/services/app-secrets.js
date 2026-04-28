'use strict';

/**
 * DAO + helpers for per-app secrets stored in the `app_secrets` table.
 *
 * Values are encrypted with the existing AES-256-GCM helper in
 * `services/secrets.js` (keyed off `config.jwtSecret`). No additional
 * operator config required — losing the JWT secret already invalidates
 * every session, so reusing it adds no new "this is the kingdom keys"
 * concern.
 *
 * Three reading shapes:
 *   - list(pool, appId)          → metadata only ({ key, hasValue, ... })
 *   - getRedactedView(...)       → manifest-merged view for the UI
 *   - getRawValues(pool, appId)  → { KEY: plaintext, ... } — for deploy
 *
 * The deploy paths (`app-creator.js`, `staging.js`) call `getRawValues`
 * + `mergeForDeploy` after cloning the repo and reading the manifest,
 * then pass the resulting env into `docker.runContainer`.
 */

const log = require('./logger');
const { encrypt, decrypt } = require('./secrets');

// ──────────────────────────────────────────────────────────────────────
// Read paths
// ──────────────────────────────────────────────────────────────────────

async function list(pool, appId) {
  const { rows } = await pool.query(
    `SELECT key, value_last4, updated_at, updated_by
       FROM app_secrets
      WHERE app_id = $1
      ORDER BY key ASC`,
    [appId]
  );
  return rows.map((r) => ({
    key: r.key,
    hasValue: true,
    valueLast4: r.value_last4 || null,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

async function getRawValues(pool, appId, jwtSecret) {
  const { rows } = await pool.query(
    `SELECT key, value_enc FROM app_secrets WHERE app_id = $1`,
    [appId]
  );
  const out = {};
  for (const r of rows) {
    const v = decrypt(r.value_enc, jwtSecret);
    if (v != null) out[r.key] = v;
    else log.warn('app-secrets', 'Decrypt returned null (skipping)', { key: r.key });
  }
  return out;
}

/**
 * Build the UI-facing view of a dapp's secrets:
 *   - one row per manifest-declared key (the dapp's own contract)
 *   - plus any "orphan" keys the user has stored but the manifest
 *     no longer mentions (so they show up in the UI for cleanup)
 *
 * Sensitive keys never carry their plaintext into the response, just
 * a `hasValue` flag. Non-sensitive keys include `valueLast4`.
 */
async function getRedactedView(pool, appId, manifest) {
  const stored = await list(pool, appId);
  const storedByKey = new Map(stored.map((s) => [s.key, s]));
  const declared = new Set();
  const out = [];

  for (const entry of manifest.secrets) {
    declared.add(entry.key);
    const s = storedByKey.get(entry.key);
    out.push({
      key: entry.key,
      description: entry.description,
      required: entry.required,
      sensitive: entry.sensitive,
      default: entry.default,
      hasValue: !!s,
      valueLast4: s && !entry.sensitive ? s.valueLast4 : null,
      updatedAt: s ? s.updatedAt : null,
      orphan: false,
    });
  }

  for (const s of stored) {
    if (declared.has(s.key)) continue;
    out.push({
      key: s.key,
      description: '(no longer declared in social-vibecoding.json)',
      required: false,
      sensitive: true,
      default: null,
      hasValue: true,
      valueLast4: null,
      updatedAt: s.updatedAt,
      orphan: true,
    });
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Write paths
// ──────────────────────────────────────────────────────────────────────

function computeLast4(value, sensitive) {
  if (sensitive) return null;
  if (typeof value !== 'string' || !value.length) return null;
  return value.slice(-4);
}

/**
 * Upsert a secret value. `sensitive` controls whether `value_last4` is
 * stored (it is for non-sensitive keys, so the UI can render a preview).
 */
async function setValue(pool, appId, key, value, { sensitive = false, userId = null, jwtSecret }) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('app-secrets.setValue: non-empty string value required');
  }
  const valueEnc = encrypt(value, jwtSecret);
  const last4 = computeLast4(value, sensitive);
  await pool.query(
    `INSERT INTO app_secrets (app_id, key, value_enc, value_last4, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id, key)
     DO UPDATE SET value_enc = EXCLUDED.value_enc,
                   value_last4 = EXCLUDED.value_last4,
                   updated_at = NOW(),
                   updated_by = EXCLUDED.updated_by`,
    [appId, key, valueEnc, last4, userId]
  );
}

async function deleteValue(pool, appId, key) {
  await pool.query(`DELETE FROM app_secrets WHERE app_id = $1 AND key = $2`, [appId, key]);
}

// ──────────────────────────────────────────────────────────────────────
// Deploy-time helpers (pure)
// ──────────────────────────────────────────────────────────────────────

/**
 * List the manifest-required keys that have no stored value. The deploy
 * paths use this to short-circuit before docker build — no point shipping
 * an image that's missing its config.
 */
function missingRequired(manifest, storedKeys) {
  const have = new Set(storedKeys);
  const out = [];
  for (const s of manifest.secrets) {
    if (s.required && !have.has(s.key)) out.push(s.key);
  }
  return out;
}

/**
 * Build the env-var map the deploy paths pass to `docker.runContainer`.
 * Stored values win over manifest defaults; manifest defaults fill in
 * gaps for non-required entries that were left unset.
 *
 * Returns { env, missingRequired } so the caller can short-circuit
 * deploys cleanly without a second pass through the manifest.
 */
function mergeForDeploy(manifest, storedValues) {
  const env = {};
  const storedKeys = Object.keys(storedValues || {});
  const missing = missingRequired(manifest, storedKeys);

  for (const s of manifest.secrets) {
    if (Object.prototype.hasOwnProperty.call(storedValues || {}, s.key)) {
      env[s.key] = storedValues[s.key];
    } else if (s.default != null) {
      env[s.key] = s.default;
    }
  }
  return { env, missingRequired: missing };
}

module.exports = {
  list,
  getRawValues,
  getRedactedView,
  setValue,
  deleteValue,
  missingRequired,
  mergeForDeploy,
};

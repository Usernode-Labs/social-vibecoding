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
 * Private keys never carry their plaintext into the response, just
 * a `hasValue` flag. Non-private keys include `valueLast4`.
 *
 * The response includes BOTH `private` (canonical) and `sensitive`
 * (BC alias) populated identically so old UI clients keep working.
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
      private: entry.private,
      sensitive: entry.private,
      default: entry.default,
      stagingDefault: entry.staging_default != null ? entry.staging_default : null,
      hasValue: !!s,
      valueLast4: s && !entry.private ? s.valueLast4 : null,
      updatedAt: s ? s.updatedAt : null,
      orphan: false,
    });
  }

  for (const s of stored) {
    if (declared.has(s.key)) continue;
    out.push({
      key: s.key,
      description: '(no longer declared in dapp.json)',
      required: false,
      private: true,
      sensitive: true,
      default: null,
      stagingDefault: null,
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
 * Upsert a secret value. `sensitive` (the at-rest classification flag,
 * which is just `manifest.private` at the call site) controls whether
 * `value_last4` is stored — it is for non-private keys, so the UI can
 * render a preview, and isn't for private keys, so the last 4 chars
 * never leak via the secrets API.
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
 *
 * Precedence (high → low) for non-private entries:
 *   1. Stored secret value     — explicit, user-set per app
 *   2. Platform default        — infrastructure-controlled, supplied
 *                                by the caller (e.g. `NODE_RPC_URL`
 *                                from the platform's own process.env,
 *                                which differs between local-dev and
 *                                prod). Wins over the manifest default
 *                                because the platform knows where its
 *                                own sidecars actually live; a manifest
 *                                hard-coding a prod hostname would
 *                                otherwise break local-dev deploys.
 *   3. Manifest default        — last-resort fallback for standalone
 *                                deploys (the dapp running outside
 *                                the platform).
 *
 * Private secrets in staging (sibling to the SQL `staging:private`
 * pattern — see app-conventions.md "Public vs private secrets"):
 *   When `opts.forStaging` is true and a manifest entry has
 *   `private: true` (or the BC alias `sensitive: true`), the stored
 *   value is *not* propagated. The reasoning: a value worth
 *   encrypting at rest and redacting from API responses is also
 *   worth keeping out of the staging container's env, where any PR's
 *   debug endpoint, error message, or SSRF could leak it.
 *   Resolution collapses to manifest-only fallbacks:
 *     1. `staging_default` (committed in dapp.json — explicit signal
 *        that this value is safe in staging; e.g. a Stripe test key)
 *     2. `default` (committed in dapp.json — already publishable)
 *     3. omit from env; if `required: true`, surface in
 *        `missingPrivateStagingDefault` so the caller can fail fast.
 *   This is a no-op outside staging: prod paths see private secrets
 *   exactly as before.
 *
 * Returns { env, missingRequired, missingPrivateStagingDefault }.
 * Callers can short-circuit on either failure list.
 */
function mergeForDeploy(manifest, storedValues, platformDefaults, opts = {}) {
  const { forStaging = false } = opts;
  const env = {};
  const missing = [];
  const missingPrivateStagingDefault = [];
  const platform = platformDefaults || {};
  const stored = storedValues || {};

  for (const s of manifest.secrets) {
    const isPrivateInStaging = forStaging && !!s.private;

    if (isPrivateInStaging) {
      const fallback = s.staging_default != null
        ? s.staging_default
        : (s.default != null ? s.default : null);
      if (fallback != null) {
        env[s.key] = fallback;
      } else if (s.required) {
        missingPrivateStagingDefault.push(s.key);
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(stored, s.key)) {
      env[s.key] = stored[s.key];
    } else if (Object.prototype.hasOwnProperty.call(platform, s.key) && platform[s.key] != null) {
      env[s.key] = platform[s.key];
    } else if (s.default != null) {
      env[s.key] = s.default;
    } else if (s.required) {
      missing.push(s.key);
    }
  }

  return { env, missingRequired: missing, missingPrivateStagingDefault };
}

/**
 * The set of env-var keys the platform itself owns the default for —
 * sourced from the platform's own `process.env` at deploy time so a
 * spawned dapp inherits whatever node URL (etc.) the platform was
 * configured against. Caller-facing because all three deploy paths
 * (`app-creator.js`, `staging.buildAndDeployStaging`,
 * `staging.rebuildProduction`) need exactly the same precedence.
 *
 * Add new keys here only when their correct value is environment-
 * dependent and should never be hardcoded in a dapp's `dapp.json`.
 * Currently:
 *   - NODE_RPC_URL: in prod points at the `usernode-node` sidecar
 *     (in-network); in local-dev points at the host-native node via
 *     `host.docker.internal`. Hardcoding either in the manifest
 *     breaks the other.
 */
function platformDefaultsFromEnv(env) {
  const e = env || process.env;
  const out = {};
  if (e.NODE_RPC_URL) out.NODE_RPC_URL = e.NODE_RPC_URL;
  return out;
}

module.exports = {
  list,
  getRawValues,
  getRedactedView,
  setValue,
  deleteValue,
  missingRequired,
  mergeForDeploy,
  platformDefaultsFromEnv,
};

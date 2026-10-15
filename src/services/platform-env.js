'use strict';

/**
 * DAO for the platform's OWN environment variables — the `platform_env_*`
 * tables. Deliberately a sibling of `services/app-secrets.js`, not an
 * extension of it.
 *
 * The two look alike (same AES-256-GCM helper, same
 * `key → value_enc + value_last4` shape) and that similarity is on
 * purpose: the storage problem is identical, so the solution should be
 * recognisable. What must NOT be shared is the *deploy* path.
 * app-secrets.mergeForDeploy() resolves values into a child dapp's
 * container env; nothing here ever reaches that function, and nothing
 * there ever reads these tables. A platform variable lands in
 * /opt/usernode/.env — the platform process's own environment — and
 * nowhere else.
 *
 * WHERE THE BRANCH LIVES. The two stores now share ONE user-facing
 * surface: the app-secrets panel (labelled "Platform variables" for the
 * self-hosted app). So exactly two call sites choose between the two
 * DAOs, both keyed on `apps.self_hosted`:
 *   - routes/apps.js  — GET/PUT/DELETE /api/apps/:slug/secrets*
 *   - routes/issues.js — maybeApplySecretChangeProposal (the vote path)
 * Everything else stays segregated: mergeForDeploy() never learns about
 * platform_env, and this module never learns about app_secrets. The
 * invariant to check when auditing is therefore "the branch picks the
 * right DAO", and it is covered by tests/platform-env-admin.test.js and
 * tests/platform-env-vote.test.js.
 *
 * The running platform never reads values out of here either: they are
 * resolved once, by scripts/dump-platform-env.js, during the deploy that
 * writes .env. A variable set in the panel takes effect on the next
 * deploy, not immediately — the same contract as a GitHub repo variable,
 * which is what this replaces.
 *
 * Shapes:
 *   listView(pool, appId)                 → merged declaration+value rows
 *                                           for the panel (never any
 *                                           plaintext of a private value)
 *   getRawValues(pool, appId, dataKey)    → { KEY: plaintext } for deploy
 *   setValue / deleteValue                → admin + vote-applied mutations
 *   missingRequired(pool, appId)          → required-and-unset keys
 */

const log = require('./logger');
const { decrypt } = require('./secrets');

// The value rules (normalizeValue, validateValue, isWritableKey,
// computeLast4) and the two writes (setValue, deleteValue) are the
// workflow's (src/workflow/rules/platform-vars.ts, where their reasons are):
// the governance and merge-followups machines write platform variables with
// them inside their transactions. The read paths below stay here.
const {
  MAX_VALUE_LEN, normalizeValue, validateValue, isWritableKey, computeLast4, setValue, deleteValue,
} = require('../workflow/rules/platform-vars.ts');

// ──────────────────────────────────────────────────────────────────────
// Read paths
// ──────────────────────────────────────────────────────────────────────

/**
 * Full-outer-join the declarations (what dapp.json says the platform
 * needs) against the values (what an admin has set). Every row the admin
 * console renders comes from here, in one of four states:
 *
 *   declared + value      → "set"
 *   declared, no value    → "unset" (blocking if required)
 *   value, no declaration → "orphan" (removed from dapp.json; value kept)
 *   declared + unwritable → "managed" (documented, set by GitHub secrets)
 *
 * NEVER returns plaintext for a private key: `value_last4` is stored as
 * NULL for those (computeLast4 refuses), so there is nothing to leak
 * even by accident. Non-private values ARE returned in full — that's the
 * point of marking a variable non-private, and it's what makes "is
 * MAX_GLOBAL_SESSIONS actually 75 in prod?" answerable from the UI.
 */
async function listView(pool, appId, dataKey) {
  const { rows } = await pool.query(
    `SELECT COALESCE(d.key, v.key)      AS key,
            d.key IS NOT NULL           AS declared,
            v.key IS NOT NULL           AS has_value,
            COALESCE(d.description, '') AS description,
            COALESCE(d.required, FALSE) AS required,
            COALESCE(d.private, v.private, FALSE) AS private,
            COALESCE(d.grouping, 'Undeclared')    AS grouping,
            d.default_value,
            COALESCE(d.unwritable, FALSE) AS unwritable,
            v.value_enc,
            v.value_last4,
            v.updated_at,
            u.username AS updated_by_username
       FROM platform_env_declarations d
       FULL OUTER JOIN platform_env_values v
         ON v.app_id = d.app_id AND v.key = d.key
       LEFT JOIN users u ON u.id = v.updated_by
      WHERE COALESCE(d.app_id, v.app_id) = $1
      ORDER BY COALESCE(d.grouping, 'Undeclared') ASC, COALESCE(d.key, v.key) ASC`,
    [appId]
  );

  return rows.map((r) => {
    const isPrivate = !!r.private;
    // Decrypt only for non-private keys. A decrypt failure (rotated
    // JWT_SECRET, corrupt row) degrades to "set, value unreadable"
    // rather than erroring the whole screen.
    let value = null;
    if (r.has_value && !isPrivate && dataKey) {
      value = decrypt(r.value_enc, dataKey);
      if (value == null) {
        log.warn('platform-env', 'Decrypt returned null', { key: r.key });
      }
    }
    return {
      key: r.key,
      declared: !!r.declared,
      hasValue: !!r.has_value,
      description: r.description,
      required: !!r.required,
      private: isPrivate,
      group: r.grouping,
      defaultValue: r.default_value,
      unwritable: !!r.unwritable || !isWritableKey(r.key),
      value: isPrivate ? null : value,
      valueLast4: r.value_last4 || null,
      updatedAt: r.updated_at || null,
      updatedBy: r.updated_by_username || null,
      state: !r.declared ? 'orphan'
        : (r.unwritable || !isWritableKey(r.key)) ? 'managed'
          : r.has_value ? 'set' : 'unset',
    };
  });
}

/**
 * Deploy-time resolution: { KEY: plaintext } for every stored value whose
 * key is writable. Unwritable keys are filtered even if a row somehow
 * exists for one — defence in depth, so a value planted by a direct DB
 * write (or a row surviving from before a key joined the unwritable set)
 * can never override the GitHub-secret-sourced line in .env.
 */
async function getRawValues(pool, appId, dataKey) {
  const { rows } = await pool.query(
    'SELECT key, value_enc FROM platform_env_values WHERE app_id = $1 ORDER BY key ASC',
    [appId]
  );
  const out = {};
  for (const r of rows) {
    if (!isWritableKey(r.key)) {
      log.warn('platform-env', 'Refusing to resolve unwritable key', { key: r.key });
      continue;
    }
    const v = decrypt(r.value_enc, dataKey);
    if (v != null) out[r.key] = v;
    else log.warn('platform-env', 'Decrypt returned null (skipping)', { key: r.key });
  }
  return out;
}

/** Declared-required keys with no stored value. The merge gate's input. */
async function missingRequired(pool, appId) {
  const { rows } = await pool.query(
    `SELECT d.key, d.description
       FROM platform_env_declarations d
       LEFT JOIN platform_env_values v
         ON v.app_id = d.app_id AND v.key = d.key
      WHERE d.app_id = $1
        AND d.required = TRUE
        AND d.unwritable = FALSE
        AND v.key IS NULL
      ORDER BY d.key ASC`,
    [appId]
  );
  return rows.map((r) => ({ key: r.key, required: true, description: r.description || '' }));
}

// ──────────────────────────────────────────────────────────────────────
// Write paths
// ──────────────────────────────────────────────────────────────────────

module.exports = {
  listView,
  getRawValues,
  missingRequired,
  setValue,
  deleteValue,
  isWritableKey,
  validateValue,
  normalizeValue,
  computeLast4,
  MAX_VALUE_LEN,
};

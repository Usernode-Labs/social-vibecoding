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
 * nowhere else. Keeping the two modules apart is what makes that
 * containment checkable by reading one file instead of auditing a
 * branch inside a shared one.
 *
 * The running platform never reads values out of here either: they are
 * resolved once, by scripts/dump-platform-env.js, during the deploy that
 * writes .env. A variable set in the admin console takes effect on the
 * next deploy, not immediately — the same contract as a GitHub repo
 * variable, which is what this replaces.
 *
 * Shapes:
 *   listView(pool, appId)                 → merged declaration+value rows
 *                                           for the admin UI (never any
 *                                           plaintext of a private value)
 *   getRawValues(pool, appId, jwtSecret)  → { KEY: plaintext } for deploy
 *   setValue / deleteValue                → admin mutations
 *   missingRequired(pool, appId)          → required-and-unset keys
 */

const log = require('./logger');
const { encrypt, decrypt } = require('./secrets');
const { PLATFORM_ENV_UNWRITABLE, RESERVED_KEYS, RESERVED_KEY_PREFIXES, KEY_RE } = require('./app-manifest');

const MAX_VALUE_LEN = 8192;

// A stored value has to survive being written into /opt/usernode/.env as
// a single-quoted line (see scripts/dump-platform-env.js and the "Write
// .env" step in deploy.yml). Single-quoting is what stops the value being
// interpolated or word-split — but there is no way to escape a single
// quote *inside* single quotes that docker compose's env-file parser
// understands. So a value containing one is rejected at the write
// boundary, with an error that says why, rather than accepted here and
// silently dropped by the deploy three hours later. NUL and carriage
// returns are rejected for the same reason (they can't round-trip a
// line-oriented file); ordinary newlines are fine — the existing
// GITHUB_PRIVATE_KEY line proves multi-line quoted values work.
// eslint-disable-next-line no-control-regex
const UNSAFE_VALUE_RE = /['\r\u0000]/;
const UNSAFE_VALUE_MESSAGE =
  "Values can't contain a single quote or a carriage return — they wouldn't survive being written to the platform's .env file.";

function validateValue(value) {
  if (typeof value !== 'string' || !value.length) {
    return 'A non-empty value is required.';
  }
  if (value.length > MAX_VALUE_LEN) {
    return `Value exceeds ${MAX_VALUE_LEN} characters.`;
  }
  if (UNSAFE_VALUE_RE.test(value)) {
    return UNSAFE_VALUE_MESSAGE;
  }
  return null;
}

/**
 * Is this key writable through the admin UI? Mirrors the manifest
 * reader's `unwritable` derivation, but computed from the key alone so
 * a route can refuse a write for a key that has no declaration row at
 * all (which is exactly the case an attacker would try: POST a value for
 * JWT_SECRET, which nothing has declared).
 */
function isWritableKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false;
  if (PLATFORM_ENV_UNWRITABLE.has(key)) return false;
  if (RESERVED_KEYS.has(key)) return false;
  if (RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;
}

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
async function listView(pool, appId, jwtSecret) {
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
    if (r.has_value && !isPrivate && jwtSecret) {
      value = decrypt(r.value_enc, jwtSecret);
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
async function getRawValues(pool, appId, jwtSecret) {
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
    const v = decrypt(r.value_enc, jwtSecret);
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

// Private keys store no last-4: unlike a non-private value (where a
// preview is useful and harmless), 4 characters of a token is 4
// characters of a token. Same rule as app-secrets.computeLast4.
function computeLast4(value, isPrivate) {
  if (isPrivate) return null;
  if (typeof value !== 'string' || !value.length) return null;
  return value.slice(-4);
}

/**
 * Upsert a platform variable value. Throws (rather than silently
 * skipping) on an unwritable key so a route bug surfaces as a 500 in
 * tests instead of a no-op in production; routes check isWritableKey()
 * first and return a 400 with an explanation.
 *
 * `private` is taken from the declaration when there is one, so an admin
 * cannot downgrade a private variable to non-private (and thereby cause
 * its last-4 to start being stored) by passing a flag.
 */
async function setValue(pool, appId, key, value, { userId = null, jwtSecret } = {}) {
  if (!isWritableKey(key)) {
    throw new Error(`platform-env.setValue: key is not writable: ${key}`);
  }
  const invalid = validateValue(value);
  if (invalid) {
    throw new Error(`platform-env.setValue: ${invalid}`);
  }

  const { rows: declRows } = await pool.query(
    'SELECT private FROM platform_env_declarations WHERE app_id = $1 AND key = $2',
    [appId, key]
  );
  // No declaration → treat as private. Setting a value for a key nothing
  // declares is legitimate (you set it in the same breath as the
  // proposal that declares it), and the safe default for an unknown
  // variable is "don't display it".
  const isPrivate = declRows.length ? !!declRows[0].private : true;

  await pool.query(
    `INSERT INTO platform_env_values (app_id, key, value_enc, value_last4, private, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_id, key)
     DO UPDATE SET value_enc   = EXCLUDED.value_enc,
                   value_last4 = EXCLUDED.value_last4,
                   private     = EXCLUDED.private,
                   updated_at  = NOW(),
                   updated_by  = EXCLUDED.updated_by`,
    [appId, key, encrypt(value, jwtSecret), computeLast4(value, isPrivate), isPrivate, userId]
  );
  return { key, private: isPrivate };
}

/** Remove a stored value. The declaration (if any) is untouched. */
async function deleteValue(pool, appId, key) {
  const { rowCount } = await pool.query(
    'DELETE FROM platform_env_values WHERE app_id = $1 AND key = $2',
    [appId, key]
  );
  return rowCount > 0;
}

module.exports = {
  listView,
  getRawValues,
  missingRequired,
  setValue,
  deleteValue,
  isWritableKey,
  validateValue,
  computeLast4,
  MAX_VALUE_LEN,
};

// A platform variable's value rules and its two writes (the platform's OWN
// environment, the `platform_env_values` table). services/platform-env.js
// re-exports these beside its read paths; the governance machine (a passed
// secret change on the platform) and the merge-followups machine (a value
// declared with a merged proposal) write through them inside their
// transactions. Deliberately separate from app-secret-values.ts, as the two
// DAOs are (see services/platform-env.js's header).

import type { Queryable } from './db.ts';
import { encrypt } from './secrets.ts';
import { KEY_RE, PLATFORM_ENV_UNWRITABLE, RESERVED_KEYS, RESERVED_KEY_PREFIXES } from './platform-keys.ts';

export const MAX_VALUE_LEN = 8192;

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
  "Values can't contain a single quote or a carriage return, because they wouldn't survive being written to the platform's .env file.";

// Surrounding whitespace on a pasted value is invisible in the panel (a
// private value shows only "set"; a non-private one renders as plain
// text) and survives every hop after this one: the .env line is
// single-quoted, so ` ABC` reaches the process intact and only fails
// inside whatever third party the value was for, hours later, with no
// error of ours to go on. That happened for real — a GitHub OAuth client
// id stored with a leading space made the Connect-GitHub redirect land on
// GitHub's own 404 page, because URLSearchParams form-encoded the space.
// So normalize at the write boundary. TRIM ONLY: interior whitespace and
// interior newlines are preserved, non-strings pass through untouched so
// the type guards below keep producing their own errors, and a
// whitespace-only value collapses to '' and is then refused by
// validateValue() rather than stored.
//
// Same rule as app-secrets.normalizeValue — deliberately duplicated
// rather than shared, like computeLast4 below, so the two DAOs stay
// segregated (see the module header).
export function normalizeValue<T>(value: T): T {
  return (typeof value === 'string' ? value.trim() : value) as T;
}

// Deliberately PURE — scripts/dump-platform-env.js re-runs this on the
// deploy's read path, where a validator that mutated its input would be a
// surprise. Normalization is normalizeValue()'s job, called explicitly.
export function validateValue(value: unknown): string | null {
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
export function isWritableKey(key: unknown): boolean {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false;
  if (PLATFORM_ENV_UNWRITABLE.has(key)) return false;
  if (RESERVED_KEYS.has(key)) return false;
  if (RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p))) return false;
  return true;
}

// Private keys store no last-4: unlike a non-private value (where a
// preview is useful and harmless), 4 characters of a token is 4
// characters of a token. Same rule as app-secrets.computeLast4.
export function computeLast4(value: unknown, isPrivate: boolean): string | null {
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
 *
 * `opts.privateHint` is honoured ONLY when no declaration row exists —
 * the brand-new-variable path (services/pending-secrets.js and the
 * declare route), where the declaration is committed in the same
 * proposal but doesn't reach platform_env_declarations until the
 * post-deploy boot's reconcile. Without it a new NON-private variable
 * would fall into the undeclared→private default and never show its
 * value in the panel. It cannot weaken anything: a declared key ignores
 * it entirely, so the "an admin cannot downgrade privacy" invariant
 * above holds unchanged.
 */
export async function setValue(
  pool: Queryable, appId: number, key: string, value: unknown,
  { userId = null, dataKey, privateHint }: { userId?: number | null; dataKey?: string; privateHint?: boolean } = {},
): Promise<{ key: string; private: boolean }> {
  // FIRST statement: every caller — the admin route, the declare route,
  // the vote apply, pending-secrets, the app forker — gets normalization
  // for free, so no future call site can bypass it. Routes normalize too,
  // but only so a whitespace-only value is a 400 there rather than a throw
  // caught into a 500 here.
  value = normalizeValue(value);
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
  // No declaration → the caller's hint if it gave one (the
  // declare-a-new-variable path, whose declaration is committed in the
  // same proposal), otherwise treat as private. Setting a value for a key
  // nothing declares is legitimate — you set it in the same breath as the
  // proposal that declares it — and the safe default for an unknown
  // variable is "don't display it".
  const isPrivate = declRows.length
    ? !!declRows[0].private
    : (privateHint === undefined ? true : !!privateHint);

  await pool.query(
    `INSERT INTO platform_env_values (app_id, key, value_enc, value_last4, private, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_id, key)
     DO UPDATE SET value_enc   = EXCLUDED.value_enc,
                   value_last4 = EXCLUDED.value_last4,
                   private     = EXCLUDED.private,
                   updated_at  = NOW(),
                   updated_by  = EXCLUDED.updated_by`,
    [appId, key, encrypt(value, dataKey), computeLast4(value, isPrivate), isPrivate, userId]
  );
  return { key, private: isPrivate };
}

/** Remove a stored value. The declaration (if any) is untouched. */
export async function deleteValue(pool: Queryable, appId: number, key: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM platform_env_values WHERE app_id = $1 AND key = $2',
    [appId, key]
  );
  return (rowCount ?? 0) > 0;
}


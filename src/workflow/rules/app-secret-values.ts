// An app secret's value rule and its write (the `app_secrets` table).
// services/app-secrets.js re-exports them beside its read and deploy paths.
// Deliberately separate from platform-vars.ts, as the two DAOs are.

import type { Queryable } from './db.ts';
import { encrypt } from './secrets.ts';

// Surrounding whitespace on a pasted value is invisible in the panel and
// survives every hop after this one — it reaches the app's container env
// intact and only fails inside whatever third party the value was for.
// So normalize at the write boundary. TRIM ONLY: interior whitespace and
// newlines are preserved, non-strings pass through untouched so the type
// guard in setValue keeps producing its own error, and a whitespace-only
// value collapses to '' and is then refused rather than stored.
//
// Same rule as platform-env.normalizeValue — deliberately duplicated
// rather than shared, like computeLast4 below, so the two DAOs stay
// segregated (see that module's header).
export function normalizeValue<T>(value: T): T {
  return (typeof value === 'string' ? value.trim() : value) as T;
}

function computeLast4(value: unknown, sensitive: boolean): string | null {
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
export async function setValue(
  pool: Queryable, appId: number, key: string, value: unknown,
  { sensitive = false, userId = null, dataKey }: { sensitive?: boolean; userId?: number | null; dataKey?: string },
): Promise<void> {
  // FIRST statement: every caller — the admin route, the declare route,
  // the vote apply, pending-secrets, the app forker — gets normalization
  // for free, so no future call site can bypass it.
  value = normalizeValue(value);
  if (typeof value !== 'string' || !value.length) {
    throw new Error('app-secrets.setValue: non-empty string value required');
  }
  const valueEnc = encrypt(value, dataKey);
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


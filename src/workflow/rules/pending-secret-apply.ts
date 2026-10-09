// The values a proposal declared, written when it merges: inside the
// merge-followups machine's transaction, so they commit with the merge or
// not at all (services/pending-secrets.js holds them until then and
// re-exports this).

import type { Queryable } from './db.ts';
import { decrypt } from './secrets.ts';
import * as platformVars from './platform-vars.ts';
import * as appSecretValues from './app-secret-values.ts';

export interface Applied {
  applied: { key: string; scope: string; private: boolean; hadValue: boolean; userId: number | null }[];
  refused: { key: string; scope: string; reason: string }[];
}

/**
 * Merge-time apply inside the caller's transaction (the merge-followups
 * workflow machine, src/workflow/merge-followups/), so the values commit
 * with the merge or not at all. Each row is locked, written to its scope's
 * store and marked applied in that one transaction: no claim-then-write gap.
 *
 * A value that cannot be written (a platform key that is not writable, a
 * value the scope refuses) is not an error of the merge: its row is
 * discarded and it comes back under `refused` with the reason, for the
 * thread to say. Database errors throw, and with them the whole merge
 * transition, which is retried.
 *
 * Returns { applied: [{ key, scope, private, hadValue, userId }],
 *           refused: [{ key, scope, reason }] }.
 */
export async function applyInTransaction(db: Queryable, { sessionId, dataKey }: { sessionId: number; dataKey: string }): Promise<Applied> {
  const { rows } = await db.query(
    `SELECT id, app_id, scope, key, declaration, value_enc, value_applied_at, created_by
       FROM pending_secret_declarations
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY id
      FOR UPDATE`,
    [sessionId]
  );
  const applied: Applied['applied'] = [];
  const refused: Applied['refused'] = [];
  for (const r of rows) {
    const isPrivate = !!(r.declaration || {}).private;
    let hadValue = !!r.value_applied_at;
    let reason: string | null = null;
    if (r.value_enc) {
      // A process without the data key would read every held value as
      // unreadable and discard it: that is a configuration fault, never a
      // verdict about the values.
      if (!dataKey) throw new Error('The data encryption key is not configured; the declared values cannot be read');
      const plaintext = decrypt(r.value_enc, dataKey);
      if (plaintext == null) {
        reason = 'its value could no longer be read';
      } else if (r.scope === 'platform') {
        const value = platformVars.normalizeValue(plaintext);
        if (!platformVars.isWritableKey(r.key)) reason = 'that variable is set by the deploy and cannot be written here';
        else if (platformVars.validateValue(value)) reason = platformVars.validateValue(value);
        else {
          await platformVars.setValue(db, r.app_id, r.key, value, {
            userId: r.created_by || null, dataKey, privateHint: isPrivate,
          });
          hadValue = true;
        }
      } else if (!appSecretValues.normalizeValue(plaintext)) {
        reason = 'its value is empty';
      } else {
        await appSecretValues.setValue(db, r.app_id, r.key, plaintext, {
          sensitive: isPrivate, userId: r.created_by || null, dataKey,
        });
        hadValue = true;
      }
    }
    if (reason) {
      await db.query(
        `UPDATE pending_secret_declarations SET status = 'discarded', value_enc = NULL WHERE id = $1`, [r.id]);
      refused.push({ key: r.key, scope: r.scope, reason });
      continue;
    }
    await db.query(
      `UPDATE pending_secret_declarations
          SET status = 'applied', value_enc = NULL,
              value_applied_at = CASE WHEN $2::boolean THEN COALESCE(value_applied_at, NOW()) ELSE value_applied_at END
        WHERE id = $1`,
      [r.id, hadValue && !!r.value_enc]
    );
    applied.push({ key: r.key, scope: r.scope, private: isPrivate, hadValue, userId: r.created_by || null });
  }
  return { applied, refused };
}


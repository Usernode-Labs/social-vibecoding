// What app-delivery reads inside its transaction, after the instance lock.

import type { Tx } from '../kernel/index.ts';

export interface Facts {
  app: { slug: string; selfHosted: boolean; repoUrl: string | null; mainSha: string | null } | null;
  // Merges of this app still waiting to go live (delivering or
  // deploy_failed), whichever way they asked. Read only when a deploy
  // succeeded: those it did not answer itself hear it.
  waitingMerges: string[];
}

export async function readFacts(tx: Tx, appId: number, { waitingMerges = false } = {}): Promise<Facts> {
  const { rows: [a] } = await tx.query(
    'SELECT slug, self_hosted, repo_url, main_sha FROM apps WHERE id = $1', [appId]);
  const app = a ? { slug: a.slug, selfHosted: !!a.self_hosted, repoUrl: a.repo_url || null, mainSha: a.main_sha || null } : null;
  if (!waitingMerges) return { app, waitingMerges: [] };
  const { rows } = await tx.query(
    `SELECT key FROM wf_instances
      WHERE machine = 'merge-followups' AND app_id = $1 AND state IN ('delivering', 'deploy_failed')
        AND data->>'role' = 'merge'
      ORDER BY key`, [appId]);
  return { app, waitingMerges: rows.map((r: { key: string }) => r.key) };
}

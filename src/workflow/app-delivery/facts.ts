// What app-delivery reads inside its transaction, after the instance lock.

import type { Tx } from '../kernel/index.ts';

export interface Facts {
  app: { slug: string; selfHosted: boolean; repoUrl: string | null; mainSha: string | null } | null;
  // Merges of this app waiting for a deploy that did not ask here: the ones
  // merge-followups decided on its own work path (before this machine ran,
  // or in a process without it). Read only when a deploy succeeded.
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
        AND data->>'role' = 'merge' AND data->>'delivery' IS DISTINCT FROM 'app-delivery'
      ORDER BY key`, [appId]);
  return { app, waitingMerges: rows.map((r: { key: string }) => r.key) };
}

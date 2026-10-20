// What app-delivery reads inside its transaction, after the instance lock.

import type { Tx } from '../kernel/index.ts';

export interface Facts {
  app: { slug: string; selfHosted: boolean; repoUrl: string | null; mainSha: string | null; status: string } | null;
  // The last deploy failure the row records (staging.deployProduction):
  // its kind (root_image, …) and the commit it was of.
  lastFailure: { kind: string | null; sha: string | null } | null;
  // Where the app runs (its row's runtime, else the platform's).
  runtimeKind: string | null;
  // Whether GitHub is configured: without it an app has no repository, and
  // its deploy builds its starter files.
  githubOn: boolean;
  // Merges of this app still waiting to go live (delivering or
  // deploy_failed), whichever way they asked. Read only when a deploy
  // succeeded: those it did not answer itself hear it.
  waitingMerges: string[];
}

export interface Platform { githubOn: boolean; runtimeMode: string | null }

const asRecord = (v: unknown): any => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return typeof v === 'object' ? v : null;
};

export async function readFacts(tx: Tx, appId: number, platform: Platform, { waitingMerges = false } = {}): Promise<Facts> {
  const { rows: [a] } = await tx.query(
    'SELECT slug, self_hosted, repo_url, main_sha, status, last_failure, runtime_kind FROM apps WHERE id = $1', [appId]);
  const app = a ? { slug: a.slug, selfHosted: !!a.self_hosted, repoUrl: a.repo_url || null, mainSha: a.main_sha || null,
    status: String(a.status) } : null;
  const failure = asRecord(a?.last_failure);
  const lastFailure = failure ? { kind: failure.kind ? String(failure.kind) : null,
    sha: failure.sha ? String(failure.sha).toLowerCase() : null } : null;
  const base = { app, lastFailure, runtimeKind: a?.runtime_kind || platform.runtimeMode, githubOn: platform.githubOn };
  if (!waitingMerges) return { ...base, waitingMerges: [] };
  const { rows } = await tx.query(
    `SELECT key FROM wf_instances
      WHERE machine = 'merge-followups' AND app_id = $1 AND state IN ('delivering', 'deploy_failed')
        AND data->>'role' = 'merge'
      ORDER BY key`, [appId]);
  return { ...base, waitingMerges: rows.map((r: { key: string }) => r.key) };
}

// What the preview machine reads inside a transition: the proposal's row
// (locked first, then read by the next statement, so what a turn or a merge
// committed while the lock was waited for is seen) and its app.

import type { Tx } from '../kernel/index.ts';

export interface Session {
  id: number;
  appId: number;
  status: string;
  source: 'imported' | 'cli_handoff' | null;
  userId: number | null;
  isHeadless: boolean;
  shared: boolean;
  branchName: string | null;
  prNumber: number | null;
  // The head a revision must equal, by row kind (null: the newest wins).
  pin: string | null;
  // The error lane retries this row's 'error' verdicts on its own.
  retryScope: boolean;
  // The preview [main] built before the flag, as the row names it.
  staging: {
    url: string | null; containerId: string | null; imageRef: string | null; buildRef: string | null;
    runtimeKind: string | null; runtimeName: string | null; commitSha: string | null;
  };
  checks: { commitSha: string | null; state: string | null };
}

export interface App { id: number; slug: string; selfHosted: boolean; repoUrl: string | null }

export interface Facts { session: Session | null; app: App | null }

export const OPEN = new Set(['active', 'paused', 'promoted', 'merging']);
const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);

// One rule per row kind (P-A2): an imported pull request follows GitHub's
// head; a promoted native proposal its reviewed head; an active CLI
// hand-off the upload it submitted. A native proposal being worked on has
// no stored pin: its turns and updates are serialised per session.
export function pinOf(r: any): string | null {
  if (r.source === 'imported') return sha(r.imported_pr_head_sha);
  if (r.status === 'promoted' || r.status === 'merging') return sha(r.reviewed_head_sha);
  if (r.source === 'cli_handoff') return sha(r.handoff_head_sha);
  return null;
}

// staging-recovery.findStuckCheckSessions' scope: a promoted proposal, or an
// active CLI hand-off with a head, and a branch to build.
function retryScope(r: any): boolean {
  if (!r.branch_name) return false;
  if (r.status === 'promoted') return true;
  return r.status === 'active' && r.source === 'cli_handoff' && !!(r.checks_commit_sha || r.handoff_head_sha);
}

export async function readFacts(tx: Tx, sessionId: number): Promise<Facts> {
  await tx.query('SELECT 1 FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows: [r] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.source, cs.user_id, cs.is_headless, cs.shared_at, cs.branch_name,
            cs.pr_number, cs.imported_pr_head_sha, cs.reviewed_head_sha, cs.handoff_head_sha,
            cs.checks_commit_sha, cs.check_state,
            cs.staging_url, cs.staging_container_id, cs.staging_image_ref, cs.staging_build_ref,
            cs.staging_runtime_kind, cs.staging_runtime_name, cs.staging_commit_sha,
            a.slug AS app_slug, a.self_hosted, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [sessionId]);
  if (!r) return { session: null, app: null };
  return {
    session: {
      id: r.id, appId: r.app_id, status: r.status,
      source: r.source === 'imported' || r.source === 'cli_handoff' ? r.source : null,
      userId: r.user_id ?? null, isHeadless: !!r.is_headless, shared: !!r.shared_at,
      branchName: r.branch_name ?? null, prNumber: r.pr_number ?? null,
      pin: pinOf(r), retryScope: retryScope(r),
      staging: {
        url: r.staging_url ?? null, containerId: r.staging_container_id ?? null,
        imageRef: r.staging_image_ref ?? null, buildRef: r.staging_build_ref ?? null,
        runtimeKind: r.staging_runtime_kind ?? null, runtimeName: r.staging_runtime_name ?? null,
        commitSha: sha(r.staging_commit_sha),
      },
      checks: { commitSha: sha(r.checks_commit_sha), state: r.check_state ?? null },
    },
    app: { id: r.app_id, slug: r.app_slug, selfHosted: !!r.self_hosted, repoUrl: r.repo_url ?? null },
  };
}

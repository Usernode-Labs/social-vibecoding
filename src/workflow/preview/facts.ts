// What the preview machine reads inside a transition: the proposal's row
// (locked first for a decision about its preview or checks, then read by
// the next statement, so what a turn or a merge committed while the lock
// was waited for is seen), its app, who else is working on it, and which
// of the processes its operations name are still alive.

import type { Tx } from '../kernel/index.ts';
import { holderAliveSql } from '../rules/presence.ts';
import { shotsRunningSql } from '../session-work.ts';

export interface Session {
  id: number;
  appId: number;
  userId: number | null;
  status: string;
  source: 'imported' | 'cli_handoff' | null;
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
  testing: { md: string | null; path: string | null };
  // Old flows working on it, from their own durable records.
  turnRunning: boolean;         // active_turn: a coding turn's journal
  localTurnRunning: boolean;    // local_agent_turns: a turn on the author's machine
  shotsRunning: boolean;        // the shots machine has a run under way
}

export interface App { id: number; slug: string; selfHosted: boolean; repoUrl: string | null }

export interface Facts {
  session: Session | null;
  app: App | null;
  // Of the processes the instance's operations name, those still alive.
  alive: ReadonlySet<string>;
}

export const OPEN: ReadonlySet<string> = new Set(['active', 'paused', 'promoted', 'merging']);
const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);

// One rule per row kind: an imported pull request follows GitHub's head; a
// promoted native proposal its reviewed head; an active CLI hand-off the
// upload it submitted. A native proposal being worked on has no stored pin:
// its turns and updates are serialised per session.
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

// `lock`: a decision about the preview or the checks (every event but an
// operation's own record). `holders`: the processes to test for life.
export async function readFacts(tx: Tx, sessionId: number,
  { lock = true, holders = [] }: { lock?: boolean; holders?: string[] } = {}): Promise<Facts> {
  if (lock) await tx.query('SELECT 1 FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows: [r] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.user_id, cs.status, cs.source, cs.is_headless, cs.shared_at, cs.branch_name,
            cs.pr_number, cs.imported_pr_head_sha, cs.reviewed_head_sha, cs.handoff_head_sha,
            cs.checks_commit_sha, cs.check_state, cs.testing_md, cs.testing_path,
            cs.staging_url, cs.staging_container_id, cs.staging_image_ref, cs.staging_build_ref,
            cs.staging_runtime_kind, cs.staging_runtime_name, cs.staging_commit_sha,
            cs.active_turn IS NOT NULL AS turn_running,
            EXISTS (SELECT 1 FROM local_agent_turns t
                     WHERE t.session_id = cs.id AND t.status IN ('queued', 'offered', 'accepted', 'running')) AS local_turn_running,
            ${shotsRunningSql('cs.id')} AS shots_running,
            a.slug AS app_slug, a.self_hosted, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [sessionId]);
  const alive = new Set<string>();
  if (holders.length) {
    const { rows } = await tx.query(
      `SELECT h AS holder FROM unnest($1::text[]) AS h WHERE ${holderAliveSql('h')}`, [holders]);
    for (const x of rows) alive.add(String(x.holder));
  }
  if (!r) return { session: null, app: null, alive };
  return {
    session: {
      id: r.id, appId: r.app_id, userId: r.user_id ?? null, status: r.status,
      source: r.source === 'imported' || r.source === 'cli_handoff' ? r.source : null,
      isHeadless: !!r.is_headless, shared: !!r.shared_at,
      branchName: r.branch_name ?? null, prNumber: r.pr_number ?? null,
      pin: pinOf(r), retryScope: retryScope(r),
      staging: {
        url: r.staging_url ?? null, containerId: r.staging_container_id ?? null,
        imageRef: r.staging_image_ref ?? null, buildRef: r.staging_build_ref ?? null,
        runtimeKind: r.staging_runtime_kind ?? null, runtimeName: r.staging_runtime_name ?? null,
        commitSha: sha(r.staging_commit_sha),
      },
      checks: { commitSha: sha(r.checks_commit_sha), state: r.check_state ?? null },
      testing: { md: r.testing_md ?? null, path: r.testing_path ?? null },
      turnRunning: !!r.turn_running, localTurnRunning: !!r.local_turn_running, shotsRunning: !!r.shots_running,
    },
    app: { id: r.app_id, slug: r.app_slug, selfHosted: !!r.self_hosted, repoUrl: r.repo_url ?? null },
    alive,
  };
}

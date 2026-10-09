// What the merge-followups machine reads inside a transition: the proposal's
// row and its app. Cheap, indexed, one row each. The row is locked only for
// a creating event, whose transition moves it into 'merged'; the lock is
// taken first, and everything is read by the next statement, because a
// statement that waited for a lock keeps the snapshot it started with (what
// the merge or a turn committed meanwhile would be missing).

import type { Tx } from '../kernel/index.ts';

export interface Session {
  id: number;
  appId: number;
  status: string;
  userId: number | null;
  prNumber: number | null;
  prTitle: string | null;
  linkedIssues: number[];
  agentSessionId: number | null;
  activeTurn: boolean;
  // The commit its vote is on (an import's PR head, else the reviewed head).
  head: string | null;
  // Work under way on it that a merge carrying it must not cut across: a
  // live shots run (LIVE_SHOTS_RUN), or checks running (a check_runs
  // manifest heartbeated in the last minute, or a pending verdict younger
  // than the ten minutes after which the sweeps call it stuck).
  shotsRunning: boolean;
  checksRunning: boolean;
  isHeadless: boolean;
  pendingSecrets: boolean;
  // The preview, as the merge found it: demo mode deploys its image.
  staging: { imageRef: string; buildRef: string | null; commitSha: string } | null;
}

export interface App {
  id: number;
  slug: string;
  name: string;
  repo: { owner: string; repo: string } | null;
  selfHosted: boolean;
  demoMode: boolean;
  // The platform's own app: the builds platform processes booted with,
  // newest first (apps.booted_shas, written by those processes; not
  // main_sha, which the migration Job writes from the incoming release
  // before the rollout).
  booted: { sha: string; at: string }[];
}

export interface Facts { session: Session | null; app: App | null }

// A shots run still using its proposal's worker, read from its own row
// (`r`, shot_runs): not finished, and heard from lately. A live run renews
// updated_at every 30 seconds; a run silent for five minutes (forty-five
// for one that never reported progress) is one services/shots-gc.js
// recovers as interrupted, and no longer holds anything. This is what
// worker.js's in-memory hold said, in the process that held it.
export const LIVE_SHOTS_RUN = `r.state IN ('planned', 'provisioning', 'exploring', 'replaying', 'reviewing')
     AND r.updated_at > NOW() - (CASE WHEN COALESCE(r.trace_summary, '{}'::jsonb) ? 'progress'
                                      THEN INTERVAL '5 minutes' ELSE INTERVAL '45 minutes' END)`;

// The newest such run of one change, or null: worker.retire's read.
export async function liveShotsRun(db: Pick<Tx, 'query'>, sessionId: number): Promise<string | null> {
  const { rows: [r] } = await db.query(
    `SELECT r.id FROM shot_runs r WHERE r.session_id = $1 AND ${LIVE_SHOTS_RUN} ORDER BY r.created_at DESC LIMIT 1`,
    [sessionId]);
  return r ? String(r.id) : null;
}

export function parseRepo(url: unknown): { owner: string; repo: string } | null {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

const issueNumbers = (v: unknown): number[] =>
  [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

export async function readFacts(tx: Tx, sessionId: number, { lock }: { lock: boolean }): Promise<Facts> {
  if (lock) await tx.query('SELECT 1 FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows: [s] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.user_id, cs.pr_number, cs.pr_title, cs.linked_issues,
            cs.agent_session_id, cs.active_turn IS NOT NULL AS active_turn, cs.is_headless,
            CASE WHEN cs.source = 'imported' THEN cs.imported_pr_head_sha ELSE cs.reviewed_head_sha END AS head,
            EXISTS (SELECT 1 FROM shot_runs r WHERE r.session_id = cs.id AND ${LIVE_SHOTS_RUN}) AS shots_running,
            (EXISTS (SELECT 1 FROM check_runs k WHERE k.session_id = cs.id AND k.heartbeat_at > NOW() - INTERVAL '60 seconds')
              OR (cs.check_state = 'pending' AND cs.checks_checked_at > NOW() - INTERVAL '10 minutes')) AS checks_running,
            cs.staging_image_ref, cs.staging_build_ref, cs.staging_commit_sha,
            EXISTS (SELECT 1 FROM pending_secret_declarations p
                     WHERE p.session_id = cs.id AND p.status = 'pending') AS pending_secrets
       FROM chat_sessions cs WHERE cs.id = $1`, [sessionId]);
  if (!s) return { session: null, app: null };
  const { rows: [a] } = await tx.query(
    'SELECT id, slug, name, repo_url, self_hosted, demo_mode, booted_shas FROM apps WHERE id = $1', [s.app_id]);
  return {
    session: {
      id: s.id, appId: s.app_id, status: s.status, userId: s.user_id ?? null,
      prNumber: s.pr_number ?? null, prTitle: s.pr_title ?? null, linkedIssues: issueNumbers(s.linked_issues),
      agentSessionId: s.agent_session_id ?? null, activeTurn: !!s.active_turn, isHeadless: !!s.is_headless,
      head: /^[0-9a-f]{40}$/i.test(String(s.head || '')) ? String(s.head).toLowerCase() : null,
      shotsRunning: !!s.shots_running, checksRunning: !!s.checks_running,
      pendingSecrets: !!s.pending_secrets,
      staging: s.staging_image_ref && s.staging_commit_sha
        ? { imageRef: s.staging_image_ref, buildRef: s.staging_build_ref ?? null, commitSha: s.staging_commit_sha } : null,
    },
    app: a ? {
      id: a.id, slug: a.slug, name: a.name, repo: parseRepo(a.repo_url),
      selfHosted: !!a.self_hosted, demoMode: !!a.demo_mode,
      booted: (Array.isArray(a.booted_shas) ? a.booted_shas : [])
        .filter((b: any) => /^[0-9a-f]{40}$/i.test(String(b?.sha || '')) && !Number.isNaN(Date.parse(b?.at)))
        .map((b: any) => ({ sha: String(b.sha).toLowerCase(), at: new Date(b.at).toISOString() })),
    } : null,
  };
}

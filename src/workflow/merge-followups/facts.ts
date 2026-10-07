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
}

export interface Facts { session: Session | null; app: App | null }

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
            cs.staging_image_ref, cs.staging_build_ref, cs.staging_commit_sha,
            EXISTS (SELECT 1 FROM pending_secret_declarations p
                     WHERE p.session_id = cs.id AND p.status = 'pending') AS pending_secrets
       FROM chat_sessions cs WHERE cs.id = $1`, [sessionId]);
  if (!s) return { session: null, app: null };
  const { rows: [a] } = await tx.query(
    'SELECT id, slug, name, repo_url, self_hosted, demo_mode FROM apps WHERE id = $1', [s.app_id]);
  return {
    session: {
      id: s.id, appId: s.app_id, status: s.status, userId: s.user_id ?? null,
      prNumber: s.pr_number ?? null, prTitle: s.pr_title ?? null, linkedIssues: issueNumbers(s.linked_issues),
      agentSessionId: s.agent_session_id ?? null, activeTurn: !!s.active_turn, isHeadless: !!s.is_headless,
      pendingSecrets: !!s.pending_secrets,
      staging: s.staging_image_ref && s.staging_commit_sha
        ? { imageRef: s.staging_image_ref, buildRef: s.staging_build_ref ?? null, commitSha: s.staging_commit_sha } : null,
    },
    app: a ? {
      id: a.id, slug: a.slug, name: a.name, repo: parseRepo(a.repo_url),
      selfHosted: !!a.self_hosted, demoMode: !!a.demo_mode,
    } : null,
  };
}

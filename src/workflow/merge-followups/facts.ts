// What the merge-followups machine reads inside a transition: the proposal's
// row and its app. Cheap, indexed, one row each. The row is locked only for
// a creating event, whose transition moves it into 'merged'; the lock is
// taken first, and everything is read by the next statement, because a
// statement that waited for a lock keeps the snapshot it started with (what
// the merge or a turn committed meanwhile would be missing).

import type { Tx } from '../kernel/index.ts';
import { SHOTS_LIVE_STATES, botLookingSql, operationsLiveSql, previewWorkingSql, shotsRunningSql, syncWorkingSql } from '../session-work.ts';
import { reviewedHeadForSession } from '../rules/bot-readiness.ts';
import { parseRepoAddress } from '../rules/github-url.ts';

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
  // shots run under way (shotsRunningSql), or checks running (a check_runs
  // manifest heartbeated in the last minute, or a pending verdict younger
  // than the ten minutes after which the sweeps call it stuck; with the
  // preview machine, its build or run under way: session-work.ts).
  shotsRunning: boolean;
  checksRunning: boolean;
  // An old flow's operation on it that keeps no record of its own (a sync,
  // a dispatch, an upload), as the preview machine records it, or a turn on
  // the author's own machine (local_agent_turns).
  workedOn: boolean;
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

// The run of one change's shots still under way, or null: worker.retire's
// read (src/workflow/session-work.ts).
export async function liveShotsRun(db: Pick<Tx, 'query'>, sessionId: number): Promise<string | null> {
  const { rows: [r] } = await db.query(
    `SELECT w.data->'run'->>'id' AS id FROM wf_instances w
      WHERE w.machine = 'shots' AND w.key = $1 AND w.state = ANY($2::text[])`,
    [`session:${sessionId}`, [...SHOTS_LIVE_STATES]]);
  return r ? String(r.id || 'run') : null;
}

// A change that went live inside another one.
//
// A change can be built on top of another open change: the Homeroom bot
// asked to "fix mark as done in Jordan's first version" built its fix on the
// first version's branch, so the fix's pull request carried the first
// version's commit as well as its own (Flat 4B Chores, 5 Oct 2026: PR 8 built
// on PR 3). When the fix merged, the first version's work went live with it,
// but nothing said so: GitHub squashes, so PR 3's own commit is not on main
// and GitHub never marked it merged. PR 3 stayed open and still asked for
// votes, its lazy window would have tried to merge it again, request #1 stayed
// open, and the App tab kept saying the first version was being built over
// the live app.
//
// So when a change merges, every other change of the app that is up for a
// vote and whose head commit is one of the merged pull request's own commits
// (GitHub's list of the commits on it, which it keeps after a squash merge)
// is INCLUDED in it. The signal is exact and costs one GitHub read per merge,
// and none when nothing else is up for a vote: a head on that list is a
// commit the merged change brought to main, so the included change has
// nothing left that is not live. A head the list does not have (a newer
// revision, a change never built on) is left alone, and a change already on
// main before the merge is never on the list, so the other order (the lower
// change merging first) includes nothing.
//
// An included change is marked merged with the merge it went live in
// (merged_at and merge_commit_sha are that merge's, so its deploy state is
// that merge's) and `included_in_session_id` names the change that carried
// it. Being merged is what every reader already understands: the vote panel,
// Needs you and the lazy window only look at changes up for a vote, a vote on
// it is refused, its requests read "approved and live", and a project's first
// version reads live (homeroom-bot-dm.js firstVersionState). What a merge
// does for a change is then done for it.
//
// included.find reads the candidates: the app's other changes up for a vote, with a pull request and a recorded head. Not
// one whose turn is running (a revision may be on its way, and it decides),
// and not one holding a secret value for a variable it declares: that value
// is applied only by the change's own merge (services/pending-secrets.js),
// so it waits for that. The machine reads the same conditions again under
// the change's own lock (machine.ts notIncludable).
export const INCLUDED_CANDIDATES_SQL = `SELECT cs.id, cs.source, cs.reviewed_head_sha, cs.imported_pr_head_sha
   FROM chat_sessions cs
  WHERE cs.app_id = $1 AND cs.id <> $2
    AND cs.status = 'promoted' AND cs.is_headless = FALSE
    AND cs.pr_number IS NOT NULL AND cs.active_turn IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pending_secret_declarations p
       WHERE p.session_id = cs.id AND p.status = 'pending'
    )
  ORDER BY cs.id`;

const fullSha = (v: unknown): string | null => {
  const sha = String(v || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
};

// The candidates whose head (an import's PR head, else the reviewed head)
// is one of `commitShas`, the merged pull request's own commits, each named
// with that head. GitHub squashes, so a change built on another open change
// carries its commit: a head on that list is a commit the merge brought to
// main. A candidate with no recorded head is never one.
export function includedIn(candidates: any[], commitShas: unknown): { id: number; head: string }[] {
  const listed = new Set((Array.isArray(commitShas) ? commitShas : []).map(fullSha).filter(Boolean));
  const out: { id: number; head: string }[] = [];
  for (const c of candidates || []) {
    const head = fullSha(reviewedHeadForSession(c));
    if (head && listed.has(head)) out.push({ id: Number(c.id), head });
  }
  return out;
}

// A pull request based on another one's branch (a stacked one) merges into
// that branch: its merge commit never reaches main, and the other's merge
// brings the change there inside its squash, with that commit among its
// own. carried.find reads who may have carried it: the app's merges since
// it (or since the last one it ruled out, $3/$4), oldest first, a page at a
// time. The carrier is the first whose pull request lists the commit and
// whose recorded merge commit the build that looked contains; it is named
// by the change that merged it to main (a carried merge's or an included
// change's carrier: a chain of stacked pull requests ends there).
export const CARRIER_CANDIDATES_SQL = `SELECT cs.id, cs.pr_number, cs.merged_at, cs.merge_commit_sha,
        root.id AS carrier_id, root.pr_number AS carrier_pr_number, root.pr_title AS carrier_pr_title
   FROM chat_sessions cs
   JOIN chat_sessions root ON root.id = COALESCE(cs.included_in_session_id, cs.id)
  WHERE cs.app_id = $1 AND cs.id <> $2 AND root.id <> $2 AND cs.status = 'merged'
    AND cs.pr_number IS NOT NULL AND cs.merge_commit_sha IS NOT NULL AND cs.merged_at IS NOT NULL
    AND (cs.merged_at, cs.id) > ($3::timestamptz, $4::int)
  ORDER BY cs.merged_at, cs.id
  LIMIT 50`;

// Whether `commitShas` (a pull request's own commits) lists `sha`.
export function lists(commitShas: unknown, sha: unknown): boolean {
  const want = fullSha(sha);
  return !!want && (Array.isArray(commitShas) ? commitShas : []).some((c) => fullSha(c) === want);
}

// The app's repository, on whichever host (rules/github-url.ts).
export function parseRepo(url: unknown): { owner: string; repo: string } | null {
  return parseRepoAddress(url);
}

const issueNumbers = (v: unknown): number[] =>
  [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

export async function readFacts(tx: Tx, sessionId: number, { lock }: { lock: boolean }): Promise<Facts> {
  if (lock) await tx.query('SELECT 1 FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows: [s] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.user_id, cs.pr_number, cs.pr_title, cs.linked_issues,
            cs.agent_session_id, cs.active_turn IS NOT NULL AS active_turn, cs.is_headless,
            CASE WHEN cs.source = 'imported' THEN cs.imported_pr_head_sha ELSE cs.reviewed_head_sha END AS head,
            ${shotsRunningSql('cs.id')} AS shots_running,
            (EXISTS (SELECT 1 FROM check_runs k WHERE k.session_id = cs.id AND k.heartbeat_at > NOW() - INTERVAL '60 seconds')
              OR (cs.check_state = 'pending' AND cs.checks_checked_at > NOW() - INTERVAL '10 minutes')
              OR ${previewWorkingSql('cs.id')}) AS checks_running,
            (${operationsLiveSql('cs.id')} OR ${syncWorkingSql('cs.id')} OR ${botLookingSql('cs.id')}
              OR EXISTS (SELECT 1 FROM local_agent_turns t
                          WHERE t.session_id = cs.id AND t.status IN ('queued', 'offered', 'accepted', 'running'))) AS worked_on,
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
      shotsRunning: !!s.shots_running, checksRunning: !!s.checks_running, workedOn: !!s.worked_on,
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

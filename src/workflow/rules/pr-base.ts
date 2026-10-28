// Where an imported pull request merges into: its base on GitHub, and the
// change it waits for when that base is another open change's branch.
//
// "Merged" means "in main", and main is the repository's default branch
// (GitHub's `default_branch`: `main` for every repository Homeroom makes, but
// an imported repository may use another name). GitHub merges a pull request
// into its own base, whatever that is, so a change whose base is not the
// default branch is never asked of GitHub (routes/votes.js attemptMerge reads
// the base first), and a merge GitHub reports into another branch is never
// recorded as merged or live (the proposal machine closes it as merged
// elsewhere). On 28 Oct 2026 a stack of three (#5955 → #5956 → #5957) showed
// both: #5957 was merged into #5956's branch and recorded merged, and #5956
// still targeted #5955's branch after #5955 had landed.
//
// A stacked change waits: its base is the branch of an open change of the
// same app (`chat_sessions.waits_for_session_id`), it stays out of the merge
// queue, and once that change is on main its pull request is retargeted to
// main and synced with it (the proposal machine's ParentMerged). A base that
// is neither main nor an open change's branch is refused at promotion.
//
// Every value past a GitHub read is the OTHER base: the branch a pull request
// targets when that is not its repository's default branch, and null when it
// is (or nobody read it yet). The row stores it that way
// (`chat_sessions.imported_pr_base_ref`), events carry it that way, and
// `otherBase` is the one place a GitHub payload is turned into it.

import type { Queryable } from './db.ts';

// What a repository's default branch is when GitHub does not say (a test's
// stand-in, an older payload): the platform's own name for it.
const FALLBACK_DEFAULT = 'main';

// The repository's default branch, from a pull request as GitHub returns it
// (`base.repo.default_branch`; the git host's and the staging mock's answer
// in the same shape).
export function defaultBranchOf(pr: any): string {
  const name = pr?.base?.repo?.default_branch;
  return typeof name === 'string' && name.trim() ? name.trim() : FALLBACK_DEFAULT;
}

// The branch a pull request targets when it is not its repository's default
// branch; null when it is, or GitHub named none.
export function otherBase(pr: any): string | null {
  const ref = pr?.base?.ref;
  if (typeof ref !== 'string' || !ref.trim()) return null;
  return ref.trim() === defaultBranchOf(pr) ? null : ref.trim().slice(0, 255);
}

// An other base (see the top) that says the pull request merges into main.
export function onMain(base: unknown): boolean {
  return base == null || base === '';
}

// The statuses of a change that is still open: one whose branch a stacked
// change may be built on.
export const OPEN_STATUSES: readonly string[] = ['active', 'paused', 'promoted', 'merging'];

export interface BaseOwner { id: number; prNumber: number | null; prTitle: string | null; status: string }

const repoName = (v: unknown) => {
  const m = /^(?:https?:\/\/[^/]+\/)?([a-z0-9._-]+)\/([a-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(v ?? '').trim().toLowerCase());
  return m ? `${m[1]}/${m[2]}` : null;
};
// A change whose branch can be a base: a branch of the app's own repository.
// A pull request's base is always a branch there, so an import whose head is
// on its author's fork never owns one, whatever its branch is called. An
// import from before its head repository was recorded is taken as it is.
function onAppRepo(r: any): boolean {
  if (r.source !== 'imported' || !r.imported_pr_head_repo) return true;
  return repoName(r.imported_pr_head_repo) === repoName(r.repo_url);
}

// The change of this app whose branch is `base`, other than the change
// itself: the open one (the change it waits for), else the merged one it was
// recorded waiting for (`waited`: a change that landed while the stacked one
// still targets its branch). A merged change with that branch name that it
// never waited for is nobody's parent: a long-lived branch (`develop`) whose
// own pull request was merged once is still just a branch.
export async function readBaseOwner(db: Queryable, p: { appId: number; sessionId: number | null; base: string | null; waited?: number | null }): Promise<{ open: BaseOwner | null; merged: BaseOwner | null }> {
  if (onMain(p.base)) return { open: null, merged: null };
  const { rows } = await db.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.status, cs.source, cs.imported_pr_head_repo, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.app_id = $1 AND cs.branch_name = $2 AND cs.id IS DISTINCT FROM $3::int AND cs.is_headless = FALSE
        AND (cs.status = ANY($4::text[]) OR (cs.status = 'merged' AND cs.id = $5::int))
      ORDER BY (cs.status = 'merged'), cs.id DESC`,
    [p.appId, p.base, p.sessionId, OPEN_STATUSES, p.waited ?? null]);
  const owners = rows.filter(onAppRepo);
  const of = (r: any): BaseOwner => ({ id: Number(r.id), prNumber: r.pr_number ?? null, prTitle: r.pr_title ?? null, status: r.status });
  const open = owners.find((r: any) => r.status !== 'merged');
  const merged = owners.find((r: any) => r.status === 'merged');
  return { open: open ? of(open) : null, merged: merged ? of(merged) : null };
}

// The other base (null: the default branch) and the change it waits for,
// written together: the open change whose branch it is, or the one it was
// waiting for, merged since (it waits until it has been moved onto main, so
// a look that finds it there asks again). Returns what the row now says,
// whether it changed, and that merged parent.
export async function recordBase(db: Queryable, p: { sessionId: number; appId: number; base: string | null; waited?: number | null }): Promise<{ base: string | null; waitsFor: number | null; changed: boolean; mergedOwner: BaseOwner | null }> {
  const base = typeof p.base === 'string' && p.base.trim() ? p.base.trim().slice(0, 255) : null;
  const owners = await readBaseOwner(db, { appId: p.appId, sessionId: p.sessionId, base, waited: p.waited ?? null });
  const parent = owners.open || owners.merged;
  const waitsFor = parent ? parent.id : null;
  const { rowCount } = await db.query(
    `UPDATE chat_sessions SET imported_pr_base_ref = $2, waits_for_session_id = $3
      WHERE id = $1 AND (imported_pr_base_ref IS DISTINCT FROM $2 OR waits_for_session_id IS DISTINCT FROM $3)`,
    [p.sessionId, base, waitsFor]);
  return { base, waitsFor, changed: !!rowCount, mergedOwner: owners.open ? null : owners.merged };
}

// The open changes that wait for this one: told when it reaches main.
export async function readWaiting(db: Queryable, sessionId: number): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT id FROM chat_sessions WHERE waits_for_session_id = $1 AND status = ANY($2::text[]) ORDER BY id`,
    [sessionId, OPEN_STATUSES]);
  return rows.map((r: any) => Number(r.id));
}

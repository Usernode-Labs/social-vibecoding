// Where an imported pull request merges into: its base on GitHub, and the
// change it waits for when that base is another open change's branch.
//
// "Merged" means "in main". GitHub merges a pull request into its own base,
// whatever that is, so a change whose base is not main is never asked of
// GitHub (routes/votes.js attemptMerge reads the base first), and a merge
// GitHub reports into another branch is never recorded as merged or live
// (the proposal machine closes it as merged elsewhere). On 28 Oct 2026 a
// stack of three (#5955 → #5956 → #5957) showed both: #5957 was merged into
// #5956's branch and recorded merged, and #5956 still targeted #5955's
// branch after #5955 had landed.
//
// A stacked change waits: its base is the branch of an open change of the
// same app (`chat_sessions.waits_for_session_id`), it stays out of the merge
// queue, and once that change is on main its pull request is retargeted to
// main and synced with it (the proposal machine's ParentMerged). A base that
// is neither main nor an open change's branch is refused at promotion.

import type { Queryable } from './db.ts';

export const MAIN_BRANCH = 'main';

// A stored base of NULL is one not read yet (a row imported before the
// column, or a native proposal, which Homeroom always opens against main):
// read as main, since the merge attempt reads GitHub's own answer anyway.
export function onMain(base: unknown): boolean {
  return base == null || base === '' || String(base) === MAIN_BRANCH;
}

// The statuses of a change that is still open: one whose branch a stacked
// change may be built on.
export const OPEN_STATUSES: readonly string[] = ['active', 'paused', 'promoted', 'merging'];

export interface BaseOwner { id: number; prNumber: number | null; prTitle: string | null; status: string }

// The change of this app whose branch is `base`, other than the change
// itself: the open one (the change it waits for), else the newest merged one
// (a change that landed while the stacked one still targets its branch).
export async function readBaseOwner(db: Queryable, p: { appId: number; sessionId: number | null; base: string | null }): Promise<{ open: BaseOwner | null; merged: BaseOwner | null }> {
  if (onMain(p.base)) return { open: null, merged: null };
  const { rows } = await db.query(
    `SELECT id, pr_number, pr_title, status FROM chat_sessions
      WHERE app_id = $1 AND branch_name = $2 AND id IS DISTINCT FROM $3::int AND is_headless = FALSE
        AND status = ANY($4::text[] || ARRAY['merged'])
      ORDER BY (status = 'merged'), id DESC`,
    [p.appId, p.base, p.sessionId, OPEN_STATUSES]);
  const of = (r: any): BaseOwner => ({ id: Number(r.id), prNumber: r.pr_number ?? null, prTitle: r.pr_title ?? null, status: r.status });
  const open = rows.find((r: any) => r.status !== 'merged');
  const merged = rows.find((r: any) => r.status === 'merged');
  return { open: open ? of(open) : null, merged: merged ? of(merged) : null };
}

// The base as GitHub reported it, and the open change it waits for, written
// together. Returns what the row now says and whether it changed.
export async function recordBase(db: Queryable, p: { sessionId: number; appId: number; base: string | null }): Promise<{ base: string | null; waitsFor: number | null; changed: boolean; mergedOwner: BaseOwner | null }> {
  const base = typeof p.base === 'string' && p.base.trim() ? p.base.trim().slice(0, 255) : null;
  const owners = await readBaseOwner(db, { appId: p.appId, sessionId: p.sessionId, base });
  const waitsFor = owners.open ? owners.open.id : null;
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

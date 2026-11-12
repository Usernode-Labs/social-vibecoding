// What a merge claim reads again under the proposal's row lock, once the
// merge gate (routes/votes.js evaluateMergeGate, the proposal machine's
// merge.gate work) has found a proposal ready: every input the gate decided
// on that the database holds. The gate measured the rest moments before, in
// its work (the live revision, the protected-settings check, the mirror's
// merge, the platform variables); a vote, a verdict, a waiver or a red main
// committed since is counted here (merge trace bug 3). The vote gate itself
// is rules/pr-gate.ts, read beside this.

import type { Queryable } from './db.ts';
import { currentVotePredicateSql } from './vote-predicate.ts';

export interface ClaimFacts {
  checkState: string | null;
  checksCommitSha: string | null;
  // A verdict copied from an earlier pass whose unit suite a person asked to
  // run again (services/unit-suite-row.js freshSuiteOwed).
  freshSuiteOwed: boolean;
  shotsState: string | null;
  shotsDetail: Record<string, unknown> | null;
  locked: boolean;
  adminYes: boolean;
  // #6643: held for an admin (services/release-holds.js), and whether a full
  // admin other than the author has a yes that still counts.
  held: boolean;
  holdAdminYes: boolean;
  // #6642: the commit the Content rules review flagged, while
  // CONTENT_REVIEW_MODE is `admin`; null in every other mode. A flag on the
  // claimed head needs a full admin's yes, like a locked app.
  contentFlagSha: string | null;
  // The app's merges are paused by a red main (services/main-watch.js
  // describe: its own column, or red at a commit no admin resumed).
  mainPaused: boolean;
}

const lower = (v: unknown) => (v == null ? null : String(v).toLowerCase());

// CONTENT_REVIEW_MODE `admin` (services/content-review.js): a flagged change
// waits for an admin instead of failing its checks or merging unremarked.
export function contentAdminHold(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.CONTENT_REVIEW_MODE ?? '').trim().toLowerCase() === 'admin';
}

export async function readClaimFacts(db: Queryable, sessionId: number): Promise<ClaimFacts | null> {
  const { rows: [r] } = await db.query(
    `SELECT cs.check_state, cs.checks_commit_sha, cs.unit_suite_fresh_sha, cs.shots_state, cs.shots_detail,
            a.locked, a.main_check_state, a.main_check_sha, a.main_check_resumed_sha, a.main_check_paused_sha,
            EXISTS (SELECT 1 FROM pr_votes pv JOIN users u ON u.id = pv.user_id
                     WHERE pv.session_id = cs.id AND pv.vote = 'yes' AND ${currentVotePredicateSql('pv', 'cs')}
                       AND u.is_admin = TRUE AND u.admin_readonly = FALSE) AS admin_yes,
            EXISTS (SELECT 1 FROM release_holds rh WHERE rh.session_id = cs.id AND rh.status = 'waiting') AS held,
            EXISTS (SELECT 1 FROM pr_votes pv JOIN users u ON u.id = pv.user_id
                     WHERE pv.session_id = cs.id AND pv.vote = 'yes' AND ${currentVotePredicateSql('pv', 'cs')}
                       AND u.is_admin = TRUE AND u.admin_readonly = FALSE
                       AND pv.user_id IS DISTINCT FROM cs.user_id) AS hold_admin_yes,
            (SELECT lower(r->>'reviewedSha')
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cs.test_results) = 'array'
                                              THEN cs.test_results ELSE '[]'::jsonb END) r
              WHERE r->>'name' = 'Content rules' AND r->>'status' = 'fail'
              LIMIT 1) AS content_flag_sha
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [sessionId]);
  if (!r) return null;
  const paused = r.main_check_paused_sha !== undefined
    ? !!r.main_check_paused_sha
    : ((r.main_check_state === 'failing' || r.main_check_state === 'confirming')
      && !!r.main_check_sha && lower(r.main_check_resumed_sha) !== lower(r.main_check_sha));
  return {
    checkState: r.check_state ?? null,
    checksCommitSha: lower(r.checks_commit_sha),
    freshSuiteOwed: !!r.unit_suite_fresh_sha && !!r.checks_commit_sha
      && lower(r.unit_suite_fresh_sha) === lower(r.checks_commit_sha),
    shotsState: r.shots_state ?? null,
    shotsDetail: r.shots_detail && typeof r.shots_detail === 'object' ? r.shots_detail : null,
    locked: !!r.locked,
    adminYes: !!r.admin_yes,
    held: !!r.held,
    holdAdminYes: !!r.hold_admin_yes,
    contentFlagSha: contentAdminHold() ? lower(r.content_flag_sha) : null,
    mainPaused: paused,
  };
}

const SHOTS_ACCEPTED: ReadonlySet<string> = new Set(['verified', 'not_required', 'overridden']);

export interface ClaimInputs {
  head: string | null;          // the commit the claim is for (the row's, checked by the caller)
  force: boolean;               // an admin's force: votes, lock and main are skipped, shots are not
  forcedHead: string | null;    // the commit the force skips the checks on (forceWaivesChecks)
  shotsEnforced: boolean;       // config.shots.enforce
  mainPassThrough: boolean;     // the gate found this head level with main, clean and green on its own tree
  votesMergeable: boolean;      // rules/pr-gate.ts, read under the same lock
}

// An admin's force skips the checks only on the commit it was given on, or
// one a merge of main moved it to by pure git. It lasts through a conflict
// resolution (M4), but the commit the resolution wrote, Homeroom's own
// included, merges on its own green checks: on 2 Nov 2026 a force carried
// onto a model-resolved head merged it 19 seconds later, never checked, and
// main stopped loading its schema migrations.
export function forceWaivesChecks(force: boolean, forcedHead: string | null, head: string | null): boolean {
  return force && !!head && lower(forcedHead) === lower(head);
}

// Why the claim is refused now, or null. The order is the gate's, so the
// reason is the first thing still standing in its way.
export function claimRefusal(f: ClaimFacts, x: ClaimInputs): string | null {
  if (!x.force) {
    if (!x.votesMergeable) return 'not_mergeable';
    const flagged = !!f.contentFlagSha && !!x.head && f.contentFlagSha === x.head;
    if (((f.locked || flagged) && !f.adminYes) || (f.held && !f.holdAdminYes)) return 'awaiting_admin';
  }
  if (!forceWaivesChecks(x.force, x.forcedHead, x.head)) {
    const settled = (f.checkState === 'passing' || f.checkState === 'skipped')
      && (!x.head || f.checksCommitSha === x.head) && !f.freshSuiteOwed;
    if (!settled) return 'checks';
  }
  if (x.shotsEnforced && f.shotsDetail) {
    const required = f.shotsDetail.required !== false;
    const state = f.shotsState || (f.shotsDetail.state as string) || 'planned';
    const exact = !!x.head && lower(f.shotsDetail.headSha) === x.head;
    const ok = exact && (SHOTS_ACCEPTED.has(state) || (!required && state === 'not_required'));
    if (!ok) return 'shots';
  }
  if (!x.force && f.mainPaused && !x.mainPassThrough) return 'main_failing';
  return null;
}

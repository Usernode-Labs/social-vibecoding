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
  // The app's merges are paused by a red main (services/main-watch.js
  // describe: its own column, or red at a commit no admin resumed).
  mainPaused: boolean;
}

const lower = (v: unknown) => (v == null ? null : String(v).toLowerCase());

export async function readClaimFacts(db: Queryable, sessionId: number): Promise<ClaimFacts | null> {
  const { rows: [r] } = await db.query(
    `SELECT cs.check_state, cs.checks_commit_sha, cs.unit_suite_fresh_sha, cs.shots_state, cs.shots_detail,
            a.locked, a.main_check_state, a.main_check_sha, a.main_check_resumed_sha, a.main_check_paused_sha,
            EXISTS (SELECT 1 FROM pr_votes pv JOIN users u ON u.id = pv.user_id
                     WHERE pv.session_id = cs.id AND pv.vote = 'yes' AND ${currentVotePredicateSql('pv', 'cs')}
                       AND u.is_admin = TRUE AND u.admin_readonly = FALSE) AS admin_yes
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
    mainPaused: paused,
  };
}

const SHOTS_ACCEPTED: ReadonlySet<string> = new Set(['verified', 'not_required', 'overridden']);

export interface ClaimInputs {
  head: string | null;          // the commit the claim is for (the row's, checked by the caller)
  force: boolean;               // an admin's force: votes, checks, lock and main are skipped, shots are not
  shotsEnforced: boolean;       // config.shots.enforce
  mainPassThrough: boolean;     // the gate found this head level with main, clean and green on its own tree
  votesMergeable: boolean;      // rules/pr-gate.ts, read under the same lock
}

// Why the claim is refused now, or null. The order is the gate's, so the
// reason is the first thing still standing in its way.
export function claimRefusal(f: ClaimFacts, x: ClaimInputs): string | null {
  if (!x.force) {
    if (!x.votesMergeable) return 'not_mergeable';
    if (f.locked && !f.adminYes) return 'awaiting_admin';
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

// 13 Oct 2026, D1: one definition of "this change is its project's first
// version", which goes live without a vote once it has passed its review
// and its checks (the gate's rule is governance-gate.ts applyFirstVersion).
// services/first-version-rule.js re-exports it for every query that shows or
// decides the gate; the proposal machine reads it under its lock.
//
// A first version is the change Homeroom bot built for a project's first
// request, the one filed from the description the project was made with
// (homeroom_bot_first_versions), as long as no change for that request has
// gone live yet. The run that built it names it: build_session_id from the
// moment it is promoted (the build sets it when it starts, and the promote
// comes before the run records its proposal), proposal_session_id once its
// proposal is recorded. Both are the same session.

import { checkedAlias } from './vote-predicate.ts';

/**
 * The boolean SQL predicate "session alias `cs` is its project's first
 * version": built by Homeroom bot for the request its project's description
 * was filed as, and no change for that request has gone live (that one
 * itself aside, so a first version that went live still reads as one).
 */
export function firstVersionSql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  // From the project's one first-version row (its primary key) to that
  // request's runs (idx_homeroom_bot_runs_issue): a handful of rows, and
  // none at all on a project made without a description.
  return `EXISTS (
    SELECT 1 FROM homeroom_bot_first_versions fvf
      JOIN homeroom_bot_runs fvr
        ON fvr.app_id = fvf.app_id AND fvr.issue_number = fvf.issue_number
     WHERE fvf.app_id = ${cs}.app_id
       AND (fvr.proposal_session_id = ${cs}.id OR fvr.build_session_id = ${cs}.id)
       AND NOT EXISTS (
         SELECT 1 FROM homeroom_bot_runs fvo
           JOIN chat_sessions fvs ON fvs.id = fvo.proposal_session_id
          WHERE fvo.app_id = fvf.app_id AND fvo.issue_number = fvf.issue_number
            AND fvs.status = 'merged' AND fvs.id <> ${cs}.id))`;
}

// What the bot-change machine reads inside a transition: the change's row
// as chat_sessions stores it (its checks, its shots, its epoch), the bot's
// run that proposed it (by its build session too: the promote comes before
// the run records its proposal, homeroom-bot.js announceBuilt) and who
// asked for it, whether a fix round already
// looked at its head, and whether its stored work state says it is ready to
// try (work_states, which services/work-state.js derives and owns: the one
// decider of what holds a vote). Read, not
// locked: the machines that write the row lock it, every decision here is
// made from what they committed (their message commits with their write),
// and what it sends is keyed per epoch or head.

import type { Tx } from '../kernel/index.ts';
import { BOT_USERNAME } from '../rules/bot-notes.ts';
import { readyToTry } from '../rules/bot-readiness.ts';

export interface Row {
  id: number;
  app_id: number;
  status: string;
  [column: string]: any;
}

export interface Facts {
  row: Row | null;
  // The bot owns it and one of its runs proposed it.
  runId: number | null;
  issueNumber: number | null;
  requesterId: number | null;
  // #6407: the session of the plan a person posted that this change was
  // built from, or null when it was not built from a person's plan.
  builtFromSessionId: number | null;
  // A fix round of the bot's recorded the reviewed head (it looked at it).
  looked: boolean;
  // A fix round revised the proposal once already (a skip is never a second round).
  fixRevised: boolean;
  // Its stored work state says it is ready to try (rules/bot-readiness.ts
  // readyToTry): open for votes, or a first version going live.
  ready: boolean;
  // Its stored work state says its before & after shots still hold its vote.
  shots: boolean;
}

export const NO_FACTS: Facts = {
  row: null, runId: null, issueNumber: null, requesterId: null, builtFromSessionId: null, looked: false, fixRevised: false,
  ready: false, shots: false,
};

export async function readFacts(tx: Tx, sessionId: number): Promise<Facts> {
  const { rows: [r] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.source, cs.check_state, cs.approval_epoch, cs.merged_at,
            cs.reviewed_head_sha, cs.imported_pr_head_sha, cs.checks_commit_sha, cs.handoff_head_sha,
            cs.checks_checked_at, cs.shots_state, cs.shots_run_id, cs.shots_detail, cs.shots_updated_at, cs.pr_diagram,
            cs.built_from_session_id, cs.built_from_version,
            cs.test_results, cs.linked_issues,
            run.id AS run_id, run.issue_number, req.user_id AS requester_id,
            ws.stage AS work_stage, ws.line AS work_line, ws.vote_open AS work_vote_open,
            EXISTS (SELECT 1 FROM homeroom_bot_runs x
                     WHERE x.proposal_session_id = cs.id AND x.checks_head_sha = LOWER(cs.reviewed_head_sha)) AS looked,
            EXISTS (SELECT 1 FROM homeroom_bot_runs x
                     WHERE x.proposal_session_id = cs.id AND x.verdict = 'revise' AND x.checks_head_sha IS NOT NULL) AS fix_revised
       FROM chat_sessions cs
       JOIN users u ON u.id = cs.user_id AND u.username = $2 AND u.is_synthetic = TRUE
       LEFT JOIN LATERAL (
         SELECT r.id, r.issue_number, r.app_id FROM homeroom_bot_runs r
          WHERE r.proposal_session_id = cs.id OR r.build_session_id = cs.id ORDER BY r.id DESC LIMIT 1) run ON TRUE
       LEFT JOIN homeroom_bot_requesters req ON req.app_id = run.app_id AND req.issue_number = run.issue_number
       LEFT JOIN work_states ws ON ws.item_kind = 'change' AND ws.item_ref = cs.id AND ws.app_id = cs.app_id
       WHERE cs.id = $1`, [sessionId, BOT_USERNAME]);
  return factsOf(r);
}

/**
 * Pure: the facts of one row of readFacts' query (the session's columns, its
 * run and requester, and its stored work state as `work_stage`, `work_line`
 * and `work_vote_open`), or NO_FACTS for none.
 */
export function factsOf(r: Row | null | undefined): Facts {
  if (!r) return NO_FACTS;
  return {
    row: r,
    runId: r.run_id ?? null,
    issueNumber: r.issue_number ?? null,
    requesterId: r.requester_id ?? null,
    builtFromSessionId: r.built_from_session_id == null ? null : Number(r.built_from_session_id),
    looked: !!r.looked,
    fixRevised: !!r.fix_revised,
    ready: readyToTry({ stage: r.work_stage, line: r.work_line, vote_open: r.work_vote_open === true }),
    shots: r.work_stage === 'checking' && r.work_line?.code === 'shots',
  };
}

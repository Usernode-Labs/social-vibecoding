// What the bot-change machine reads inside a transition: the change's row
// as chat_sessions stores it (its checks, its shots, its epoch), the bot's
// run that proposed it (by its build session too: the promote comes before
// the run records its proposal, homeroom-bot.js announceBuilt) and who
// asked for it, and whether a fix round already
// looked at its head. Read, not
// locked: the machines that write the row lock it, every decision here is
// made from what they committed (their message commits with their write),
// and what it sends is keyed per epoch or head.

import type { Tx } from '../kernel/index.ts';
import { BOT_USERNAME } from '../rules/bot-notes.ts';

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
  // A fix round of the bot's recorded the reviewed head (it looked at it).
  looked: boolean;
  // A fix round revised the proposal once already (a skip is never a second round).
  fixRevised: boolean;
}

export const NO_FACTS: Facts = {
  row: null, runId: null, issueNumber: null, requesterId: null, looked: false, fixRevised: false,
};

export async function readFacts(tx: Tx, sessionId: number): Promise<Facts> {
  const { rows: [r] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.source, cs.check_state, cs.approval_epoch, cs.merged_at,
            cs.reviewed_head_sha, cs.imported_pr_head_sha, cs.checks_commit_sha, cs.handoff_head_sha,
            cs.checks_checked_at, cs.shots_state, cs.shots_run_id, cs.shots_detail, cs.shots_updated_at,
            cs.test_results, cs.linked_issues,
            run.id AS run_id, run.issue_number, req.user_id AS requester_id,
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
       WHERE cs.id = $1`, [sessionId, BOT_USERNAME]);
  if (!r) return NO_FACTS;
  return {
    row: r,
    runId: r.run_id ?? null,
    issueNumber: r.issue_number ?? null,
    requesterId: r.requester_id ?? null,
    looked: !!r.looked,
    fixRevised: !!r.fix_revised,
  };
}

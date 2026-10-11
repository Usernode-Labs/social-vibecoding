// A merged pull request's bounties: the merge-followups machine pays them in
// its transaction; routes/votes.js re-exports this for [main]'s merge.

import type { Queryable } from './db.ts';

// Resolve open issue bounties for a single closed issue when a PR merges.
//
// A bounty pledged via the Open Issues panel ("Give kudos") flips 'open' →
// 'awarded' and credits the merged PR's author — EXCEPT a bounty whose
// pledger IS that author, which would be self-kudos (the same thing the
// direct PR-kudos give path refuses with a 403; see routes/kudos.js). The
// awardee isn't known until merge, so the self-check lives here: self-pledged
// rows are 'voided' instead — not left 'open', because the issue is now
// closed on GitHub and no later PR will close it again, so an open row would
// linger forever and keep inflating the issue's open-bounty count. Voided
// rows keep awarded_session_id/awarded_at for audit but no awarded_user_id,
// so they earn no leaderboard credit. The pledger's weekly allowance slot is
// still forfeited (no refund) — every pledged bounty consumes a slot.
//
// `IS DISTINCT FROM` keeps a NULL giver (deleted pledger) and a NULL awardee
// (deleted PR author) on the award path. Self-voiding only runs when the PR
// has an author. Returns { awarded, voided } id arrays. Extracted from
// checkAndMerge so the self-bounty guard is unit-testable without driving the
// whole merge pipeline.
export async function resolveIssueBounty(
  pool: Queryable,
  { appId, sessionId, awardeeUserId, issueNumber }: { appId: number; sessionId: number; awardeeUserId: number | null; issueNumber: number },
): Promise<{ awarded: { id: number }[]; voided: { id: number }[] }> {
  const { rows: awarded } = await pool.query(
    `UPDATE issue_bounties
        SET status = 'awarded',
            awarded_session_id = $1,
            awarded_user_id = $2,
            awarded_at = NOW()
      WHERE app_id = $3 AND github_issue_number = $4 AND status = 'open'
        AND giver_user_id IS DISTINCT FROM $2
      RETURNING id`,
    [sessionId, awardeeUserId || null, appId, issueNumber]
  );

  let voided: { id: number }[] = [];
  if (awardeeUserId) {
    const { rows } = await pool.query(
      `UPDATE issue_bounties
          SET status = 'voided',
              awarded_session_id = $1,
              awarded_at = NOW()
        WHERE app_id = $2 AND github_issue_number = $3 AND status = 'open'
          AND giver_user_id = $4
        RETURNING id`,
      [sessionId, appId, issueNumber, awardeeUserId]
    );
    voided = rows;
  }

  return { awarded, voided };
}


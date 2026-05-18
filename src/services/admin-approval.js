// Shared helpers for the per-app "locked" change-gate (admin must also
// approve before any group-voted change applies). The lock itself is a
// single `apps.locked` boolean toggled by admins via POST /api/apps/:slug/lock
// (see routes/apps.js); these helpers are consumed by the three vote-apply
// paths — checkAndMerge in routes/votes.js, maybeApplyRenameProposal and
// maybeApplySecretChangeProposal in routes/issues.js — so the rule reads
// the same way in all three places.
//
// Semantics:
//   - `isAppLocked(pool, appId)` — straight column read.
//   - `hasAdminYesVote(pool, sessionId)` — at least one user with
//     is_admin = TRUE has 'yes' in pr_votes for this PR.
//   - `hasAdminUpVote(pool, issueId)` — same shape for issue_votes
//     ('up' instead of 'yes').
//
// Both lookups are cheap (`LIMIT 1` on indexed columns) and only run on
// the vote-apply path, which is already async + bounded — no perf concern.

async function isAppLocked(pool, appId) {
  const { rows } = await pool.query(
    'SELECT locked FROM apps WHERE id = $1',
    [appId]
  );
  return !!rows[0]?.locked;
}

async function hasAdminYesVote(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM pr_votes pv
       JOIN users u ON u.id = pv.user_id
      WHERE pv.session_id = $1
        AND pv.vote = 'yes'
        AND u.is_admin = TRUE
      LIMIT 1`,
    [sessionId]
  );
  return rows.length > 0;
}

async function hasAdminUpVote(pool, issueId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM issue_votes iv
       JOIN users u ON u.id = iv.user_id
      WHERE iv.issue_id = $1
        AND iv.vote = 'up'
        AND u.is_admin = TRUE
      LIMIT 1`,
    [issueId]
  );
  return rows.length > 0;
}

module.exports = { isAppLocked, hasAdminYesVote, hasAdminUpVote };

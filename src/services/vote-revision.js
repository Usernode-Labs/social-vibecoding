'use strict';

/**
 * What happens to a proposal's votes when its author pushes a new version
 * from a native session (#1688).
 *
 * ── The rows survive ───────────────────────────────────────────────────
 *
 * Until #1688 the turn tail DELETEd every pr_votes row under the session and
 * announced the reset. The integrity half of that is right — the votes were
 * cast on code that no longer exists — but the delete threw away the record
 * of who had been on board, which is exactly the thing the proposal's page
 * and the re-confirm ask need. Imported proposals never deleted: #2038 pinned
 * approvals to an EPOCH, a counter on the session that an authored push
 * bumps, and a vote counts while its stamp equals the session's. The native
 * path does the same now, through the same statement shape
 * routes/votes.js reconcileNativeReviewedHead uses when it discovers a moved
 * head at vote time: the head is installed and the epoch bumped in ONE
 * update, guarded by the head being new, so a tail that runs twice (a
 * resumed turn, or a vote-time reconcile that already saw the commit) bumps
 * once.
 *
 * ── Who is asked back ──────────────────────────────────────────────────
 *
 * Everyone whose Yes counted a moment ago gets a `revision_recheck`
 * notification: their yes was on the old version, and one tap on it carries
 * their vote — and the line they left with it — onto the new one
 * (routes/votes.js VOTE_REASON_UPSERT_SQL). No voters are not pinged: they
 * are named on the proposal's page as "earlier version" and can look again
 * when they like, but a push is not a summons to re-argue a No.
 */

const log = require('./logger');

/**
 * Retire the votes counted against `session` and pin it to `commitHash`.
 *
 * Returns `{ bumped, epoch, retired, priorYes }`: whether the head was new
 * (and so the epoch moved), the epoch the session is at afterwards, how many
 * counted votes stopped counting, and the ids of the people whose counted
 * Yes just did — the author excluded, since they wrote the update.
 */
async function retireVotesAfterAuthoredPush(pool, session, commitHash) {
  const sessionId = session.id;
  const head = typeof commitHash === 'string' ? commitHash.trim().toLowerCase() : null;
  const { rows: counted } = await pool.query(
    `SELECT pv.user_id, pv.vote
       FROM pr_votes pv
       JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE pv.session_id = $1
        AND pv.approval_epoch = cs.approval_epoch`,
    [sessionId]
  );
  const { rows: bumped } = await pool.query(
    `UPDATE chat_sessions
        SET reviewed_head_sha = COALESCE($2, reviewed_head_sha),
            stale_notified_at = NULL,
            approval_epoch = approval_epoch + 1
      WHERE id = $1
        AND ($2::varchar IS NULL OR reviewed_head_sha IS DISTINCT FROM $2::varchar)
      RETURNING approval_epoch`,
    [sessionId, head]
  );
  if (!bumped.length) {
    // The head is already this commit: a vote-time reconcile got here first
    // and moved the epoch itself, or the tail is being resumed. Nothing to
    // retire twice, nobody to ask twice.
    return { bumped: false, epoch: null, retired: 0, priorYes: [] };
  }
  const epoch = parseInt(bumped[0].approval_epoch, 10);
  const priorYes = counted
    .filter((r) => r.vote === 'yes' && r.user_id != null && r.user_id !== session.user_id)
    .map((r) => r.user_id);
  return { bumped: true, epoch, retired: counted.length, priorYes };
}

/**
 * The whole step the two turn tails share (routes/sessions.js live,
 * server.js recovery): retire the votes, and when any counted vote stopped
 * counting, tell the room and ask the prior Yes voters back. `announce`
 * posts the chat line; it is the tail's own sendSystemMessage pair, passed
 * in so this module never reaches for ws itself.
 */
async function retireAndRecheck(pool, session, commitHash, { announce } = {}) {
  const result = await retireVotesAfterAuthoredPush(pool, session, commitHash);
  if (!result.bumped || result.retired === 0) return result;
  if (typeof announce === 'function') {
    await announce(result).catch?.(() => {});
  }
  try {
    const notifications = require('./notifications');
    const created = await notifications.createRevisionRecheckNotifications(pool, {
      appId: session.app_id,
      sessionId: session.id,
      authorId: session.user_id || null,
      voterIds: result.priorYes,
      epoch: result.epoch,
    });
    await Promise.all(created.map((row) => notifications.hydrateAndPush(pool, row)));
  } catch (err) {
    log.warn('vote-revision', 'Re-confirm notifications failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
  return result;
}

module.exports = { retireVotesAfterAuthoredPush, retireAndRecheck };

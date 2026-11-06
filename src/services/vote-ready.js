'use strict';

// 6 Nov 2026 (#6402): one definition of "this change is ready to be voted
// on" for every list, count and notification that asks for a vote.
//
// A change is ready only once its checks passed (or it had nothing to test)
// AND it merges cleanly with main. Until then it waits under Waiting & in
// progress, worded by services/work-state.js, and voting early stays
// possible on the change's own page. Before this, Needs you asked for a vote
// while the tests were still running, and a fix push often cleared the yes.
//
// The readers, all of them through this module's two SQL fragments:
//   services/workshop-overview.js  OWED_PROPOSALS_WHERE, and so COUNTS_SQL,
//                                  ITEMS_SQL, NEEDS_FEED_SQL,
//                                  NEEDS_FEED_IN_THREADS_SQL (the Homeroom
//                                  bot tab), OWED_BY_COMMUNITY_SQL and
//                                  services/places.js;
//   services/vote-digest.js        the daily "what needs your vote" digest;
//   workflow/rules/proposal-notifications.ts
//                                  the "new proposal to vote on" ping, now
//                                  sent when the checks pass rather than at
//                                  promotion.
//
// The predicate itself is one copy, in src/workflow/rules/vote-ready.ts, so
// the proposal machine and the preview machine read the same words.

const { syncWaitSql, voteReadySql } = require('../workflow/rules/vote-ready.ts');

/**
 * Pure: whether one facts row is still waiting to sync with main. The same
 * test as syncWaitSql, on a row's columns (`check_phase`,
 * `merge_conflict_state`, `integration_merges_clean`).
 */
function syncWaits(row) {
  if (!row) return false;
  if (row.check_phase === 'deferred') return true;
  if (row.merge_conflict_state === 'conflict' || row.merge_conflict_state === 'failed') return true;
  return row.integration_merges_clean === false;
}

module.exports = { syncWaitSql, voteReadySql, syncWaits };

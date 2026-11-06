// 6 Nov 2026 (#6402): one definition of "this change is ready to be voted
// on", for every list, count and notification that asks someone for a vote.
//
// Before this, Needs you listed any promoted change that was not yours and
// that you had not voted on, whatever its checks were doing: a yes cast
// while its tests ran (or while it waited to sync with main) was often
// thrown away when a fix push cleared the votes. A change is ready only once
// its checks passed (or it had nothing to test) AND it merges cleanly with
// main. Until then it waits under Waiting & in progress, worded by
// services/work-state.js, and voting early stays possible on the change's
// own page (routes/votes.js is untouched).
//
// The predicate itself is one copy here, so the SQL readers cannot drift:
// services/vote-ready.js re-exports it with the pure `syncWaits(row)` test
// for facts rows, and services/workshop-overview.js (OWED_PROPOSALS_WHERE,
// and so every count, the feed and OWED_BY_COMMUNITY_SQL),
// services/vote-digest.js and the proposal machine's proposed/ready
// notification read it.

import { checkedAlias } from './vote-predicate.ts';

/**
 * The boolean SQL predicate "session alias `cs` waits to sync with main":
 * the checks are deferred until it merges cleanly, or a conflict with main
 * was recorded, or a measured merge did not come out clean. `NULL`
 * (`unknown`) is not a wait: a change nobody measured keeps today's
 * behaviour.
 */
export function syncWaitSql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  return `(${cs}.check_phase = 'deferred'
     OR ${cs}.merge_conflict_state IN ('conflict', 'failed')
     OR ${cs}.integration_merges_clean = FALSE)`;
}

/**
 * The boolean SQL predicate "session alias `cs` is ready for a vote": its
 * checks passed or were skipped, and it does not wait to sync with main.
 */
export function voteReadySql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  return `(${cs}.check_state IN ('passing', 'skipped') AND NOT COALESCE(${syncWaitSql(cs)}, FALSE))`;
}

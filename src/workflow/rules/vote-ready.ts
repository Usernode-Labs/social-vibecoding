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
// #6531 (9 Nov 2026): the one conflict that IS ready is the one only a yes can
// move: the conflict lane has spent its free pre-vote resolution and waits for
// an approval (awaitingYesSql). It is asked for, counted and pinged like any
// ready change, and worded "Conflicts with main: Homeroom resolves it once you
// approve". Everything else that conflicts is Homeroom's to catch up and stays
// under Waiting & in progress.
//
// 19 Nov 2026 (docs/plans/bot-one-model.md): whether a change is ready to
// be voted on is its stored work state's (work_states.vote_open,
// services/work-state.js, which derives it with the pure syncWaits and
// syncStand of services/vote-ready.js beside the rest of what holds a vote).
// Every list, count and notification that asks for a vote reads that row:
// routes/workshop-overview.js OWED_PROPOSALS_WHERE (and so every count, the
// feed and OWED_BY_COMMUNITY_SQL), services/vote-digest.js, and the "new
// proposal to vote on" ping (rules/proposal-notifications.ts). The SQL
// predicate the ping read before (voteReadySql, with syncWaitSql) had no
// other reader, and is gone. What stays here is the one SQL test a list
// still reads off the change itself: awaitingYesSql, which the Workshop uses
// to word a conflict only a yes can move.

import { checkedAlias } from './vote-predicate.ts';

/**
 * #6531 (9 Nov 2026): the boolean SQL predicate "session alias `cs` conflicts
 * with main and only a yes can move it": the conflict lane has already spent
 * its one free pre-vote resolution and is waiting for the group's approval.
 * Such a change IS ready for a vote even though it does not merge cleanly.
 */
export function awaitingYesSql(sessionAlias = 'cs'): string {
  const cs = checkedAlias(sessionAlias);
  return `(${cs}.integration_merges_clean = FALSE
     AND COALESCE(${cs}.integration_block_reasons, '[]'::jsonb) ? 'awaiting_approval')`;
}

// Which votes are current: services/pr-vote-revision.js's rule (#2038,
// where the reasons are), here so the merged line's credits count exactly
// the votes every tally counts. pr-vote-revision.js re-exports it.

export function checkedAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias || '')) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  return alias;
}

/**
 * The predicate every tally in the platform is built on.
 *
 * A NULL vote epoch never equals a NOT NULL session epoch, which is what makes
 * the migration a no-op in both directions: votes that were stale under the
 * old commit rule were backfilled to NULL and stay uncounted, and votes that
 * were counting were backfilled to 0 and keep counting.
 */
export function currentVotePredicateSql(voteAlias = 'pv', sessionAlias = 'cs'): string {
  const pv = checkedAlias(voteAlias);
  const cs = checkedAlias(sessionAlias);
  return `(${pv}.approval_epoch = ${cs}.approval_epoch)`;
}

// The predicate every TALLY counts with: a current vote (above) that also
// counts toward the app's outcome. A test account's vote on an app a real
// person made is current (it is the voter's own, shown on their card as
// theirs and labelled) but it is not counted (D1, services/test-accounts.js;
// the rule itself is counts_toward_outcome in schema.sql, which the active-
// member denominator shares). So "what did I vote" reads
// currentVotePredicateSql and "how many approvals" reads this one. `cs` must
// expose `app_id`.
export function countedVotePredicateSql(voteAlias = 'pv', sessionAlias = 'cs'): string {
  const pv = checkedAlias(voteAlias);
  const cs = checkedAlias(sessionAlias);
  return `(${currentVotePredicateSql(pv, cs)} AND counts_toward_outcome(${pv}.user_id, ${cs}.app_id))`;
}

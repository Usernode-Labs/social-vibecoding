'use strict';

// One definition of "which approvals still describe the code under review".
//
// #2038 changed what that means. It used to be a COMMIT: every vote carried
// the head sha it was cast against, and a vote counted while that sha equalled
// the proposal's pin. The trouble is that the platform's own "sync with main"
// changes the commit without changing the code under review, so the pin had to
// be advanced and the votes carried across — and proving that a given commit
// really was the platform's own sync needed a provenance ledger, a five-hop
// first-parent walk and a fail-closed branch for when GitHub would not say who
// a commit's parents were. All of it existed because a commit's SHAPE can be
// forged: anyone can craft a merge whose first parent is the reviewed sha.
//
// It is an EPOCH now. chat_sessions.approval_epoch is a counter the platform
// bumps on exactly one event — somebody wrote bytes that were not already
// approved — and every vote records the epoch it was cast under. A vote counts
// while the two are equal.
//
// Nothing about a mechanical merge touches the epoch, so a sync needs no
// carry, no advance and no reconciliation: the approvals simply keep counting,
// because they are still approvals of the same work. services/integration.js
// owns the decision of when a head move is mechanical (it recomputes the merge
// and compares trees, which cannot be forged because it asks the branch
// nothing) and calls clearApprovals when it is not.
//
// The exported names are unchanged so the eighteen call sites across eight
// files keep reading one definition rather than each growing their own.

// The reviewed revision is still recorded and still useful — it is what the
// exact-sha merge pins to, and what the classifier compares against — it is
// simply no longer what decides whether a vote counts.
function reviewedHeadForSession(session) {
  return session?.source === 'imported'
    ? (session.imported_pr_head_sha || null)
    : (session?.reviewed_head_sha || null);
}

function checkedAlias(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias || '')) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  return alias;
}

function reviewedHeadSql(sessionAlias = 'cs') {
  const cs = checkedAlias(sessionAlias);
  return `(CASE WHEN ${cs}.source = 'imported' `
    + `THEN ${cs}.imported_pr_head_sha ELSE ${cs}.reviewed_head_sha END)`;
}

/**
 * The predicate every tally in the platform is built on.
 *
 * A NULL vote epoch never equals a NOT NULL session epoch, which is what makes
 * the migration a no-op in both directions: votes that were stale under the
 * old commit rule were backfilled to NULL and stay uncounted, and votes that
 * were counting were backfilled to 0 and keep counting.
 */
function currentVotePredicateSql(voteAlias = 'pv', sessionAlias = 'cs') {
  const pv = checkedAlias(voteAlias);
  const cs = checkedAlias(sessionAlias);
  return `(${pv}.approval_epoch = ${cs}.approval_epoch)`;
}

// The one place that decides "is this stamp the reviewed revision?" for JS
// callers. Still case-insensitive: every writer lands a lower-case sha, but a
// single upper-case character would make an IDENTICAL commit read as a
// different one, and the comparison is the cheap place to be exact (#955).
function sameSha(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.toLowerCase() === b.toLowerCase();
}

module.exports = {
  reviewedHeadForSession,
  reviewedHeadSql,
  currentVotePredicateSql,
  sameSha,
};

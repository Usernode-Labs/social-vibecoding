'use strict';

// One definition of the immutable revision a PR proposal is currently
// reviewing. Imported proposals retain their established import-head field;
// every other GitHub-backed proposal uses the native reviewed-head field.
function reviewedHeadForSession(session) {
  return session?.source === 'imported'
    ? (session.imported_pr_head_sha || null)
    : (session?.reviewed_head_sha || null);
}

// SQL helpers for proposal serializers and background selectors. When a
// legacy/local row has no immutable head yet, preserve the historical
// unscoped tally. Once a head exists, stale-revision votes are invisible even
// if cleanup raced or was interrupted.
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

// #955: compare head stamps case-insensitively. Every writer today lands a
// lower-case SHA (GitHub reads, `git rev-parse`, the handoff normalizer), but
// a single upper-case character anywhere would make an IDENTICAL commit read
// as a different revision — silently hiding a vote that must still count. The
// comparison is the cheap place to be exact about it.
function currentVotePredicateSql(voteAlias = 'pv', sessionAlias = 'cs') {
  const pv = checkedAlias(voteAlias);
  const head = reviewedHeadSql(sessionAlias);
  return `(${head} IS NULL OR LOWER(${pv}.head_sha) = LOWER(${head}))`;
}

// The one place that decides "is this stamp the reviewed revision?" for JS
// callers, matching currentVotePredicateSql's case-insensitive semantics.
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

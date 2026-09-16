'use strict';

// One definition of "which `issues` rows are governance proposals".
//
// The `issues` table holds two populations that have nothing to do with one
// another, and the only column separating them is `kind`:
//
//   GOVERNANCE — the five kinds below. A decision the group votes on: a
//     secret change, a rename, a propose-to-close, a maintenance campaign, a
//     featured illustration. These are the rows the board draws its `gov`
//     cards from, and the only rows in the table that anybody is waiting to
//     vote on.
//
//   `general` — a TWIN row, written beside the GitHub issue whenever a
//     feature request is filed through the platform (the create path in
//     routes/issues.js). It exists to hold the creator's identity, because
//     GitHub files every platform-authored issue as the bot; the close path
//     calls them "internal open twin rows" in as many words. Nothing votes on
//     a twin, and every surface that shows requests renders the GitHub issue
//     rather than the twin.
//
// Telling the two apart is not optional, and the Workshop overview is what
// happens when a query forgets: counting every open row in the table as a
// vote the viewer owed, it reported forty-six votes waiting on an app whose
// board had three open requests. The twins' `status` is what made it that
// large — the only path that closes one is a passed close-issue vote, so an
// issue closed by a merged PR's `Closes #N`, or closed on GitHub, leaves its
// twin open for good. Those rows are harmless until something counts them.
//
// The list is written out by hand at four other sites: two lookups in
// services/shared-objects.js, the single-proposal fetch in routes/issues.js,
// and the client's `_govProposals` filter in public/js/app-view.js. Those
// four are deliberately NOT rewritten to interpolate this module. Three of
// them are static query text today, which scripts/check-sql.js validates
// against a real schema; interpolating anything would move them into the
// reviewed dynamic-SQL baseline instead, which is a weaker guarantee than the
// duplication costs. The fourth is browser script with no module loader.
// tests/workshop-screen.test.js pins all four to this list instead, so a kind
// added here and nowhere else fails a test rather than going quietly missing
// from a query.
//
// A NEW server-side reader should import from here; `governanceKindsSql` is
// for callers whose query is already runtime-built, as the Workshop
// overview's is.

const GOVERNANCE_KINDS = Object.freeze([
  'secret_change',
  'rename',
  'close_issue',
  'maintenance_campaign',
  'featured_illustration',
]);

// Same guard as services/pr-vote-revision.js: these fragments are pasted into
// query text, so the one caller-supplied part of them is checked rather than
// trusted. The kinds themselves are this module's own literals.
function checkedAlias(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias || '')) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  return alias;
}

/**
 * `<alias>.kind IN (…)` — the predicate that keeps a query reading the
 * `issues` table on the governance half of it.
 *
 * A query over `issues` that means "proposals" needs this in its WHERE clause
 * as surely as it needs `status = 'open'`; leaving it out does not narrow the
 * result to something smaller and safer, it widens it to the whole request
 * board.
 */
function governanceKindsSql(issueAlias = 'i') {
  const i = checkedAlias(issueAlias);
  return `${i}.kind IN (${GOVERNANCE_KINDS.map((k) => `'${k}'`).join(', ')})`;
}

/** The same question for a row already in hand. */
function isGovernanceKind(kind) {
  return GOVERNANCE_KINDS.includes(kind);
}

module.exports = {
  GOVERNANCE_KINDS,
  governanceKindsSql,
  isGovernanceKind,
};

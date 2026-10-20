// The line a vote carries (#1688): how long it may be. The vote routes and
// the governance machine's replies read it (routes/votes.js, platform.ts).
// A line is optional on either side of a vote.

// The longest line a vote may carry. One sentence, not a review: the roster,
// the thread line and the proposer's notification all quote it whole, and a
// paragraph in any of those is worse than none.
export const VOTE_REASON_MAX = 280;

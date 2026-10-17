// The line a vote carries (#1688): how long it may be, and what a No without
// one is answered. The vote routes and the governance machine's replies read
// it (routes/votes.js, platform.ts).

// The longest line a vote may carry. One sentence, not a review: the roster,
// the thread line and the proposer's notification all quote it whole, and a
// paragraph in any of those is worse than none.
export const VOTE_REASON_MAX = 280;
export const VOTE_REASON_REQUIRED = 'A No comes with a line: what is not working for you?';

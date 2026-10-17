// Kudos is parked (#5249): the server's switch, the twin of the client's
// frontend/src/features/leaderboard/kudos-parked.ts. It lives here, beside
// the rules the workflow machines read, so the merge-followups machine can
// ask it without crossing into unmigrated code; src/services/kudos-parked.js
// re-exports it with the helpers the routes and readers use.
export const KUDOS_PARKED = true;

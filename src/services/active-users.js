// Shared definition of "active user" used by both the vote-majority
// machinery (PR + issue thresholds) and the group-chat dashboard tile,
// so the number that gates voting matches the number users see.
//
// TWO SEPARATE CONCEPTS (deliberately decoupled — see below):
//
//   1. ACTIVITY ("active user" / "has tested the app") — a pure
//      engagement signal, `hasQualifyingActivity()`:
//
//        - **Qualifying event** (sticky): the user has accumulated >= 60
//          seconds on a single calendar day on this app at some point in
//          their history with it (`app_activity.seconds_spent >= 60`).
//          Once they've ever crossed this bar, they're a qualified user
//          for the rest of their relationship with the app.
//
//        - **Retention**: a qualified user is currently counted as active
//          if they have at least one row in `app_activity` for this app
//          dated within the last 10 calendar days. Any visit counts —
//          opening the App tab is enough; you don't need another 60s
//          session each time. If 10 calendar days pass with no visits the
//          user falls out of the active count and would have to come back
//          to be re-counted.
//
//      This concept carries NO collaborator gate: someone who spent
//      >=60s/day on a view-public app has "tested" it whether or not
//      they're a member. It's the right signal for "apps the user is
//      active on" surfaces (leaderboard `active_apps`) and for a
//      test-before-you-vote gate.
//
//   2. COLLAB-ELIGIBILITY — a governance gate, `isCollabEligible()`:
//      for apps with collab_visibility='private' (non-self-hosted),
//      only collaborators (status='member' in app_collaborators) count.
//      Enforced independently at the vote WRITE layer via
//      appAccess.getAppForUser(..., 'collab', ...).
//
//   3. MEMBERSHIP (communities) — only members of the community the app
//      belongs to may propose and vote (services/communities.js), so only
//      members are counted: `community_members` for the app's
//      `community_id`. An app with no community does not gate (a row between
//      its insert and the schema backfill). On the platform's own project
//      the membership is every account with platform access unless they
//      left, so its union-of-all-apps activity below is narrowed only by
//      people who chose to leave.
//
//   4. A RECENT INVITE — `acceptedInviteRecently()`: on an app that is not
//      self-hosted, a person who accepted an invite to build it in the last
//      10 days (`app_collaborators.status = 'member'` and `accepted_at` in
//      the window) counts as a voter even before they have used the app.
//      Accepting is the moment they said they are in, and a two-person
//      project whose invitee had not yet spent a minute in the app used to
//      count one voter, so its creator's own Yes merged at once. Every way
//      in stamps `accepted_at`: an @username or email invite through
//      collab-invites.acceptInvite, and a link through
//      apply_community_invite() in schema.sql. Concept #1 is untouched: an
//      invite is not "has tested the app".
//
// The vote-facing helpers (`getActiveUserStats`, `listActiveUserIds`,
// `isUserActive`) return the INTERSECTION ((activity ∪ recent invite) ∩
// eligibility ∩ membership): the majority denominator must only count users
// who can actually vote, or a threshold becomes unreachable (non-voting
// viewers — and, since communities, people who never joined — inflating
// floor(active/2)+1). Display/"tested" surfaces use concept #1 alone.
//
// A Private community (communities.audienceSql 'invited') is also floored
// at two once two people who can vote are in it, so a pair stays a pair
// after the invite's 10 days run out. See INVITED_FLOOR_SQL (src/workflow/rules/electorate.ts).
//
// Pragmatic-vs-strict note: a fully strict "lifecycle" reading of the
// rule would say a 10-day absence un-qualifies the user, requiring
// another 60s session on return. This implementation cheats slightly
// — it only checks "ever qualified" + "visited in the last 10 days".
// The corner case (a user who qualified once, vanished for months,
// then briefly visits) gets counted as active even though strictly
// they should re-qualify. Worth revisiting if/when this matters.
//
// Self-hosted (platform self-app) special case: app_activity rows are
// only ever inserted while a user is on a child app's App tab (see
// startActivityTracking in app-view.js). The self-app has no App tab
// — the platform doesn't iframe itself — so its app_id never gets a
// row, which would leave its active count at 0 forever and make the
// vote-majority math unreachable. For self_hosted apps we instead
// count the *union* across every app: anyone who's qualified on any
// app and visited any app within the window. This matches the user's
// mental model — "everyone using the platform is a user of the
// platform" — and unblocks self-app voting/governance. Neither the
// recent-invite rule (#4) nor the Private community floor applies to a
// self-hosted app: its membership is every account with platform access,
// not a list of people somebody invited.

// ---------------------------------------------------------------------------
// Dynamic merge gates: requiredVotes, mergeWindowMs, lazyWindowMs,
// rejectionWindowMs, oppositionWindowMs, isContested and mergeGate are the
// workflow's rule (src/workflow/rules/governance-gate.ts), re-exported here
// for the merge route, the governance paths, the stale-PR sweeper and the
// client. One copy: the workflow's governance machine decides with the same
// functions inside its transaction.
// ---------------------------------------------------------------------------

const gateRules = require('../workflow/rules/governance-gate.ts');
const electorateRules = require('../workflow/rules/electorate.ts');

const {
  requiredVotes, isContested, mergeWindowMs, rejectionWindowMs, oppositionWindowMs, lazyWindowMs, mergeGate,
  appMetaFromRow, MERGE_GATE_CONSTANTS,
} = gateRules;

async function getAppMeta(pool, appId) {
  const { rows } = await pool.query(
    'SELECT self_hosted, collab_visibility FROM apps WHERE id = $1',
    [appId]
  );
  return appMetaFromRow(rows[0]);
}

// The vote denominator (src/workflow/rules/electorate.ts, where the
// queries and their reasons are). `meta` ({ selfHosted, collabPrivate })
// skips reading the app row again when the caller already has it.
async function getActiveUserStats(pool, appId, meta = null) {
  return electorateRules.activeUserStats(pool, appId, meta || await getAppMeta(pool, appId));
}

// Concept #1 — pure ACTIVITY: has this user "tested"/is currently active on
// this app, ignoring collab-eligibility? True iff they EVER logged >=60s on a
// single day AND have visited within the last 10 days. self_hosted apps fan
// out across every app's activity (the self-app has no App tab of its own —
// see header). Returns false for unauthenticated callers. This is the right
// predicate for "apps the user is active on" surfaces and a test-before-vote
// gate; it is NOT collab-gated.
async function hasQualifyingActivity(pool, appId, userId) {
  if (!userId) return false;
  const { selfHosted } = await getAppMeta(pool, appId);

  const { rows } = selfHosted
    ? await pool.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM app_activity
             WHERE user_id = $1 AND date >= CURRENT_DATE - 10
           ) AS visited_recently,
           EXISTS (
             SELECT 1 FROM app_activity
             WHERE user_id = $1 AND seconds_spent >= 60
           ) AS ever_qualified`,
        [userId]
      )
    : await pool.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM app_activity
             WHERE app_id = $1 AND user_id = $2 AND date >= CURRENT_DATE - 10
           ) AS visited_recently,
           EXISTS (
             SELECT 1 FROM app_activity
             WHERE app_id = $1 AND user_id = $2 AND seconds_spent >= 60
           ) AS ever_qualified`,
        [appId, userId]
      );
  const r = rows[0] || {};
  return !!(r.visited_recently && r.ever_qualified);
}

// Concept #2 — COLLAB-ELIGIBILITY gate: everyone is eligible except on
// non-self-hosted collab_visibility='private' apps, where only status='member'
// collaborators are. Independent of activity. Returns false for
// unauthenticated callers.
async function isCollabEligible(pool, appId, userId) {
  if (!userId) return false;
  const { selfHosted, collabPrivate } = await getAppMeta(pool, appId);
  if (selfHosted || !collabPrivate) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM app_collaborators WHERE app_id = $1 AND user_id = $2 AND status = 'member'`,
    [appId, userId]
  );
  return rows.length > 0;
}

// Concept #4 — A RECENT INVITE: did this user accept an invite to build this
// app in the last 10 days? Never on a self-hosted app (see header). Reads one
// boolean column, so an answer the pool cannot give is a no.
async function acceptedInviteRecently(pool, appId, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM app_collaborators c
         JOIN apps ap ON ap.id = c.app_id
        WHERE c.app_id = $1 AND c.user_id = $2 AND c.status = 'member'
          AND c.accepted_at >= CURRENT_DATE - 10
          AND NOT ap.self_hosted
     ) AS accepted_recently`,
    [appId, userId]
  );
  return rows?.[0]?.accepted_recently === true;
}

// Whether a specific user is currently counted in the active (voter) set:
// (activity ∪ recent invite) ∩ collab-eligibility ∩ membership, matching
// getActiveUserStats. Used by the
// dashboard's "are you counted as a user?" indicator and any callers that need
// a per-viewer answer rather than a count. Eligibility is checked first so a
// non-member on a collab-private app short-circuits before the heavier
// activity lookup. Returns false for unauthenticated callers.
async function isUserActive(pool, appId, userId) {
  if (!userId) return false;
  if (!(await isCollabEligible(pool, appId, userId))) return false;
  if (!(await isCommunityMember(pool, appId, userId))) return false;
  if (await hasQualifyingActivity(pool, appId, userId)) return true;
  return acceptedInviteRecently(pool, appId, userId);
}

// Concept #3 — MEMBERSHIP (communities): is this user in the community the
// app belongs to? The same rule the counts above apply inline, for the one
// viewer: an app with no community (a row between its insert and the
// backfill, see schema.sql) does not gate, and an answer the pool cannot give
// (no row) does not either — this narrows who is counted, it never widens it
// past what the older two concepts allow.
async function isCommunityMember(pool, appId, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    `SELECT (ap.community_id IS NULL OR EXISTS (
              SELECT 1 FROM community_members cm
               WHERE cm.community_id = ap.community_id AND cm.user_id = $2
            )) AS ok
       FROM apps ap WHERE ap.id = $1`,
    [appId, userId]
  );
  return rows.length ? rows[0].ok !== false : true;
}

// The full set of user ids currently counted as active for an app, by the
// same definition as getActiveUserStats (src/workflow/rules/electorate.ts).
async function listActiveUserIds(pool, appId) {
  return electorateRules.activeUserIds(pool, appId, await getAppMeta(pool, appId));
}

module.exports = {
  getActiveUserStats,
  appMetaFromRow,
  isUserActive,
  listActiveUserIds,
  hasQualifyingActivity,
  acceptedInviteRecently,
  isCollabEligible,
  isCommunityMember,
  requiredVotes,
  mergeWindowMs,
  lazyWindowMs,
  rejectionWindowMs,
  oppositionWindowMs,
  isContested,
  mergeGate,
  // Exported for tests / config visibility.
  MERGE_GATE_CONSTANTS,
};

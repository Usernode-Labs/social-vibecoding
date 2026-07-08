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
// The vote-facing helpers (`getActiveUserStats`, `listActiveUserIds`,
// `isUserActive`) return the INTERSECTION (activity ∩ eligibility): the
// majority denominator must only count users who can actually vote, or a
// view-public/collab-private app's threshold becomes unreachable
// (non-voting viewers inflating floor(active/2)+1). Display/"tested"
// surfaces use concept #1 alone.
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
// platform" — and unblocks self-app voting/governance.

// ---------------------------------------------------------------------------
// Dynamic merge gates (see SPEC: "Visibility window + dynamic threshold").
//
// A proposal merges through one of two paths:
//
//   A. Threshold path — both gates below hold (eased Yes threshold met AND
//      the minimum visibility window has elapsed).
//   B. Lazy-consensus path — the threshold is NOT met, but the proposal has
//      real unopposed support (>= 1 Yes, Yes strictly leading, not
//      contested) and its lazy merge window has elapsed. Silence is consent:
//      on small apps the threshold (floored at 2) is often unreachable
//      because the other members simply never vote. See lazyWindowMs.
//
// Two independent, pure gates that both must hold for the threshold path:
//
//   1. requiredVotes(active, noCount) — the eased Yes-vote threshold. Largest
//      discount when unopposed; rises back toward the simple majority M as No
//      votes arrive; never exceeds M and never drops below an anti-self-merge
//      floor. Replaces the old fixed `majority` count gate.
//
//   2. mergeWindowMs(active, yesCount, noCount) — a minimum *visibility window*
//      measured from when the proposal opened. Shrinks as the Yes fraction
//      climbs (7d at low participation → 3d at 1/3 → 0 at majority, with a
//      front-loaded non-linear drop between 1/3 and 1/2), and is pushed back
//      out toward the 7d max by opposition. A clear majority (yes >= M) or a
//      Contested proposal (No fraction >= 1/3) collapses the window to 0.
//
// Both are pure given the constants below, so they're unit-testable in
// isolation and shared verbatim by the merge route, the governance paths, the
// stale-PR sweeper, and the client (via the serialized window-end timestamp).
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

// Dynamic-threshold knobs. Defaults: a quarter-of-active discount when
// unopposed (BASE_DISCOUNT_DIVISOR=4), each No worth two votes of that
// discount (DOWN_WEIGHT=2), never below two Yes once an app has >=2 active
// users (FLOOR=2). Env-overridable to mirror the rest of config.js.
const BASE_DISCOUNT_DIVISOR = parseInt(process.env.VOTE_BASE_DISCOUNT_DIVISOR || '4', 10);
const DOWN_WEIGHT = parseInt(process.env.VOTE_DOWN_WEIGHT || '2', 10);
const FLOOR = parseInt(process.env.VOTE_FLOOR || '2', 10);

// Visibility-window knobs (windows in ms, like prStaleNotifyMs in config.js).
const WINDOW_MAX_MS = parseInt(process.env.MERGE_WINDOW_MAX_MS || String(7 * DAY_MS), 10);
const WINDOW_MID_MS = parseInt(process.env.MERGE_WINDOW_MID_MS || String(3 * DAY_MS), 10);
const WINDOW_CURVE_EXP = parseFloat(process.env.MERGE_WINDOW_CURVE_EXP || '3');
// Fraction breakpoints. The mid mark is where the window settles to
// WINDOW_MID_MS; the majority mark is where it collapses to 0; the contested
// mark is the No fraction at which the window stops applying entirely.
const YES_MID_FRAC = 1 / 3;
const YES_MAJORITY_FRAC = 1 / 2;
const CONTESTED_NO_FRAC = 1 / 3;

// Auto-takedown (rejection) knobs — the symmetric mirror of the merge window.
// A proposal that the group is voting down (No > Yes) without ever reaching a
// base of support (Yes fraction < REJECT_KEEPALIVE_YES_FRAC) gets a rejection
// window: ~7d when No only barely leads, shrinking non-linearly toward instant
// as No dominates. REJECT_MIN_NO mirrors the merge FLOOR so a lone No can never
// auto-close. The keep-alive fraction reuses YES_MID_FRAC (1/3).
const REJECT_WINDOW_MAX_MS = parseInt(process.env.REJECT_WINDOW_MAX_MS || String(7 * DAY_MS), 10);
const REJECT_CURVE_EXP = parseFloat(process.env.REJECT_WINDOW_CURVE_EXP || '3');
const REJECT_MIN_NO = parseInt(process.env.REJECT_MIN_NO || '2', 10);
const REJECT_KEEPALIVE_YES_FRAC = YES_MID_FRAC;

// Lazy-consensus knobs: a proposal that has SOME support (Yes strictly
// leading, no contest) but hasn't reached the eased threshold arms a merge
// clock anyway — silence is consent. The clock is count-based (NOT
// fraction-based like mergeWindowMs) because on the platform's typical 2–4
// active-user apps, fractions quantize so coarsely that a single Yes is
// already 25–50% and the fraction curves degenerate (see #310 follow-up:
// timers were unreachable below 5 active users). One missing vote → 3d,
// each additional missing vote → +2d, capped at the 7d max.
const LAZY_WINDOW_BASE_MS = parseInt(process.env.LAZY_WINDOW_BASE_MS || String(3 * DAY_MS), 10);
const LAZY_WINDOW_STEP_MS = parseInt(process.env.LAZY_WINDOW_STEP_MS || String(2 * DAY_MS), 10);

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

// The eased Yes-vote threshold. Pure. M = floor(active/2)+1 is both the
// simple majority and the hard upper cap (opposition can restore the bar but
// never push it above majority — no permanent deadlock).
function requiredVotes(active, noCount) {
  const a = Math.max(parseInt(active, 10) || 0, 1);
  const no = Math.max(parseInt(noCount, 10) || 0, 0);
  const M = Math.floor(a / 2) + 1;
  const discount = Math.max(0, Math.floor(a / BASE_DISCOUNT_DIVISOR) - DOWN_WEIGHT * no);
  const floorEff = Math.min(FLOOR, M);
  return clamp(M - discount, floorEff, M);
}

// Whether opposition has crossed the "Contested" line — at/above this the
// window no longer applies and the proposal is a pure simple-majority count
// gate (today's behaviour).
function isContested(active, noCount) {
  const a = Math.max(parseInt(active, 10) || 0, 1);
  const no = Math.max(parseInt(noCount, 10) || 0, 0);
  return no / a >= CONTESTED_NO_FRAC;
}

// The minimum visibility window in ms. Pure. See the block comment above for
// the shape; returns 0 whenever the window doesn't gate (majority reached or
// contested).
function mergeWindowMs(active, yesCount, noCount) {
  const a = Math.max(parseInt(active, 10) || 0, 1);
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const no = Math.max(parseInt(noCount, 10) || 0, 0);
  const M = Math.floor(a / 2) + 1;
  // A clear majority satisfies the window instantly ("majority just merges").
  if (yes >= M) return 0;
  const yesFrac = yes / a;
  const noFrac = no / a;
  // Contested: opposition has removed the window entirely.
  if (noFrac >= CONTESTED_NO_FRAC) return 0;

  let yesWindow;
  if (yesFrac >= YES_MAJORITY_FRAC) {
    // >= 1/2 of active said Yes: collapse to instant.
    yesWindow = 0;
  } else if (yesFrac < YES_MID_FRAC) {
    // Low participation: linear ramp 7d (at 0) -> 3d (at 1/3).
    const f = yesFrac / YES_MID_FRAC;
    yesWindow = WINDOW_MAX_MS + f * (WINDOW_MID_MS - WINDOW_MAX_MS);
  } else {
    // Between 1/3 and 1/2: non-linear, front-loaded 3d -> 0. Stays near 3d
    // for most of the range, then drops sharply as Yes nears a majority.
    const t = (yesFrac - YES_MID_FRAC) / (YES_MAJORITY_FRAC - YES_MID_FRAC);
    yesWindow = WINDOW_MID_MS * (1 - Math.pow(t, WINDOW_CURVE_EXP));
  }

  // No-vote pushback: blend the Yes-driven window back toward the max on a
  // gradient as the No fraction rises from 0 toward the contested cut-off.
  const p = clamp(noFrac / CONTESTED_NO_FRAC, 0, 1);
  const windowMs = yesWindow + p * (WINDOW_MAX_MS - yesWindow);
  return Math.round(clamp(windowMs, 0, WINDOW_MAX_MS));
}

// One-call convenience that derives every field the merge route, sweeper, and
// The auto-takedown (rejection) window in ms, or `null` when no rejection
// clock applies. Pure, and the symmetric mirror of mergeWindowMs. The `null`
// sentinel distinguishes "not armed / kept alive" from "armed, reject
// instantly" (0). Returns:
//   - null  if Yes fraction >= keep-alive (a base of support protects it),
//   - null  if No does not strictly outnumber Yes, or No < REJECT_MIN_NO
//           (a lone No can never auto-close — mirrors the merge FLOOR),
//   - else  REJECT_WINDOW_MAX_MS * (1 - t**REJECT_CURVE_EXP), where the
//           dominance margin t = (no - yes) / (no + yes): ~max when No barely
//           leads, front-loaded down toward 0 as No dominates Yes.
function rejectionWindowMs(active, yesCount, noCount) {
  const a = Math.max(parseInt(active, 10) || 0, 1);
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const no = Math.max(parseInt(noCount, 10) || 0, 0);
  // Keep-alive: any real base of Yes support cancels the rejection clock.
  if (yes / a >= REJECT_KEEPALIVE_YES_FRAC) return null;
  // Arming guard: only once No strictly leads Yes AND clears the min-No floor.
  if (no <= yes || no < REJECT_MIN_NO) return null;
  const t = (no - yes) / (no + yes); // dominance margin in (0, 1]
  const windowMs = REJECT_WINDOW_MAX_MS * (1 - Math.pow(t, REJECT_CURVE_EXP));
  return Math.round(clamp(windowMs, 0, REJECT_WINDOW_MAX_MS));
}

// The lazy-consensus merge window in ms, or `null` when it doesn't apply.
// Pure. Arms when a proposal has real support but hasn't reached the eased
// threshold: at least 1 Yes, Yes strictly leading No, and not contested.
// While armed, the proposal auto-merges once the window elapses — silence is
// consent; the visibility window IS the objection period. Returns:
//   - null  if yes >= requiredVotes (the threshold path owns the clock),
//   - null  if yes < 1, or No ties/leads Yes (a tie is a stalemate, and a
//           No lead belongs to the rejection clock — mutual exclusivity),
//   - null  if contested (No >= 1/3 of active: all clocks off, pure
//           majority race),
//   - else  LAZY_WINDOW_BASE_MS + (missing - 1) * LAZY_WINDOW_STEP_MS where
//           missing = required - yes, capped at WINDOW_MAX_MS. Count-based
//           on purpose — see the knobs comment above.
function lazyWindowMs(active, yesCount, noCount) {
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const no = Math.max(parseInt(noCount, 10) || 0, 0);
  const required = requiredVotes(active, noCount);
  if (yes >= required) return null;
  if (yes < 1 || yes <= no) return null;
  if (isContested(active, noCount)) return null;
  const missing = required - yes;
  return Math.round(clamp(
    LAZY_WINDOW_BASE_MS + (missing - 1) * LAZY_WINDOW_STEP_MS,
    0, WINDOW_MAX_MS
  ));
}

// client need from a single (active, yes, no, openedAt) snapshot. `now` and
// `openedAt` accept a Date, ms number, or ISO string; `openedAt` falls back to
// `now` when missing (so a proposal with no anchor is treated as just-opened).
function mergeGate(active, yesCount, noCount, openedAt, now) {
  const toMs = (v, fallback) => {
    if (v == null) return fallback;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : fallback;
  };
  const nowMs = toMs(now, Date.now());
  const openedMs = toMs(openedAt, nowMs);
  const required = requiredVotes(active, noCount);
  const contested = isContested(active, noCount);
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const thresholdMet = yes >= required;

  // One effective merge clock, owned by whichever path applies:
  //   - threshold met → the fraction-based minimum visibility window
  //     (a brake on an already-approved proposal), or
  //   - threshold NOT met but lazy consensus armed → the count-based lazy
  //     window (an alternative path: elapsing MERGES the proposal).
  // Serialized as one windowEndsAt so every consumer (merge routes, sweeper,
  // countdown pill) reads a single timestamp regardless of which path armed.
  const lazyMs = lazyWindowMs(active, yesCount, noCount);
  const lazyArmed = !thresholdMet && lazyMs !== null;
  const windowMs = thresholdMet ? mergeWindowMs(active, yesCount, noCount)
    : lazyArmed ? lazyMs : 0;
  const windowElapsed = windowMs <= 0 || nowMs - openedMs >= windowMs;
  const windowEndsAt = windowMs > 0 ? new Date(openedMs + windowMs).toISOString() : null;

  // Auto-takedown side, anchored on the same openedAt as the merge window.
  const rejWindowMs = rejectionWindowMs(active, yesCount, noCount);
  const rejectionArmed = rejWindowMs !== null;
  const rejectionElapsed = rejectionArmed && nowMs - openedMs >= rejWindowMs;
  const rejectionEndsAt = rejectionArmed
    ? new Date(openedMs + rejWindowMs).toISOString()
    : null;

  return {
    required,
    windowMs,
    windowEndsAt,
    contested,
    thresholdMet,
    windowElapsed,
    // Lazy consensus (below-threshold merge clock).
    lazyArmed,
    lazyWindowMs: lazyArmed ? lazyMs : null,
    mergeable: (thresholdMet || lazyArmed) && windowElapsed,
    // Rejection (auto-takedown) fields.
    rejectionWindowMs: rejWindowMs,
    rejectionArmed,
    rejectionEndsAt,
    rejectable: rejectionArmed && rejectionElapsed,
  };
}

async function getAppMeta(pool, appId) {
  const { rows } = await pool.query(
    'SELECT self_hosted, collab_visibility FROM apps WHERE id = $1',
    [appId]
  );
  return {
    selfHosted: !!rows[0]?.self_hosted,
    collabPrivate: rows[0]?.collab_visibility === 'private',
  };
}

async function getActiveUserStats(pool, appId) {
  const { selfHosted, collabPrivate } = await getAppMeta(pool, appId);

  const { rows } = selfHosted
    ? await pool.query(
        `SELECT COUNT(DISTINCT a.user_id) AS cnt
           FROM app_activity a
           WHERE a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )`
      )
    : await pool.query(
        `SELECT COUNT(DISTINCT a.user_id) AS cnt
           FROM app_activity a
           WHERE a.app_id = $1
             AND a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.app_id = $1
                 AND b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )
             AND (NOT $2::boolean OR EXISTS (
               SELECT 1 FROM app_collaborators c
               WHERE c.app_id = $1 AND c.user_id = a.user_id AND c.status = 'member'
             ))`,
        [appId, collabPrivate]
      );
  // Floor at 1 so the vote machinery's majority threshold is never
  // 0/0; this is a vote-correctness floor, not a real-count guarantee.
  // The dashboard tile passes the same value through; on a brand-new
  // app that means the tile reads "1 active" until the first real
  // qualifier shows up. Acceptable for now.
  const active = Math.max(parseInt(rows[0].cnt, 10) || 0, 1);
  const majority = Math.floor(active / 2) + 1;
  return { active, majority };
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

// Whether a specific user is currently counted in the active (voter) set:
// activity ∩ collab-eligibility, matching getActiveUserStats. Used by the
// dashboard's "are you counted as a user?" indicator and any callers that need
// a per-viewer answer rather than a count. Eligibility is checked first so a
// non-member on a collab-private app short-circuits before the heavier
// activity lookup. Returns false for unauthenticated callers.
async function isUserActive(pool, appId, userId) {
  if (!userId) return false;
  if (!(await isCollabEligible(pool, appId, userId))) return false;
  return hasQualifyingActivity(pool, appId, userId);
}

// The full set of user ids currently counted as active for an app,
// using the same definition as getActiveUserStats (so "who gets the
// vote-request ping" matches "whose votes count"). Returns a bare
// array of ids. self_hosted apps fan out across every app's activity,
// mirroring getActiveUserStats's union semantics.
async function listActiveUserIds(pool, appId) {
  const { selfHosted, collabPrivate } = await getAppMeta(pool, appId);

  const { rows } = selfHosted
    ? await pool.query(
        `SELECT DISTINCT a.user_id AS id
           FROM app_activity a
           WHERE a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )`
      )
    : await pool.query(
        `SELECT DISTINCT a.user_id AS id
           FROM app_activity a
           WHERE a.app_id = $1
             AND a.date >= CURRENT_DATE - 10
             AND EXISTS (
               SELECT 1 FROM app_activity b
               WHERE b.app_id = $1
                 AND b.user_id = a.user_id
                 AND b.seconds_spent >= 60
             )
             AND (NOT $2::boolean OR EXISTS (
               SELECT 1 FROM app_collaborators c
               WHERE c.app_id = $1 AND c.user_id = a.user_id AND c.status = 'member'
             ))`,
        [appId, collabPrivate]
      );
  return rows.map((r) => r.id);
}

module.exports = {
  getActiveUserStats,
  isUserActive,
  listActiveUserIds,
  hasQualifyingActivity,
  isCollabEligible,
  requiredVotes,
  mergeWindowMs,
  lazyWindowMs,
  rejectionWindowMs,
  isContested,
  mergeGate,
  // Exported for tests / config visibility.
  MERGE_GATE_CONSTANTS: {
    BASE_DISCOUNT_DIVISOR,
    DOWN_WEIGHT,
    FLOOR,
    WINDOW_MAX_MS,
    WINDOW_MID_MS,
    WINDOW_CURVE_EXP,
    YES_MID_FRAC,
    YES_MAJORITY_FRAC,
    CONTESTED_NO_FRAC,
    REJECT_WINDOW_MAX_MS,
    REJECT_CURVE_EXP,
    REJECT_MIN_NO,
    REJECT_KEEPALIVE_YES_FRAC,
    LAZY_WINDOW_BASE_MS,
    LAZY_WINDOW_STEP_MS,
  },
};

// Shared definition of "active user" used by both the vote-majority
// machinery (PR + issue thresholds) and the group-chat dashboard tile,
// so the number that gates voting matches the number users see.
//
// Active-user definition (current — see SPEC.md):
//
//   - **Qualifying event** (sticky): the user has accumulated >= 60
//     seconds on a single calendar day on this app at some point in
//     their history with it (`app_activity.seconds_spent >= 60`).
//     Once they've ever crossed this bar, they're a qualified user
//     for the rest of their relationship with the app.
//
//   - **Retention**: a qualified user is currently counted as active
//     if they have at least one row in `app_activity` for this app
//     dated within the last 10 calendar days. Any visit counts —
//     opening the App tab is enough; you don't need another 60s
//     session each time. If 10 calendar days pass with no visits the
//     user falls out of the active count and would have to come back
//     to be re-counted.
//
//   - **Collab-private scoping**: for apps with
//     collab_visibility='private', only collaborators (status='member'
//     in app_collaborators) count. Without this, viewers of a
//     view-public/collab-private app would inflate the vote-majority
//     denominator while being unable to vote.
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
// Two independent, pure gates that BOTH must hold before a proposal merges:
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
  const windowMs = mergeWindowMs(active, yesCount, noCount);
  const contested = isContested(active, noCount);
  const yes = Math.max(parseInt(yesCount, 10) || 0, 0);
  const thresholdMet = yes >= required;
  const windowElapsed = windowMs <= 0 || nowMs - openedMs >= windowMs;
  const windowEndsAt = windowMs > 0 ? new Date(openedMs + windowMs).toISOString() : null;
  return {
    required,
    windowMs,
    windowEndsAt,
    contested,
    thresholdMet,
    windowElapsed,
    mergeable: thresholdMet && windowElapsed,
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

// Whether a specific user is currently counted in the active set,
// using the same definition as getActiveUserStats. Used by the
// dashboard's "are you counted as a user?" indicator and any callers
// that need a per-viewer answer rather than a count. Returns false
// for unauthenticated callers.
async function isUserActive(pool, appId, userId) {
  if (!userId) return false;
  const { selfHosted, collabPrivate } = await getAppMeta(pool, appId);

  if (!selfHosted && collabPrivate) {
    const { rows: memberRows } = await pool.query(
      `SELECT 1 FROM app_collaborators WHERE app_id = $1 AND user_id = $2 AND status = 'member'`,
      [appId, userId]
    );
    if (!memberRows.length) return false;
  }

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
  requiredVotes,
  mergeWindowMs,
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
  },
};

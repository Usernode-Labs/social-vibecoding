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

async function isSelfHostedApp(pool, appId) {
  const { rows } = await pool.query(
    'SELECT self_hosted FROM apps WHERE id = $1',
    [appId]
  );
  return !!rows[0]?.self_hosted;
}

async function getActiveUserStats(pool, appId) {
  const selfHosted = await isSelfHostedApp(pool, appId);

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
             )`,
        [appId]
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
  const selfHosted = await isSelfHostedApp(pool, appId);

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

module.exports = { getActiveUserStats, isUserActive };

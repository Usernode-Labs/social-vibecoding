'use strict';

// Apps & usage (#admin/apps): every app on the platform with who is in it,
// who has built it and how much it is being used, for the admin console
// (frontend/src/features/admin/admin-apps-usage.tsx).
//
// Every figure is read from tables the platform already keeps; nothing new is
// recorded for this screen.
//
//   members        community_members of the app's community (what Join adds)
//   contributors   distinct people who put a change up for a vote
//                  (chat_sessions with a pull request), and of them how many
//                  had one merged
//   users, time    app_activity: distinct people who used the app, and the
//                  seconds they spent in it, inside the window
//   proposals      chat_sessions promoted to a vote inside the window
//   merged         chat_sessions merged inside the window
//   requests       ordinary requests (issues of kind 'general') filed inside
//                  the window, and how many are open now
//   last active    the latest of any of the above, all time
//
// Read-only, so view-only admins see all of it.

const WINDOWS = Object.freeze([7, 30, 90]);
const DEFAULT_DAYS = 30;
const TOP_CONTRIBUTORS = 5;

/** The window a query string asks for, held to the ones the screen offers. */
function windowDays(raw) {
  const n = Number.parseInt(raw, 10);
  return WINDOWS.includes(n) ? n : DEFAULT_DAYS;
}

const APPS_SQL = `
  WITH win AS (SELECT NOW() - make_interval(days => $1::int) AS since),
  members AS (
    SELECT a.id AS app_id,
           COUNT(cm.user_id)::int AS members,
           COUNT(cm.user_id) FILTER (WHERE cm.joined_at >= win.since)::int AS new_members
      FROM apps a
      CROSS JOIN win
      JOIN community_members cm ON cm.community_id = a.community_id
     GROUP BY a.id
  ),
  work AS (
    SELECT cs.app_id,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE cs.pr_number IS NOT NULL)::int AS contributors,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE cs.merged_at IS NOT NULL)::int AS shipped_contributors,
           COUNT(*) FILTER (WHERE cs.created_at >= win.since)::int AS sessions,
           COUNT(*) FILTER (WHERE cs.promoted_at >= win.since)::int AS proposed,
           COUNT(*) FILTER (WHERE cs.merged_at >= win.since)::int AS merged,
           MAX(GREATEST(cs.created_at, cs.promoted_at, cs.merged_at)) AS last_at
      FROM chat_sessions cs
      CROSS JOIN win
     GROUP BY cs.app_id
  ),
  requests AS (
    SELECT i.app_id,
           COUNT(*) FILTER (WHERE i.created_at >= win.since)::int AS requests,
           COUNT(*) FILTER (WHERE i.status = 'open')::int AS open_requests,
           MAX(i.created_at) AS last_at
      FROM issues i
      CROSS JOIN win
     WHERE i.kind = 'general'
     GROUP BY i.app_id
  ),
  usage AS (
    SELECT aa.app_id,
           COUNT(DISTINCT aa.user_id) FILTER (WHERE aa.date >= win.since::date)::int AS users,
           COALESCE(SUM(aa.seconds_spent) FILTER (WHERE aa.date >= win.since::date), 0)::bigint AS seconds,
           MAX(aa.date) AS last_day
      FROM app_activity aa
      CROSS JOIN win
     GROUP BY aa.app_id
  )
  SELECT a.id, a.slug, a.name, a.status, a.self_hosted, a.view_visibility,
         a.created_at, a.last_deploy_at, u.username AS creator,
         COALESCE(m.members, 0) AS members, COALESCE(m.new_members, 0) AS new_members,
         COALESCE(w.contributors, 0) AS contributors,
         COALESCE(w.shipped_contributors, 0) AS shipped_contributors,
         COALESCE(w.sessions, 0) AS sessions, COALESCE(w.proposed, 0) AS proposed,
         COALESCE(w.merged, 0) AS merged,
         COALESCE(r.requests, 0) AS requests, COALESCE(r.open_requests, 0) AS open_requests,
         COALESCE(g.users, 0) AS users, COALESCE(g.seconds, 0) AS seconds,
         GREATEST(w.last_at, r.last_at, g.last_day::timestamptz) AS last_active_at
    FROM apps a
    LEFT JOIN users u ON u.id = a.created_by
    LEFT JOIN members m ON m.app_id = a.id
    LEFT JOIN work w ON w.app_id = a.id
    LEFT JOIN requests r ON r.app_id = a.id
    LEFT JOIN usage g ON g.app_id = a.id
   ORDER BY a.created_at DESC, a.id DESC
`;

const CONTRIBUTORS_SQL = `
  SELECT app_id, username, proposed, merged
    FROM (
      SELECT cs.app_id, u.username,
             COUNT(*)::int AS proposed,
             COUNT(*) FILTER (WHERE cs.merged_at IS NOT NULL)::int AS merged,
             ROW_NUMBER() OVER (
               PARTITION BY cs.app_id
               ORDER BY COUNT(*) FILTER (WHERE cs.merged_at IS NOT NULL) DESC, COUNT(*) DESC, u.username
             ) AS rank
        FROM chat_sessions cs
        JOIN users u ON u.id = cs.user_id
       WHERE cs.pr_number IS NOT NULL
       GROUP BY cs.app_id, u.username
    ) ranked
   WHERE rank <= $1
   ORDER BY app_id, rank
`;

const iso = (v) => (v == null ? null : new Date(v).toISOString());

function appView(row, top) {
  return {
    slug: row.slug,
    name: row.name,
    status: row.status,
    platform: !!row.self_hosted,
    visibility: row.view_visibility || null,
    creator: row.creator || null,
    createdAt: iso(row.created_at),
    lastDeployAt: iso(row.last_deploy_at),
    lastActiveAt: iso(row.last_active_at),
    members: row.members,
    newMembers: row.new_members,
    contributors: row.contributors,
    shippedContributors: row.shipped_contributors,
    topContributors: top || [],
    users: row.users,
    seconds: Number(row.seconds) || 0,
    sessions: row.sessions,
    proposed: row.proposed,
    merged: row.merged,
    requests: row.requests,
    openRequests: row.open_requests,
  };
}

/** The platform-wide line above the table. Pure. */
function totals(apps) {
  const sum = (k) => apps.reduce((n, a) => n + (a[k] || 0), 0);
  return {
    apps: apps.length,
    usedApps: apps.filter((a) => a.users > 0).length,
    builtApps: apps.filter((a) => a.proposed > 0 || a.merged > 0).length,
    seconds: sum('seconds'),
    proposed: sum('proposed'),
    merged: sum('merged'),
    requests: sum('requests'),
  };
}

async function adminPayload(pool, { days } = {}) {
  const d = windowDays(days);
  const [apps, contributors] = await Promise.all([
    pool.query(APPS_SQL, [d]),
    pool.query(CONTRIBUTORS_SQL, [TOP_CONTRIBUTORS]),
  ]);
  const topByApp = new Map();
  for (const c of contributors.rows) {
    const list = topByApp.get(c.app_id) || [];
    list.push({ username: c.username, proposed: c.proposed, merged: c.merged });
    topByApp.set(c.app_id, list);
  }
  const views = apps.rows.map((r) => appView(r, topByApp.get(r.id)));
  return { days: d, windows: [...WINDOWS], totals: totals(views), apps: views };
}

module.exports = {
  adminPayload,
  windowDays,
  totals,
  WINDOWS,
  DEFAULT_DAYS,
  TOP_CONTRIBUTORS,
};

'use strict';

// The apps the "Use apps for N minutes" challenge page offers to open (#6463).
//
// The page offers a choice of up to three, so each has to be an app whose
// minutes would count: one the viewer did not make, that anybody may open,
// that is running. The most used such apps in the last seven days, by the
// same engaged seconds the challenge counts, then the apps an admin featured
// on Home to fill the rest, each app once; with neither, nothing, and the
// page keeps the organiser's own link. Only a slug, a name and the app's
// icon (the server-built /app-icons/ path or its emoji) leave here: the
// client builds the in-app route from a validated slug, never an address
// from data.
const SUGGESTED_APPS_LIMIT = 3;

const SUGGESTED_APPS_SQL = `
  WITH eligible AS (
    SELECT a.id, a.slug, a.name, a.icon_image_id, a.icon_emoji
      FROM apps a
     WHERE a.status = 'running'
       AND a.view_visibility = 'public'
       AND a.moderation_suspended_at IS NULL
       AND NOT a.self_hosted
       AND a.created_by IS DISTINCT FROM $1
       AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = $1 AND b.app_id = a.id)
  ), used AS (
    SELECT aa.app_id, SUM(aa.seconds_spent) AS seconds
      FROM app_activity aa
     WHERE aa.date > CURRENT_DATE - 7
     GROUP BY aa.app_id
  ), ranked AS (
    SELECT e.*, 0 AS rank_group, -COALESCE(u.seconds, 0) AS rank_value
      FROM eligible e JOIN used u ON u.app_id = e.id
     WHERE u.seconds > 0
    UNION ALL
    SELECT e.*, 1 AS rank_group, fa.sort_order AS rank_value
      FROM eligible e JOIN featured_apps fa ON fa.app_id = e.id
  ), best AS (
    SELECT DISTINCT ON (id) * FROM ranked ORDER BY id, rank_group ASC, rank_value ASC
  )
  SELECT slug, name, icon_image_id, icon_emoji
    FROM best
   ORDER BY rank_group ASC, rank_value ASC, id ASC
   LIMIT $2
`;

async function suggestedApps(pool, userId, limit = SUGGESTED_APPS_LIMIT) {
  if (userId == null) return [];
  const { rows } = await pool.query(SUGGESTED_APPS_SQL, [userId, limit]);
  return rows.filter((row) => row.slug).map((row) => ({
    slug: String(row.slug),
    name: String(row.name || row.slug),
    // Server-built, as GET /api/apps builds it, so the client never
    // assembles ids into paths.
    icon_url: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
    icon_emoji: row.icon_emoji ? String(row.icon_emoji) : null,
  }));
}

module.exports = { suggestedApps, SUGGESTED_APPS_SQL, SUGGESTED_APPS_LIMIT };

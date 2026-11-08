'use strict';

// The app the "Use apps for N minutes" challenge page offers to open (#6463).
//
// The page's one action is "Open <app>", so it has to name an app whose
// minutes would count: one the viewer did not make, that anybody may open,
// that is running. The most used such app in the last seven days, by the
// same engaged seconds the challenge counts; with no recent use anywhere, the
// first app an admin featured on Home; else nothing, and the page keeps the
// organiser's own link. Only a slug and a name leave here: the client builds
// the in-app route from a validated slug, never an address from data.
const SUGGESTED_APP_SQL = `
  WITH eligible AS (
    SELECT a.id, a.slug, a.name
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
  )
  SELECT e.slug, e.name, 0 AS rank_group, -COALESCE(u.seconds, 0) AS rank_value, e.id
    FROM eligible e JOIN used u ON u.app_id = e.id
   WHERE u.seconds > 0
  UNION ALL
  SELECT e.slug, e.name, 1 AS rank_group, fa.sort_order AS rank_value, e.id
    FROM eligible e JOIN featured_apps fa ON fa.app_id = e.id
   ORDER BY rank_group ASC, rank_value ASC, id ASC
   LIMIT 1
`;

async function suggestedApp(pool, userId) {
  if (userId == null) return null;
  const { rows } = await pool.query(SUGGESTED_APP_SQL, [userId]);
  const row = rows[0];
  if (!row || !row.slug) return null;
  return { slug: String(row.slug), name: String(row.name || row.slug) };
}

module.exports = { suggestedApp, SUGGESTED_APP_SQL };

'use strict';

// The public app-directory projection shared by the anonymous public API and
// the versioned app-facing API. Keeping the query and serializer here means a
// hosted app cannot see a different visibility set, contributor definition,
// or field shape from the directory people see on Homeroom itself.

const { productionHostname } = require('./caddy');
const { loadContributors, shapeContributor } = require('./contributors');

// Apps that do not currently have a usable deployment never appear in the
// public directory. View-private and self-hosted rows are filtered in SQL too.
const HIDDEN_APP_STATUSES = ['error', 'creating', 'awaiting_secrets'];

async function listPublicApps(pool, { includeWallets = true } = {}) {
  // The active-users join mirrors the authed home list's sticky 10-day rule:
  // a user counts iff they ever spent >= 60s on the app on a single day AND
  // visited within 10 days. One query returns one row per app.
  const { rows: apps } = await pool.query(
    `SELECT a.id, a.name, a.slug, a.status, a.collab_visibility,
            a.view_visibility, a.created_at, a.last_deploy_at,
            a.icon_emoji, a.icon_image_id, a.anon_shell,
            COALESCE(au.cnt, 0) AS active_users
       FROM apps a
       LEFT JOIN (
         SELECT a1.app_id, COUNT(DISTINCT a1.user_id) AS cnt
         FROM app_activity a1
         WHERE a1.date >= CURRENT_DATE - 10
           AND EXISTS (
             SELECT 1 FROM app_activity a2
             WHERE a2.app_id = a1.app_id
               AND a2.user_id = a1.user_id
               AND a2.seconds_spent >= 60
           )
         GROUP BY a1.app_id
       ) au ON au.app_id = a.id
      WHERE NOT a.self_hosted
        AND a.view_visibility = 'public'
        AND a.status <> ALL($1::text[])
      ORDER BY COALESCE(au.cnt, 0) DESC,
               a.last_deploy_at DESC NULLS LAST, a.created_at DESC`,
    [HIDDEN_APP_STATUSES]
  );

  const byApp = await loadContributors(pool, apps.map((app) => app.id));

  return apps.map((app) => ({
    id: app.id,
    name: app.name,
    slug: app.slug,
    status: app.status,
    collab_visibility: app.collab_visibility,
    view_visibility: app.view_visibility,
    created_at: app.created_at,
    last_deploy_at: app.last_deploy_at,
    // Home-card presentation fields. The icon path is relative to the
    // platform origin; app servers also receive USERNODE_PLATFORM_ORIGIN.
    icon_emoji: app.icon_emoji || null,
    icon_url: app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null,
    active_users: parseInt(app.active_users, 10) || 0,
    // Anything not positively classified public fails safe to login-gated.
    requires_login: app.anon_shell !== 'public',
    // Use the returned URL rather than reconstructing a host from the slug.
    url: `https://${productionHostname(app.slug)}`,
    contributors: (byApp.get(app.id) || []).map((row) =>
      shapeContributor(row, includeWallets)
    ),
  }));
}

module.exports = { listPublicApps, HIDDEN_APP_STATUSES };

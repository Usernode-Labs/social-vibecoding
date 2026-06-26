// Public (unauthenticated) read-only API: the platform's publicly-viewable
// apps and, for each, the people who have contributed to it.
//
// Made public via the `/api/public/` prefix in PUBLIC_PATHS
// (src/middleware/auth.js) — same mechanism the kudos leaderboard uses.
// NOTHING here reads req.user; treat every request as fully anonymous.
//
// Privacy model (mirrors the rest of the platform):
//   - Only view-public, non-self-hosted apps are ever listed. A view-
//     private app (or the self-app) is omitted entirely from the list and
//     404s on the per-app route, so its existence is never disclosed —
//     the same non-enumeration stance as services/app-access.js.
//   - usernode_pubkey (the on-chain `ut1…` wallet) is exposed by default,
//     consistent with GET /api/leaderboard/users which already publishes
//     it. `?include_wallets=0` opts the address field out.
//
// Contributors for an app = the DISTINCT union of:
//   1. the creator (apps.created_by),
//   2. accepted members (app_collaborators status='member'),
//   3. authors of merged proposals (chat_sessions status='merged').

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Apps surfaced publicly: not the self-app, view-public, and in a status
// that means the app actually exists/runs (creating / awaiting_secrets /
// error rows aren't usable, so they're hidden — `status` is still returned
// for the rows that do appear).
const HIDDEN_APP_STATUSES = ['error', 'creating', 'awaiting_secrets'];

// One round-trip that resolves the contributor set for any number of app
// ids at once (avoids an N+1 across the apps list). The UNION dedups the
// (app_id, user_id) pairs across the three sources; the join to users drops
// any id that no longer resolves (created_by / user_id are ON DELETE SET
// NULL). Ordered by username for stable output.
async function loadContributors(pool, appIds) {
  if (!appIds.length) return new Map();
  const { rows } = await pool.query(
    `WITH contributor_ids AS (
        SELECT id AS app_id, created_by AS user_id
          FROM apps
         WHERE id = ANY($1::int[]) AND created_by IS NOT NULL
        UNION
        SELECT app_id, user_id
          FROM app_collaborators
         WHERE app_id = ANY($1::int[]) AND status = 'member'
        UNION
        SELECT app_id, user_id
          FROM chat_sessions
         WHERE app_id = ANY($1::int[]) AND status = 'merged' AND user_id IS NOT NULL
     )
     SELECT c.app_id, u.id AS user_id, u.username,
            u.usernode_pubkey AS wallet_address
       FROM contributor_ids c
       JOIN users u ON u.id = c.user_id
      ORDER BY LOWER(u.username)`,
    [appIds]
  );
  const byApp = new Map();
  for (const r of rows) {
    if (!byApp.has(r.app_id)) byApp.set(r.app_id, []);
    byApp.get(r.app_id).push(r);
  }
  return byApp;
}

// Project a contributor row to its wire shape. wallet_address is included
// by default; `includeWallets === false` drops the key entirely.
function shapeContributor(row, includeWallets) {
  const out = { user_id: row.user_id, username: row.username };
  if (includeWallets) out.wallet_address = row.wallet_address ?? null;
  return out;
}

// `?include_wallets=0` (exactly the string '0') opts addresses out;
// anything else (unset, '1', …) keeps them — addresses-on is the default.
function wantsWallets(req) {
  return req.query.include_wallets !== '0';
}

function publicApiRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // GET /api/public/apps — every view-public, non-self-hosted app with its
  // contributors embedded.
  router.get('/api/public/apps', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      const { rows: apps } = await pool.query(
        `SELECT id, name, slug, status, collab_visibility, view_visibility,
                created_at, last_deploy_at
           FROM apps
          WHERE NOT self_hosted
            AND view_visibility = 'public'
            AND status <> ALL($1::text[])
          ORDER BY last_deploy_at DESC NULLS LAST, created_at DESC`,
        [HIDDEN_APP_STATUSES]
      );

      const byApp = await loadContributors(pool, apps.map((a) => a.id));

      res.json({
        apps: apps.map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          status: a.status,
          collab_visibility: a.collab_visibility,
          view_visibility: a.view_visibility,
          created_at: a.created_at,
          last_deploy_at: a.last_deploy_at,
          contributors: (byApp.get(a.id) || []).map((r) =>
            shapeContributor(r, includeWallets)
          ),
        })),
      });
    } catch (err) {
      log.error('public-api', 'apps list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/public/apps/:slug/contributors — one app's contributor list.
  // 404 (never 403) for a missing, self-hosted, or view-private slug so a
  // hidden app's existence isn't disclosed.
  router.get('/api/public/apps/:slug/contributors', async (req, res) => {
    const includeWallets = wantsWallets(req);
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, self_hosted, view_visibility
           FROM apps WHERE slug = $1`,
        [String(req.params.slug)]
      );
      const app = rows[0];
      if (!app || app.self_hosted || app.view_visibility !== 'public') {
        return res.status(404).json({ error: 'App not found' });
      }

      const byApp = await loadContributors(pool, [app.id]);
      res.json({
        slug: app.slug,
        contributors: (byApp.get(app.id) || []).map((r) =>
          shapeContributor(r, includeWallets)
        ),
      });
    } catch (err) {
      log.error('public-api', 'contributors failed', {
        slug: req.params.slug, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  publicApiRoutes,
  // Exported for tests.
  loadContributors,
  shapeContributor,
  HIDDEN_APP_STATUSES,
};

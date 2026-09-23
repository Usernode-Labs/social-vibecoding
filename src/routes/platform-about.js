'use strict';

// "About Homeroom": the platform's own facts, for the mark menu's About pane.
//
//   GET /api/platform/about
//        → { name, tagline, repoUrl, version, updatedAt,
//            stats: { apps, members, merged },
//            selfAppSlug, served }
//
// The menu is the same menu every app has, pointed at the platform itself
// (frontend/src/features/app-context/), and its About pane says what an app's
// says: what it is, who builds it, how. For Homeroom the design adds three
// figures an app's page does not have — how many apps live here, how many
// people, how many changes have merged — because the platform's "who builds
// it" is the whole community rather than a roster.
//
// ── Why a route of its own ─────────────────────────────────────────────
//
// Nothing answered those three. GET /api/apps is per viewer and its length is
// what THIS viewer can see; the admin dashboard's counters are admin-only and
// counted for a different question. And the pane has to work for a viewer
// who is NOT served the platform's own `apps` row: with SELF_APP_PUBLIC_VOTING
// off a non-admin gets a 404 for it (routes/apps.js), yet the platform they
// are standing in still has a name, a tagline, a source repository and a
// running version. So the identity rides here too, read off the self-hosted
// row server-side. Every field is already public elsewhere: the name and the
// tagline are dapp.json's (the landing page says the same), the repository
// and the running SHA are what GET /api/version publishes unauthenticated.
//
// ── What is counted ────────────────────────────────────────────────────
//
// Only what is out in the open, so no figure discloses anything a directory
// listing would not:
//
//   apps     every app anyone can view — view-public, not the platform's own
//            row. A view-private app is absent from GET /api/apps for
//            outsiders, and a total that included them would count what it
//            may not name.
//   members  accounts with platform access, the people the platform's own
//            surfaces admit (has_platform_access), minus the synthetic demo
//            partners routes/demo-mode.js creates, which cannot sign in.
//   merged   merged proposals — a `chat_sessions` row in status `merged`, the
//            definition services/contributors.js and the gallery use — on
//            those same public apps plus the platform itself, which is built
//            by the same votes.
//
// ── Whether THIS viewer is served the platform's row ───────────────────
//
// `served` answers the one question the client's menu cannot ask without a
// failed request: is GET /api/apps/<selfAppSlug> going to answer this viewer,
// or 404? It is the same two-flag rule routes/apps.js applies (an admin, or
// SELF_APP_PUBLIC_VOTING on), computed here rather than discovered by probing
// the row — a probe that 404s is a red "Failed to load resource" line in the
// console of every viewer the flag hides the row from, on every cold load of
// a platform tab (frontend/src/features/app-context/platform-target.js). The
// slug rides with it because the answer is useless without it; GET
// /api/version publishes the same slug to anyone.
//
// ── Cached, because the rest is the same answer for everyone ───────────
//
// Nothing else in the payload depends on who asks, so one in-process copy
// serves every viewer for a minute, and the two per-viewer fields are added
// to it per request. The menu opens About on a tap; three COUNTs over the
// whole platform on every tap would be cost for a number that moves a few
// times a day.
//
// ── Staging ────────────────────────────────────────────────────────────
//
// `chat_sessions` is `staging:private`, so a prod-cloned staging database has
// merged nothing and the third card would read 0 in every preview. Under
// IS_STAGING && ?demo=1 an empty count is replaced with a fixed demo figure,
// the request-time injection the platform's other demo reads use. Real counts
// win, and it is a strict no-op in production.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

const CACHE_TTL_MS = 60 * 1000;

// The demo figure for `merged` on a staging preview whose clone has none.
const DEMO_MERGED = 212;

// One round trip. The three counts are scalar subqueries; the identity is the
// self-hosted row, LEFT JOINed so a database without one (a fresh local boot
// before seedSelfApp) still answers the counts.
const ABOUT_SQL = `
  SELECT
    (SELECT COUNT(*)::int FROM apps
      WHERE NOT self_hosted AND view_visibility = 'public') AS apps,
    (SELECT COUNT(*)::int FROM users
      WHERE has_platform_access AND NOT is_synthetic) AS members,
    (SELECT COUNT(*)::int FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.status = 'merged'
        AND (a.self_hosted OR a.view_visibility = 'public')) AS merged,
    s.name, s.repo_url, s.main_sha, s.last_deploy_at,
    s.manifest_snapshot->>'description' AS description
  FROM (SELECT 1) AS one
  LEFT JOIN apps s ON s.slug = $1 AND s.self_hosted
`;

const toCount = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The wire shape, from the query's one row. Pure, so tests can pin it with no
 * database.
 *
 * `version` prefers the SHA this process was built from (GIT_SHA — the same
 * value GET /api/version reports) over the row's `main_sha`: the row is only
 * refreshed at boot, and the build that is actually answering is the version
 * a reader is using. `tagline` is the manifest's one-line description, capped
 * like the launcher's cards cap it, because the snapshot is whatever the
 * repository last committed.
 */
function shapeAbout(row, { config = {}, gitSha = null } = {}) {
  const r = row || {};
  const sha = (gitSha && gitSha !== 'dev') ? gitSha : (r.main_sha || null);
  const tagline = typeof r.description === 'string'
    ? r.description.replace(/\s+/g, ' ').trim().slice(0, 160)
    : '';
  return {
    name: (typeof r.name === 'string' && r.name.trim()) || 'Homeroom',
    tagline: tagline || null,
    repoUrl: r.repo_url || config.platformRepoUrl || null,
    version: sha ? String(sha).slice(0, 7) : null,
    updatedAt: r.last_deploy_at ? new Date(r.last_deploy_at).toISOString() : null,
    stats: {
      apps: toCount(r.apps),
      members: toCount(r.members),
      merged: toCount(r.merged),
    },
  };
}

/** The staging demo overlay. Real counts win; see the header. */
function withDemoMerged(about) {
  if (about.stats.merged > 0) return about;
  return { ...about, stats: { ...about.stats, merged: DEMO_MERGED } };
}

function platformAboutRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  let cached = null; // { at, value }

  router.get('/api/platform/about', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    try {
      if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
        const { rows } = await pool.query(ABOUT_SQL, [config.selfAppSlug]);
        cached = {
          at: Date.now(),
          value: shapeAbout(rows[0], { config, gitSha: process.env.GIT_SHA || null }),
        };
      }
      const viewer = {
        selfAppSlug: config.selfAppSlug || null,
        served: !!req.user.isAdmin || !!config.selfAppPublicVoting,
      };
      const staging = process.env.USERNODE_ENV === 'staging';
      if (staging && req.query.demo === '1') {
        return res.json({ ...withDemoMerged(cached.value), ...viewer, demo: true });
      }
      return res.json({ ...cached.value, ...viewer });
    } catch (err) {
      log.error('platform-about', 'Failed to read the platform facts', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  platformAboutRoutes, shapeAbout, withDemoMerged, ABOUT_SQL, CACHE_TTL_MS, DEMO_MERGED,
};

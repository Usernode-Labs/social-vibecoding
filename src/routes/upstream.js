'use strict';

// A version's updates from its original, the doors to them
// (services/upstream-offers.js, docs/plans/versions.md "API shapes"):
//
//   GET  /api/apps/:slug/upstream         the hub card's and the menu's read
//   POST /api/apps/:slug/upstream/open    bring the update in now
//   POST /api/apps/:slug/upstream/skip    Skip this update
//   POST /api/apps/:slug/upstream/fit     Ask Homeroom bot to fit it
//   POST /api/apps/:slug/upstream/share   a private version shares its
//                                         change titles with its original
//
// `:slug` is the VERSION's. Reading takes view access, as every app read
// does (404 otherwise). Acting takes membership of the version's community
// (communities.requireAppMembership, which answers `join_required` for the
// client's fetch wrapper to turn into Join and a retry); share is for its
// managers (app-admins.canManageApp). The three that reach the git host are
// drain-guarded, answer only the Homeroom page itself (they write into the
// version's repository with the platform's credentials) and share the
// per-user lookup budget, as routes/suggest-back.js does.
//
// open and skip answer the GET's body; fit answers { ok, requestNumber,
// href, asked, message }. A refusal is { error, code } with its status.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const communities = require('../services/communities');
const offers = require('../services/upstream-offers');
const { drainGuard } = require('../services/lifecycle');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { githubLookupLimiter } = require('../middleware/rate-limits');

const READY_STATES = new Set(['open', 'needs_fit']);

function upstreamRoutes(config, { pool = getPool(config), deps } = {}) {
  const router = Router();
  const requireAppMembership = communities.requireAppMembership(pool);
  const withDeps = deps ? { deps } : {};

  // The version, as the caller may see it: 404 for a slug that does not
  // resolve or that they cannot view.
  async function loadVersion(req, res) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
    const app = rows[0] || null;
    if (!app || !(await appAccess.checkAppAccess(pool, app, req.user, 'view'))) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    return app;
  }

  async function body(req, app) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [app.id]);
    return offers.view({ config, pool, app: rows[0] || app, user: req.user, ...withDeps });
  }

  const fail = (what) => (err, req, res) => {
    log.error('upstream', `${what} failed`, { slug: req.params.slug, message: err.message });
    res.status(500).json({ error: 'Internal server error' });
  };

  router.get('/api/apps/:slug/upstream', async (req, res) => {
    try {
      const app = await loadVersion(req, res);
      if (!app) return;
      res.json(await offers.view({ config, pool, app, user: req.user, ...withDeps }));
    } catch (err) {
      fail('Read')(err, req, res);
    }
  });

  // Opened now: for a dormant version the clock left waiting, or one that
  // does not get its updates on its own (the hub's one-time card). An update
  // already up, or waiting to be fitted, is answered as it stands.
  router.post(
    '/api/apps/:slug/upstream/open',
    drainGuard, githubLookupLimiter, sameOriginBrowserOnly, requireAppMembership,
    async (req, res) => {
      try {
        const app = await loadVersion(req, res);
        if (!app) return;
        const current = await offers.view({ config, pool, app, user: req.user, ...withDeps });
        if (current.offer && READY_STATES.has(current.offer.state)) return res.json(current);
        const result = await offers.openUpdate({ config, pool, versionId: app.id, ...withDeps });
        if (!result.ok) return res.status(result.status).json(result.body);
        res.json(await body(req, app));
      } catch (err) {
        fail('Open')(err, req, res);
      }
    },
  );

  router.post(
    '/api/apps/:slug/upstream/skip',
    drainGuard, githubLookupLimiter, sameOriginBrowserOnly, requireAppMembership,
    async (req, res) => {
      try {
        const app = await loadVersion(req, res);
        if (!app) return;
        const result = await offers.skipUpdate({ config, pool, versionId: app.id, user: req.user, ...withDeps });
        if (!result.ok) return res.status(result.status).json(result.body);
        res.json(await body(req, app));
      } catch (err) {
        fail('Skip')(err, req, res);
      }
    },
  );

  router.post(
    '/api/apps/:slug/upstream/fit',
    drainGuard, githubLookupLimiter, sameOriginBrowserOnly, requireAppMembership,
    async (req, res) => {
      try {
        const app = await loadVersion(req, res);
        if (!app) return;
        const result = await offers.fitUpdate({ config, pool, versionId: app.id, user: req.user, ...withDeps });
        if (!result.ok) return res.status(result.status).json(result.body);
        res.json(result);
      } catch (err) {
        fail('Fit')(err, req, res);
      }
    },
  );

  router.post('/api/apps/:slug/upstream/share', sameOriginBrowserOnly, async (req, res) => {
    try {
      const app = await loadVersion(req, res);
      if (!app) return;
      const share = req.body && req.body.share;
      if (share !== true && share !== false) {
        return res.status(400).json({ error: 'Provide share: true or false.', code: 'invalid' });
      }
      const view = await offers.view({ config, pool, app, user: req.user, ...withDeps });
      if (!view.canManage) {
        return res.status(403).json({ error: 'Only the people who manage this project can change this.', code: 'not_manager' });
      }
      if (!require('../services/upstream-lineage').readUpstream(app)) {
        return res.status(409).json({ error: offers.MESSAGES.notAVersion, code: 'not_a_version' });
      }
      await offers.setShare({ pool, app, share });
      res.json(await body(req, app));
    } catch (err) {
      fail('Share')(err, req, res);
    }
  });

  return router;
}

module.exports = { upstreamRoutes };

'use strict';

// Featured apps, for a full platform admin's connector session: the featured
// tools in services/mcp-tools.js (list_featured_apps, set_featured_apps,
// set_discover_flag). They manage what Admin > Featured apps manages: the
// ordered list the signed-out landing's Featured and every user's "Find more
// apps" row read, and the flag that takes an app out of Discover and
// Featured.
//
// They live at their own prefix because a connector token can never reach
// /api/admin, where the console's routes are (services/cli-api-policy.js),
// the same reason /api/challenge-admin/* does. What earns them a place on
// the connector allowlist is the gate every route puts first, which
// tests/mcp-connector-policy.test.js pins: requireAdminWrite (a full admin,
// never a view-only one), the read included; then, on every write, the
// per-admin limiter and the same-origin browser guard.
//
// Each door is the console's own route, not a copy of it. After its gates it
// hands the request to the same handler the console calls
// (routes/admin-featured-apps.js), at the same path under /api/admin, so a
// connector session and the console validate, write and answer alike. Only
// the three routes listed here are handed on.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { requireAdminWrite } = require('../middleware/admin');
const { featuredAdminLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const log = require('../services/logger');
const { featuredAppsAdminRoutes } = require('./admin-featured-apps');

const PREFIX_RE = /^\/api\/featured-admin\//i;
const CONSOLE_PREFIX = '/api/admin/';

function featuredAdminRoutes(config) {
  const router = Router();
  const consoleRoutes = featuredAppsAdminRoutes(getPool(config));

  // The request goes on at the console's path. It is answered there or here,
  // never by a later router: with its address rewritten, a later one could
  // read it as a request for /api/admin.
  const toConsole = (req, res) => {
    req.url = req.url.replace(PREFIX_RE, CONSOLE_PREFIX);
    consoleRoutes(req, res, (err) => {
      if (res.headersSent) return;
      if (err) {
        log.error('featured-admin', 'Console route failed', { method: req.method, message: err.message });
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      res.status(404).json({ error: 'Not found' });
    });
  };

  // Read: the list in its order, and every other app, each with where it
  // stands in Discover and whether it is flagged.
  router.get('/api/featured-admin/featured-apps', requireAdminWrite, toConsole);

  // Writes: the whole list in its new order, and one app's flag.
  router.put('/api/featured-admin/featured-apps', requireAdminWrite, featuredAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.put('/api/featured-admin/apps/:slug/discover-flag', requireAdminWrite, featuredAdminLimiter, sameOriginBrowserOnly, toConsole);

  return router;
}

module.exports = { featuredAdminRoutes };

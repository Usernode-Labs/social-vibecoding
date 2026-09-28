'use strict';

/**
 * GET /api/apps/:slug/notices — a project's notices for its Workshop tab:
 * settings changed lately and this week's card (services/app-notices.js).
 *
 * Read with view access, as the project's chat history is: anyone who can
 * see the project may read what changed about it. A project the viewer
 * cannot see answers 404, so a private one is not disclosed.
 */

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const notices = require('../services/app-notices');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function appNoticesRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/notices', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const found = await notices.forApp(pool, app.id);
      if (IS_STAGING && req.query.demo === '1') return res.json(notices.withDemoNotices(found));
      return res.json(found);
    } catch (err) {
      log.error('app-notices', 'Failed to read notices', { slug: req.params.slug, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { appNoticesRoutes };

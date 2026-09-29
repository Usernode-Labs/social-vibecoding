'use strict';

// GET /api/apps/:slug/since-summary?since=<ms>
//
// The hub's since-your-last-visit line for a viewer whose last visit was at
// `since` (milliseconds; the hub keeps it per device). Read access is the
// app's own view rule: the line is written only from merged changes, which
// every viewer of the app may see. See services/since-summary.js for the
// windows, the cache and when the model runs.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const sinceSummary = require('../services/since-summary');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Staging's database starts without this project's merges or a model key,
// so `?demo=1` answers with a fixed line for the testing steps to reach.
function stagingDemoSummary(now = Date.now()) {
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    state: 'ai',
    windowStart: Math.floor((now - dayMs) / dayMs) * dayMs,
    headAt: now - 10 * 60 * 1000,
    count: 34,
    text: 'Staging demo: mostly polish on Messages and Discover, and approvals now need one yes vote instead of two.',
  };
}

function sinceSummaryRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/since-summary', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, name`);
      if (!app) return res.status(404).json({ error: 'App not found' });
      res.set('Cache-Control', 'private, no-store');
      if (IS_STAGING && req.query.demo === '1') return res.json(stagingDemoSummary());
      const since = Number(req.query.since);
      return res.json(await sinceSummary.getSummary(pool, app, { since }));
    } catch (err) {
      log.error('since-summary', 'Failed to build the since summary', { slug: req.params.slug, message: err.message });
      return res.status(500).json({ error: 'Failed to load the summary' });
    }
  });

  return router;
}

module.exports = { sinceSummaryRoutes, stagingDemoSummary };

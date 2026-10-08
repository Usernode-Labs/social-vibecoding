'use strict';

// GET /api/apps/:slug/run-estimate
//
// The change page's run bar estimate ("About 4 minutes left"): the medians
// of this app's recent build, checks and shots durations
// (services/run-estimate.js). A read, written only from finished runs, so
// view access is enough — no membership gate, like the since-summary line.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const runEstimate = require('../services/run-estimate');
const log = require('../services/logger');

function runEstimateRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/run-estimate', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      // The medians move slowly: one finished run at most moves them a
      // little, so the client's cache and this header agree on a while.
      res.set('Cache-Control', 'private, max-age=300');
      return res.json(await runEstimate.getEstimate(pool, app.id));
    } catch (err) {
      log.error('run-estimate', 'Failed to build the run estimate', { slug: req.params.slug, message: err.message });
      return res.status(500).json({ error: 'Failed to load the run estimate' });
    }
  });

  return router;
}

module.exports = { runEstimateRoutes };

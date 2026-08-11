const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const reportAi = require('../services/report-ai');
const { reportAiLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// AI progress report (Reporting tab). GET serves the shared per-app
// cache plus a staleness flag; POST regenerates it (debited to the
// clicking user). Access level is 'view' on both: the input is built
// from data every viewer can already see, generation costs land on the
// generator's own budget, and the deny is a 404 like every app route.

// What leaves the server: never input_hash (an internal cache key) and
// never generated_by (the summary is a shared document, not a post).
function publicShape(summary) {
  if (!summary) return null;
  return {
    narrative: summary.narrative,
    highlights: summary.highlights,
    risks: summary.risks,
    owners: summary.owners,
    model: summary.model,
    generatedAt: summary.generatedAt,
  };
}

function reportAiRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const APP_COLS = `${appAccess.ACCESS_COLUMNS}, name, repo_url`;

  router.get('/api/apps/:slug/report-ai', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const cached = await reportAi.getCached(pool, app.id);
      if (!cached) return res.json({ summary: null, stale: false });
      let stale = false;
      try {
        const { input } = await reportAi.buildReportInput(pool, app);
        stale = reportAi.fingerprint(input) !== cached.inputHash;
      } catch (err) {
        // Staleness is a hint; a fetch hiccup must not hide the summary.
        log.warn('report-ai', 'staleness check failed', { app: app.slug, message: err.message });
      }
      res.json({ summary: publicShape(cached), stale });
    } catch (err) {
      log.error('report-ai', 'GET failed', { message: err.message });
      res.status(500).json({ error: 'Failed to load report summary' });
    }
  });

  router.post('/api/apps/:slug/report-ai/generate', reportAiLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const { summary, cached } = await reportAi.generateForApp({
        pool, config, app, userId: req.user.id,
      });
      res.json({ summary: publicShape(summary), cached });
    } catch (err) {
      if (err.code === 'generation_in_flight') return res.status(409).json({ error: err.message });
      if (err.code === 'budget_exceeded') return res.status(429).json({ error: err.message, code: 'budget_exceeded' });
      if (err.code === 'llm_unavailable') return res.status(503).json({ error: err.message });
      log.error('report-ai', 'generate failed', { message: err.message });
      res.status(500).json({ error: 'Failed to generate the report summary' });
    }
  });

  return router;
}

module.exports = { reportAiRoutes };

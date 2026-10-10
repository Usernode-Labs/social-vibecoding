'use strict';

const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { uiTelemetryLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const telemetry = require('../services/ui-telemetry');
const languageSync = require('../services/language-sync-runner');
const log = require('../services/logger');

function uiTelemetryRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  const json = express.json({ limit: `${telemetry.MAX_BODY_BYTES}b`, strict: true });

  router.post('/api/ui-telemetry/batch', uiTelemetryLimiter, sameOriginBrowserOnly, json, async (req, res) => {
    // Capture and paired-shots sessions are real authenticated users so they
    // can exercise protected UI, but their scripted traffic is not product
    // experience data. Answer successfully so old clients drop their queue.
    // …and so are people who objected to being recorded (#3369), dropped here
    // as well as told not to send.
    if (!(await telemetry.isRecordable(pool, req.user))) {
      return res.status(202).json({ ok: true, accepted: 0, submitted: 0, discarded: true });
    }
    let batch;
    try {
      batch = telemetry.parseBatch(req.body);
    } catch (err) {
      if (err instanceof telemetry.TelemetryValidationError) {
        return res.status(400).json({ error: 'invalid_telemetry', message: err.message });
      }
      log.error('ui-telemetry', 'Batch validation failed unexpectedly', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    try {
      const result = await telemetry.insertBatch(pool, req.user.id, batch, {
        language: telemetry.browserLanguage(req.get('accept-language')),
      });
      return res.status(result.duplicate ? 200 : 202).json({
        ok: true,
        accepted: result.accepted,
        submitted: batch.events.length,
      });
    } catch (err) {
      log.error('ui-telemetry', 'Batch insert failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Which languages people's browsers ask for, for choosing the languages
  // Homeroom ships (#3659). Read here until it has a place in the console.
  router.get('/api/admin/analytics/browser-languages', adminMiddleware, async (req, res) => {
    try {
      res.json(await telemetry.browserLanguages(pool, {
        days: telemetry.daysWindow(req.query.days),
        includeAdmins: req.query.includeAdmins === 'true',
      }));
    } catch (err) {
      log.error('ui-telemetry', 'Browser language count failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The same count for a full admin's connector (get_browser_languages),
  // outside /api/admin, which a connector token cannot reach
  // (services/cli-api-policy.js), with where Homeroom's translation step
  // stands (services/language-sync-runner.js). It changes nothing.
  router.get('/api/browser-languages', requireAdminWrite, sameOriginBrowserOnly, async (req, res) => {
    try {
      const counts = await telemetry.browserLanguages(pool, {
        days: telemetry.daysWindow(req.query.days),
        includeAdmins: req.query.includeAdmins === 'true',
      });
      res.json({ ...counts, translation: await languageSync.status(pool) });
    } catch (err) {
      log.error('ui-telemetry', 'Browser language count failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/analytics/ui-failures', adminMiddleware, async (req, res) => {
    try {
      const data = await telemetry.aggregate(pool, {
        days: telemetry.daysWindow(req.query.days),
        includeAdmins: req.query.includeAdmins === 'true',
      });
      res.json(data);
    } catch (err) {
      log.error('ui-telemetry', 'Admin aggregate failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large' && req.path === '/api/ui-telemetry/batch') {
      return res.status(413).json({ error: 'telemetry_too_large' });
    }
    return next(err);
  });

  return router;
}

module.exports = { uiTelemetryRoutes };

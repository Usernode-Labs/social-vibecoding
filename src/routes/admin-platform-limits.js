'use strict';

// The admin limits area at the top of Notifications
// (frontend/src/features/notifications/platform-limits.tsx): what it reads,
// and its "Check again". Both are for FULL admins only: the figures say how
// close the platform is to refusing people, and the check runs the sweeps.
// Mounted inside routes/admin.js, behind its router-level adminMiddleware;
// requireAdminWrite then turns view-only admins away too.

const { Router } = require('express');
const { requireAdminWrite } = require('../middleware/admin');
const { platformLimitsCheckLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');
const view = require('../services/platform-limits-view');

function adminPlatformLimitsRoutes(pool, config) {
  const router = Router();

  router.get('/api/admin/platform-limits', requireAdminWrite, async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await view.read(pool, config));
    } catch (err) {
      log.error('admin', 'Read platform limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/platform-limits/check', requireAdminWrite, platformLimitsCheckLimiter, async (req, res) => {
    try {
      const payload = await view.refresh(pool, config);
      log.info('admin', 'Platform limits checked again', { by: req.user.username, rows: payload.rows.length });
      res.set('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err) {
      log.error('admin', 'Check platform limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { adminPlatformLimitsRoutes };

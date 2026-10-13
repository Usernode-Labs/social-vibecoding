'use strict';

// Read-only admin queues over the legacy app_reports and
// chat_message_reports tables. New reports for mini-apps and their Workshop
// posts, and every admin decision on them, go through routes/moderation.js,
// which is registered first and owns those paths.
const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const log = require('../services/logger');

const STATUSES = new Set(['pending', 'resolved', 'dismissed']);
const NO_STORE = 'private, no-store, max-age=0';

function contentReportRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/admin/app-reports', adminMiddleware, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const status = STATUSES.has(req.query.status) ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.app_id, r.app_slug_snapshot, r.app_name_snapshot,
                r.reason, r.detail, r.status, r.created_at, r.resolved_at,
                reporter.username AS reporter_username,
                resolver.username AS resolved_by_username
           FROM app_reports r
           LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
           LEFT JOIN users resolver ON resolver.id = r.resolved_by
          WHERE r.status = $1 ORDER BY r.created_at ASC, r.id ASC LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('reports', 'App report queue failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/app-message-reports', adminMiddleware, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const status = STATUSES.has(req.query.status) ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.app_id, r.message_id, r.app_slug_snapshot,
                r.reason, r.detail, r.content_snapshot, r.evidence_snapshot,
                r.status, r.created_at, r.resolved_at,
                reporter.username AS reporter_username,
                reported.username AS reported_username,
                resolver.username AS resolved_by_username
           FROM chat_message_reports r
           LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
           LEFT JOIN users reported ON reported.id = r.reported_user_id
           LEFT JOIN users resolver ON resolver.id = r.resolved_by
          WHERE r.status = $1 ORDER BY r.created_at ASC, r.id ASC LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('reports', 'App message report queue failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { contentReportRoutes };

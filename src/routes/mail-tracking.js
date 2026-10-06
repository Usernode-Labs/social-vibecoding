'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const tracking = require('../services/mail/tracking');
const events = require('../services/mail/events');
const log = require('../services/logger');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function mailTrackingRoutes(config) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  router.use(['/mail/c', '/mail/o'], (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.get('/mail/c/:messageId/:linkIndex', limiter, async (req, res) => {
    const { messageId, linkIndex } = req.params;
    if (!/^(0|[1-9]\d{0,3})$/.test(linkIndex) || !tracking.matches(`click:${linkIndex}`, messageId, req.query.s)) {
      return res.status(404).send('This email link is not available.');
    }
    try {
      const pool = getPool(config);
      const { rows } = await pool.query(
        'SELECT id, kind, tracking_links, engagement_tracked FROM mail_deliveries WHERE message_id = $1', [messageId]
      );
      const row = rows[0];
      const url = row && row.engagement_tracked && events.isTracked(row.kind) && tracking.destination(row.tracking_links?.[Number(linkIndex)]);
      if (!url) return res.status(404).send('This email link is not available.');
      try {
        await pool.query(
          `INSERT INTO mail_events (delivery_id, type, url, user_agent_class)
           VALUES ($1, 'clicked', $2, $3)`, [row.id, url, tracking.classify(req.headers['user-agent'])]
        );
      } catch (err) { log.warn('platform-mail', 'Click event could not be recorded', { message: err.message }); }
      return res.redirect(302, url);
    } catch (err) {
      log.warn('platform-mail', 'Click destination could not be resolved', { message: err.message });
      return res.status(503).send('This email link is temporarily unavailable.');
    }
  });
  router.get('/mail/o/:messageId.gif', limiter, async (req, res) => {
    const { messageId } = req.params;
    if (tracking.matches('open', messageId, req.query.s)) {
      try {
        await getPool(config).query(
          `INSERT INTO mail_events (delivery_id, type, user_agent_class, meta)
           SELECT id, 'opened', $2, jsonb_build_object('approximate', true, 'proxyOrPrefetch', $3::boolean)
             FROM mail_deliveries WHERE message_id = $1 AND engagement_tracked AND kind = ANY($4::text[])`,
          [messageId, tracking.classify(req.headers['user-agent']),
            /proxy|prefetch/.test(tracking.classify(req.headers['user-agent'])), events.trackedKinds()]
        );
      } catch (err) { log.warn('platform-mail', 'Open event could not be recorded', { message: err.message }); }
    }
    // Always the same image, including an expired or invalid identity.
    return res.type('gif').send(GIF);
  });
  return router;
}
module.exports = { mailTrackingRoutes };

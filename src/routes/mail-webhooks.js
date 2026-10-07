'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const events = require('../services/mail/events');
const log = require('../services/logger');

function mailWebhookRoutes(config) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
  // Mount before the global JSON parser and authentication. No cookie or
  // session authorizes this route: only the configured provider signature.
  router.post('/api/mail/webhooks/resend', limiter, express.raw({ type: 'application/json', limit: '128kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!events.verifyResend(req.body, req.headers, process.env.PLATFORM_MAIL_RESEND_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Invalid webhook payload' }); }
    try {
      const result = await events.ingestResend(getPool(config), event, req.headers['svix-id']);
      if (result === 'invalid') return res.status(400).json({ error: 'Invalid webhook event' });
      if (result === 'pending') return res.status(503).json({ error: 'Delivery receipt not available yet' });
      return res.json({ ok: true });
    } catch (err) {
      log.error('platform-mail', 'Mail webhook bookkeeping failed', { message: err.message });
      return res.status(503).json({ error: 'Webhook temporarily unavailable' });
    }
  });
  return router;
}

module.exports = { mailWebhookRoutes };

'use strict';

// The admin limits area at the top of Notifications
// (frontend/src/features/notifications/platform-limits.tsx): what it reads,
// and its "Check again". And the text alerts for the same limits (Admin ›
// Limits, "Text alerts"; services/limit-texts.js): the numbers texted, adding
// one (texted a code, active once the code is entered), a test text and
// removing one.
//
// All of it is for FULL admins only: the figures say how close the platform
// is to refusing people, the check runs the sweeps, and the numbers are
// people's phone numbers. Mounted inside routes/admin.js, behind its
// router-level adminMiddleware; requireAdminWrite then turns view-only
// admins away too.

const { Router } = require('express');
const { requireAdminWrite } = require('../middleware/admin');
const { platformLimitsCheckLimiter, limitTextSendLimiter, limitTextVerifyLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');
const view = require('../services/platform-limits-view');
const limitTexts = require('../services/limit-texts');
const { SmsError } = require('../services/sms/errors');

function phoneId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

/** A refusal the card can show as it is; anything else is a 500. */
function refuse(res, err, what) {
  if (err instanceof limitTexts.LimitTextError || err instanceof SmsError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  log.error('admin', `${what} failed`, { message: err.message });
  return res.status(500).json({ error: 'Internal server error' });
}

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

  // ── Text alerts ──────────────────────────────────────────────

  router.get('/api/admin/limit-texts', requireAdminWrite, async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await limitTexts.list(pool, config));
    } catch (err) {
      refuse(res, err, 'Read text alerts');
    }
  });

  router.post('/api/admin/limit-texts', requireAdminWrite, limitTextSendLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const phone = await limitTexts.addPhone(pool, config, {
        phoneNumber: body.phoneNumber, label: body.label, userId: req.user.id,
      });
      res.status(201).json({ phone });
    } catch (err) {
      refuse(res, err, 'Add a text alert number');
    }
  });

  router.post('/api/admin/limit-texts/:id/verify', requireAdminWrite, limitTextVerifyLimiter, async (req, res) => {
    const id = phoneId(req);
    if (!id) return res.status(404).json({ error: 'That number is not on the list.', code: 'not_found' });
    try {
      res.json({ phone: await limitTexts.verifyPhone(pool, { id, code: (req.body || {}).code }) });
    } catch (err) {
      refuse(res, err, 'Confirm a text alert number');
    }
  });

  router.post('/api/admin/limit-texts/:id/resend', requireAdminWrite, limitTextSendLimiter, async (req, res) => {
    const id = phoneId(req);
    if (!id) return res.status(404).json({ error: 'That number is not on the list.', code: 'not_found' });
    try {
      res.json({ phone: await limitTexts.resendCode(pool, config, { id }) });
    } catch (err) {
      refuse(res, err, 'Resend a text alert code');
    }
  });

  router.post('/api/admin/limit-texts/:id/test', requireAdminWrite, limitTextSendLimiter, async (req, res) => {
    const id = phoneId(req);
    if (!id) return res.status(404).json({ error: 'That number is not on the list.', code: 'not_found' });
    try {
      res.json({ phone: await limitTexts.testPhone(pool, config, { id }) });
    } catch (err) {
      refuse(res, err, 'Send a text alert test');
    }
  });

  router.delete('/api/admin/limit-texts/:id', requireAdminWrite, async (req, res) => {
    const id = phoneId(req);
    if (!id) return res.status(404).json({ error: 'That number is not on the list.', code: 'not_found' });
    try {
      res.json(await limitTexts.removePhone(pool, { id }));
    } catch (err) {
      refuse(res, err, 'Remove a text alert number');
    }
  });

  return router;
}

module.exports = { adminPlatformLimitsRoutes };

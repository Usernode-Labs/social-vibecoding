// Topochain v4 admin API: translations of text admins write (#6152).
// src/services/admin-text-translations.js holds the rules. Writes are gated by
// `adminWriteGate`; reads by the router-wide `adminReadGate` in ../admin.js.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const translations = require('../../../services/admin-text-translations');
const { adminWriteGate } = require('./auth');
const { ok, fail } = require('../helpers');

function textTranslationsAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/v4/admin/text-translations', async (_req, res) => {
    try {
      return ok(res, { data: await translations.overview(pool) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/text-translations failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  const action = (name, run) => async (req, res) => {
    try {
      const body = req.body || {};
      const out = await run({
        key: body.key, language: body.language, text: body.text, userId: req.user?.id,
      });
      if (out.error) return fail(res, 422, out.error);
      return ok(res, {});
    } catch (err) {
      log.error('topochain-admin', `POST /admin/text-translations/${name} failed`, { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  };

  router.post('/api/v4/admin/text-translations/correct', adminWriteGate,
    action('correct', (input) => translations.correct(pool, input)));
  router.post('/api/v4/admin/text-translations/approve', adminWriteGate,
    action('approve', (input) => translations.approve(pool, input)));
  router.post('/api/v4/admin/text-translations/retranslate', adminWriteGate,
    action('retranslate', (input) => translations.retranslate(pool, input)));

  return router;
}

module.exports = { textTranslationsAdminRoutes };

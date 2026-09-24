'use strict';
const { Router } = require('express');
const { getPool } = require('../db/pool');
const blocks = require('../services/app-blocks');
const { conversationSafetyLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

function appBlockRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  router.use('/api/me/app-blocks', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in to manage blocked apps' });
    next();
  });
  const run = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      if (!err.status) log.error('app-blocks', 'Request failed', { message: err.message });
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not update blocked apps. Try again.' });
    }
  };
  router.get('/api/me/app-blocks', run(async (req, res) => {
    res.json({ apps: await blocks.list(pool, req.user.id) });
  }));
  const update = blocked => run(async (req, res) => {
    const result = await blocks.setBlocked(pool, req.user, req.params.slug, blocked);
    const ws = require('../services/ws');
    ws.pushToUser(req.user.id, { type: 'app_blocks_changed', ...result });
    ws.pushToUser(req.user.id, { type: 'notifications_changed' });
    res.json({ ok: true, ...result });
  });
  router.put('/api/me/app-blocks/:slug', conversationSafetyLimiter, update(true));
  router.delete('/api/me/app-blocks/:slug', conversationSafetyLimiter, update(false));
  return router;
}
module.exports = { appBlockRoutes };

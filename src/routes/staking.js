'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { createStakingObservability } = require('../services/staking-observability');
const preview = require('../services/staking-preview');

function stakingRoutes(config, { service = createStakingObservability(config) } = {}) {
  const router = Router();
  const isPreview = (req) => process.env.USERNODE_ENV === 'staging' && req.query.demo === 'staking';
  router.use('/api/me/staking', (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    res.set('Cache-Control', 'private, no-store');
    next();
  }, rateLimit({ windowMs: 60000, limit: 90, keyGenerator: (req) => String(req.user.id),
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Please wait a moment before refreshing epoch data.' } }));
  router.get('/api/me/staking/demo', (req, res) => {
    if (process.env.USERNODE_ENV !== 'staging') return res.sendStatus(404);
    res.json({ address: preview.WALLET,
      staking: req.query.state === 'delegated'
        ? { kind: 'delegated', delegate: 'Preview delegate', since: '' } : { kind: 'local' } });
  });
  router.get('/api/me/staking/context', async (req, res) => {
    if (isPreview(req)) return res.json({ chainId: preview.CHAIN });
    try { res.json(await service.context()); }
    catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });
  router.get('/api/me/staking/epochs', async (req, res) => {
    if (isPreview(req)) {
      const data = preview.previewEpoch(req.query.epoch);
      return data ? res.json(data) : res.status(400).json({ error: 'Invalid epoch' });
    }
    try { res.json(await service.epochs(req.query)); }
    catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });
  return router;
}

module.exports = { stakingRoutes };

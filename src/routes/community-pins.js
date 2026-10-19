'use strict';
const { Router } = require('express');
const { getPool } = require('../db/pool');
const pins = require('../services/community-pins');
const log = require('../services/logger');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

// The communities the signed-in person pinned to the desktop sidebar
// (services/community-pins.js). Each answer is the pins as they now stand.
function communityPinRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  router.use('/api/me/community-pins', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in to pin communities' });
    next();
  });
  const run = (fn) => async (req, res) => {
    try {
      res.json({ pins: await fn(req) });
    } catch (err) {
      if (err.status) return res.status(err.status).json(err.body || { error: err.message });
      log.error('community-pins', 'Request failed', { message: err.message });
      res.status(500).json({ error: 'Could not update your pins. Try again.' });
    }
  };
  router.get('/api/me/community-pins', run((req) => pins.list(pool, req.user.id)));
  // The pins a device kept before they were the account's, sent once.
  router.post('/api/me/community-pins/import', sameOriginBrowserOnly,
    run((req) => pins.importPins(pool, req.user, req.body?.slugs)));
  router.put('/api/me/community-pins/:slug', sameOriginBrowserOnly,
    run((req) => pins.pin(pool, req.user, req.params.slug)));
  router.delete('/api/me/community-pins/:slug', sameOriginBrowserOnly,
    run((req) => pins.unpin(pool, req.user, req.params.slug)));
  return router;
}
module.exports = { communityPinRoutes };

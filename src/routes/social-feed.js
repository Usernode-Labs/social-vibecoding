'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const socialFeed = require('../services/social-feed');

function socialFeedRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // The home widget has its own client TTL, but the standalone paginated
  // endpoint is still cheap to script. A per-account read ceiling prevents
  // one signed-in client from repeatedly running the three-arm UNION.
  const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    handler: (_req, res) => res.status(429).json({ error: 'Too many feed requests' }),
  });

  const requireViewer = (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  router.get('/api/social-feed', requireViewer, readLimiter, async (req, res) => {
    const cursor = req.query.before == null
      ? null : socialFeed.decodeCursor(req.query.before);
    if (req.query.before != null && !cursor) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    try {
      const page = await socialFeed.listSocialFeed(pool, {
        limit: req.query.limit,
        cursor,
      });
      return res.json(page);
    } catch (err) {
      log.error('social-feed', 'list failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { socialFeedRoutes };

'use strict';

// Home's "For you" column (#6650, services/home-for-you.js): what happened
// in your communities since you last looked, Mark all read, and your work.
const { Router } = require('express');
const { getPool } = require('../db/pool');
const forYou = require('../services/home-for-you');
const log = require('../services/logger');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function homeForYouRoutes(config, { pool = getPool(config), staging = IS_STAGING } = {}) {
  const router = Router();
  const signedIn = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in to see what is new for you' });
    next();
  };
  const demo = (req) => staging && req.query.demo === '1';

  router.get('/api/me/home-activity', signedIn, async (req, res) => {
    try {
      const body = await forYou.activity(pool, req.user.id);
      res.json(demo(req) ? forYou.withDemoActivity(body) : body);
    } catch (err) {
      log.error('home-for-you', 'Activity read failed', { message: err.message });
      res.status(500).json({ error: 'Could not load what is new. Try again.' });
    }
  });

  router.post('/api/me/home-activity/seen', signedIn, sameOriginBrowserOnly, async (req, res) => {
    try {
      res.json(await forYou.markSeen(pool, req.user.id));
    } catch (err) {
      log.error('home-for-you', 'Mark read failed', { message: err.message });
      res.status(500).json({ error: 'Could not mark these as read. Try again.' });
    }
  });

  router.get('/api/me/home-work', signedIn, async (req, res) => {
    try {
      const body = await forYou.work(pool, req.user.id);
      res.json(demo(req) ? forYou.withDemoWork(body) : body);
    } catch (err) {
      log.error('home-for-you', 'Work read failed', { message: err.message });
      res.status(500).json({ error: 'Could not load your work. Try again.' });
    }
  });

  return router;
}

module.exports = { homeForYouRoutes };

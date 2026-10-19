'use strict';

// GET /api/apps/:slug/topics/:key/figures
//
// The figures a topic's channel shows above its room: the ids its
// dapp.json entry names, read by services/topic-figures.js, a split one
// with Homeroom beside the other projects. Read access is the app's own
// view rule, like the channel's; the figures are totals across the
// platform, so nothing in them is one person's.
//
// A topic with no figures, or a retired one, answers with an empty list,
// so the strip draws nothing.
//
// GET /api/apps/:slug/topics/:key/signals
//
// The topic's OPEN PROBLEMS, under its figures (topic-signals.tsx): what
// the platform found wrong on its own and filed as a request, read by
// services/platform-signals.js. The same read rule as the figures, so
// anyone who can read the channel sees what is wrong in it and who has it.
// Every word is the server's. Only a full admin (is_admin and not
// admin_readonly, `req.user.canAdminWrite`) is told which admin console
// section shows more: the console is theirs to act in, and a view-only
// admin cannot act there. A retired topic answers with none, so the
// section draws nothing.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const topicFigures = require('../services/topic-figures');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const TOPIC_FIGURES_SQL = `
  SELECT topic_state, topic_figures
    FROM app_category_registry
   WHERE app_id = $1 AND origin = 'topic' AND category_key = $2`;

function topicFiguresRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/topics/:key/figures', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const key = String(req.params.key || '').slice(0, 64);
      const { rows } = await pool.query(TOPIC_FIGURES_SQL, [app.id, key]);
      if (!rows[0]) return res.status(404).json({ error: 'Topic not found' });
      res.set('Cache-Control', 'private, no-store');
      const live = (rows[0].topic_state || 'live') === 'live';
      const ids = live ? topicFigures.knownFigureIds(rows[0].topic_figures) : [];
      if (!ids.length) return res.json({ topic: key, figures: [] });
      // Staging starts without the private tables the figures read, so
      // `?demo=1` there answers with fixed ones, marked as a demo.
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ topic: key, ...topicFigures.demoFiguresFor(ids) });
      }
      return res.json({ topic: key, ...(await topicFigures.figuresFor(pool, ids)) });
    } catch (err) {
      log.error('topic-figures', 'Failed to read a topic\'s figures', { slug: req.params.slug, key: req.params.key, message: err.message });
      return res.status(500).json({ error: 'Failed to load the figures' });
    }
  });

  router.get('/api/apps/:slug/topics/:key/signals', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const key = String(req.params.key || '').slice(0, 64);
      const { rows } = await pool.query(TOPIC_FIGURES_SQL, [app.id, key]);
      if (!rows[0]) return res.status(404).json({ error: 'Topic not found' });
      res.set('Cache-Control', 'private, no-store');
      if ((rows[0].topic_state || 'live') !== 'live') return res.json({ topic: key, signals: [] });
      // Required here rather than at the top: the figures above answer
      // whether or not the signals service loads.
      const platformSignals = require('../services/platform-signals');
      const fullAdmin = !!req.user?.canAdminWrite;
      const { signals } = await platformSignals.openForTopic(pool, { appId: app.id, topicKey: key, fullAdmin });
      const list = Array.isArray(signals) ? signals : [];
      // The service leaves the console's section out for anyone else; this
      // makes sure of it, so no viewer is sent a door they cannot use.
      return res.json({ topic: key, signals: fullAdmin ? list : list.map((s) => ({ ...s, adminSection: null })) });
    } catch (err) {
      log.error('topic-figures', 'Failed to read a topic\'s open problems', { slug: req.params.slug, key: req.params.key, message: err.message });
      return res.status(500).json({ error: 'Failed to load the open problems' });
    }
  });

  return router;
}

module.exports = { topicFiguresRoutes };

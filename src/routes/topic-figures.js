'use strict';

// GET /api/apps/:slug/topics/:key/figures?scope=all|homeroom|others
//
// The figures a topic's channel shows above its room: the ids its
// dapp.json entry names, read by services/topic-figures.js. Read access is
// the app's own view rule, like the channel's; the figures are totals
// across the platform, so nothing in them is one person's.
//
// A topic with no figures, or a retired one, answers with an empty list,
// so the strip draws nothing.

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
      const scope = topicFigures.normalizeScope(String(req.query.scope || ''));
      // Staging starts without the private tables the figures read, so
      // `?demo=1` there answers with fixed ones, marked as a demo.
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ topic: key, ...topicFigures.demoFiguresFor(ids, { scope }) });
      }
      return res.json({ topic: key, ...(await topicFigures.figuresFor(pool, ids, { scope })) });
    } catch (err) {
      log.error('topic-figures', 'Failed to read a topic\'s figures', { slug: req.params.slug, key: req.params.key, message: err.message });
      return res.status(500).json({ error: 'Failed to load the figures' });
    }
  });

  return router;
}

module.exports = { topicFiguresRoutes };

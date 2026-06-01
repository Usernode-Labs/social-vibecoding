const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const models = require('../services/models');

function chatRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Models the UI may offer in its dropdown. Backed by the same
  // allowlist src/routes/sessions.js validates inbound `model`
  // against, so the dropdown and server enforcement can never drift.
  router.get('/api/models', (_req, res) => {
    res.json({ models: models.list(), default: models.DEFAULT_MODEL });
  });

  router.get('/api/apps/:slug/messages', async (req, res) => {
    const before = req.query.before;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);

    try {
      const { rows: appRows } = await pool.query(
        'SELECT id FROM apps WHERE slug = $1',
        [req.params.slug]
      );
      if (appRows.length === 0) {
        return res.status(404).json({ error: 'App not found' });
      }

      const appId = appRows[0].id;
      let query, params;

      if (before) {
        query = `
          SELECT m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata, m.created_at
          FROM chat_messages m
          LEFT JOIN users u ON m.user_id = u.id
          WHERE m.app_id = $1 AND m.id < $2
          ORDER BY m.id DESC
          LIMIT $3`;
        params = [appId, before, limit];
      } else {
        query = `
          SELECT m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata, m.created_at
          FROM chat_messages m
          LEFT JOIN users u ON m.user_id = u.id
          WHERE m.app_id = $1
          ORDER BY m.id DESC
          LIMIT $2`;
        params = [appId, limit];
      }

      const { rows } = await pool.query(query, params);
      const messages = rows.reverse();

      // #25: attach emoji reactions so the chat renders them on load (live
      // updates arrive separately over the per-app WS 'reaction' event).
      try {
        const { getReactionsForMessages } = require('../services/ws');
        const byId = await getReactionsForMessages(pool, messages.map((m) => m.id));
        for (const m of messages) m.reactions = byId[m.id] || [];
      } catch (err) {
        log.warn('chat', 'reaction hydrate failed', { message: err.message });
      }

      res.json({ messages });
    } catch (err) {
      log.error('chat', 'Failed to load messages', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { chatRoutes };

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

function chatRoutes(config) {
  const router = Router();
  const pool = getPool(config);

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
      res.json({ messages: rows.reverse() });
    } catch (err) {
      log.error('chat', 'Failed to load messages', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { chatRoutes };

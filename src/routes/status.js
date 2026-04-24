const { Router } = require('express');
const path = require('path');
const { getPool } = require('../db/pool');
const status = require('../services/status');
const log = require('../services/logger');

// The /status page is intentionally public. We resolve the session cookie
// ourselves here (bypassing authMiddleware) so that anonymous visitors see a
// sanitized summary while admins see the full dashboard.
function statusRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  async function resolveUser(req) {
    const token = req.cookies?.session;
    if (!token) return null;
    try {
      const { rows } = await pool.query(
        `SELECT s.expires_at, u.is_admin, u.username, u.id AS user_id
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token = $1`,
        [token]
      );
      if (!rows.length || new Date(rows[0].expires_at) < new Date()) return null;
      return { id: rows[0].user_id, username: rows[0].username, isAdmin: rows[0].is_admin };
    } catch {
      return null;
    }
  }

  router.get('/status', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../public/status.html'));
  });

  router.get('/api/status', async (req, res) => {
    try {
      const user = await resolveUser(req);
      const data = await status.gather(config, { isAdmin: !!user?.isAdmin });
      res.json(data);
    } catch (err) {
      log.error('status', 'Failed to gather status', { message: err.message });
      res.status(500).json({ error: 'Failed to gather status' });
    }
  });

  return router;
}

module.exports = { statusRoutes };

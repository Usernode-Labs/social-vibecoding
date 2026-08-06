'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Profile-picture serving (issue #982) — sibling of /app-icons/:id and
// /issue-images/:id (see src/routes/visuals.js for the full rationale).
//
// Mounted in server.js BEFORE authMiddleware: the profile screen, the
// hamburger drawer and (in the follow-up) the kudos leaderboard all load
// these with plain <img> tags, and the tiles must render without an extra
// auth dance. The only access control is the unguessable 32-hex id
// (random 16 bytes, generated in routes/profile.js) — an avatar discloses
// only itself, and it is published to other users by design.
//
// Rows are immutable per id: POST /api/me/avatar rotates to a fresh id
// whenever the bytes change (ON CONFLICT (user_id) DO UPDATE SET id = …)
// and the old id disappears with it, so the year-long immutable cache
// header is safe — a replaced id just 404s for fresh fetchers. No Range
// support: these are small square images, not video.
function avatarRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/avatars/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT content_type, data FROM user_avatars WHERE id = $1',
        [id]
      );
      if (!rows.length || !rows[0].data) return res.status(404).end();
      res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(rows[0].data);
    } catch (err) {
      log.error('avatars', 'Failed to serve avatar', { id, err: err.message });
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { avatarRoutes };

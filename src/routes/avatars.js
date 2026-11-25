'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { renderGeneratedAvatar } = require('../services/generated-avatar');

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

  // The generated picture for an account with no uploaded photo (#7135).
  // It is drawn from the token alone, so it reads no row and needs no auth;
  // the address never changes for an account, so the same year-long
  // immutable cache as an uploaded photo is safe. Registered before
  // /avatars/:id so the two can never be confused, although the id's
  // 32-hex shape already excludes this path.
  router.get('/avatars/g/:token.svg', (req, res) => {
    const token = String(req.params.token || '');
    const svg = renderGeneratedAvatar(token);
    if (!svg) return res.status(404).end();
    res.set('Content-Type', 'image/svg+xml');
    res.set('X-Content-Type-Options', 'nosniff');
    // A document, not a script: an SVG served from our own origin must not
    // be able to fetch or run anything, whatever a future change emits.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(svg);
  });

  router.get('/avatars/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT content_type, data FROM user_avatars WHERE id = $1',
        [id]
      );
      if (!rows.length || !rows[0].data) return res.status(404).end();
      // #2515: the type here is a STORED value, so a file whose recorded
      // content_type says image/* while its bytes are markup must not be
      // sniffed into HTML on the platform's own origin.
      res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
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

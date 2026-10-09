'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// Issue-screenshot image serving (#683) — sibling of /visuals/:id and
// /app-icons/:id (see src/routes/visuals.js for the full rationale).
//
// Mounted in server.js BEFORE authMiddleware: the screenshot is embedded
// as a markdown image in a GitHub issue body, and GitHub's camo proxy
// fetches embeds anonymously — a login redirect would break every embed.
// The in-app topic view and the coding agents' `curl` also load it with
// no special auth. The only access control is the unguessable 32-hex id
// (random 16 bytes, generated in routes/feedback.js) — the same image is
// already public in the GitHub issue body anyway.
//
// Rows are immutable (one upload, linked once), so the year-long
// immutable cache header is safe; a GC'd orphan id just 404s for fresh
// fetchers. No Range support — these are small images, not video.
function issueImageRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/issue-images/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT content_type, data FROM issue_screenshots WHERE id = $1',
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
      log.error('issue-images', 'Failed to serve issue screenshot', { id, err: err.message });
      res.status(500).end();
    }
  });

  // #4482: a C comment's pin, stored beside the image, read back for the
  // request view to draw over it. Same pre-auth router, so the same privacy
  // stance as the image itself: the unguessable id. Written once with the
  // row, so the immutable header is safe — and answering { pin: null }
  // rather than a 404 for a row without a pin keeps the old screenshots'
  // fetches out of the browser console as network errors.
  router.get('/issue-images/:id/pin', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT pin_x, pin_y, pin_comment FROM issue_screenshots WHERE id = $1',
        [id]
      );
      const row = rows[0];
      const pin = row && row.pin_x != null && row.pin_y != null
        ? { x: Number(row.pin_x), y: Number(row.pin_y), comment: row.pin_comment || '' }
        : null;
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      return res.json({ pin });
    } catch (err) {
      log.error('issue-images', 'Failed to serve issue screenshot pin', { id, err: err.message });
      return res.status(500).end();
    }
  });

  return router;
}

module.exports = { issueImageRoutes };

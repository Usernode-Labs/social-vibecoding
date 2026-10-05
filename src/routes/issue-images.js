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
// fetchers. #3940: a row whose stored content type is video/* (a feedback
// screen recording) answers Range requests — a <video> element seeks with
// them — with Accept-Ranges set only there, so image responses stay
// byte-identical to before. The block is the proven minimal single-range
// handler from src/routes/visuals.js.
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
      const contentType = rows[0].content_type || 'application/octet-stream';
      const data = rows[0].data;
      // #2515: the type here is a STORED value, so a file whose recorded
      // content_type says image/* while its bytes are markup must not be
      // sniffed into HTML on the platform's own origin.
      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      // #3940: video only. Rows are small (a video is ≤ 16 MB), so slicing
      // the in-memory Buffer is cheap; anything unparsable falls through to
      // a plain 200 full-body response, which players also accept.
      if (contentType.startsWith('video/')) {
        res.set('Accept-Ranges', 'bytes');
        const range = req.headers.range;
        if (range) {
          const m = range.match(/^bytes=(\d*)-(\d*)$/);
          if (m && (m[1] !== '' || m[2] !== '')) {
            const total = data.length;
            let start = m[1] === '' ? Math.max(0, total - parseInt(m[2], 10)) : parseInt(m[1], 10);
            let end = (m[1] !== '' && m[2] !== '') ? parseInt(m[2], 10) : total - 1;
            if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
              end = Math.min(end, total - 1);
              res.status(206);
              res.set('Content-Range', `bytes ${start}-${end}/${total}`);
              return res.send(data.subarray(start, end + 1));
            }
            res.set('Content-Range', `bytes */${data.length}`);
            return res.status(416).end();
          }
        }
      }
      res.send(data);
    } catch (err) {
      log.error('issue-images', 'Failed to serve issue screenshot', { id, err: err.message });
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { issueImageRoutes };

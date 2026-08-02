'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const galleryDemo = require('../services/gallery-demo');

// Public artifact serving for before/after visuals (#195).
//
// Mounted in server.js BEFORE authMiddleware: GitHub's camo image proxy
// fetches PR-body embeds anonymously, so this route must never redirect
// to login. The only access control is the unguessable 32-hex id (random
// 16 bytes, generated in src/services/visuals.js) — the same artifacts
// are already visible publicly in the PR body on GitHub anyway.
//
// Artifacts are immutable: a re-capture inserts new ids and deletes the
// old rows, so a year-long immutable cache header is safe (a deleted id
// just 404s for fresh fetchers; caches holding it are harmless).
function visualsRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/visuals/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    // Staging mock data (#860): the #admin/gallery section's ?demo=1 rows
    // reference reserved artifact ids that exist in no table — the tile
    // renderer always builds /visuals/<id>, so a data-URI can't be threaded
    // through it. Serve the tiny inline placeholder PNGs for exactly those
    // ids. Gated on USERNODE_ENV === 'staging' inside isDemoVisualId, so
    // this is a strict no-op in production.
    const demoBytes = galleryDemo.demoVisualBytes(id);
    if (demoBytes) {
      res.set('Content-Type', demoBytes.contentType);
      res.set('Cache-Control', 'no-store');
      return res.send(demoBytes.data);
    }
    try {
      const { rows } = await pool.query(
        `SELECT content_type, data FROM session_visuals WHERE id = $1`,
        [id]
      );
      if (!rows.length || !rows[0].data) return res.status(404).end();
      const contentType = rows[0].content_type || 'application/octet-stream';
      const data = rows[0].data;

      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Accept-Ranges', 'bytes');

      // Minimal single-range support: some browsers issue Range requests
      // for <video> sources. The artifacts are small (<= 8 MB) so slicing
      // the in-memory Buffer is cheap; anything unparsable falls through
      // to a plain 200 full-body response, which players also accept.
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
      res.send(data);
    } catch (err) {
      log.error('visuals', 'Failed to serve artifact', { id, err: err.message });
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { visualsRoutes };

const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getAppForUser, NON_SECRET_APP_COLUMNS } = require('../services/app-access');
const { canManageApp } = require('../services/app-admins');
const { sniffImageType } = require('../services/attachments');
const log = require('../services/logger');
const { attachmentUploadLimiter } = require('../middleware/rate-limits');

function parseFraming(body) {
  const { zoom, x, y } = body || {};
  if (![zoom, x, y].every(v => typeof v === 'number' && Number.isFinite(v))
      || zoom < 0.5 || zoom > 3 || x < -100 || x > 100 || y < -100 || y > 100) return null;
  return { zoom, x, y };
}
function validateImage(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > 1024 * 1024) return null;
  const type = sniffImageType(data);
  return ['image/png', 'image/jpeg', 'image/webp'].includes(type) ? type : null;
}
function illustrationImageRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  router.get('/app-illustrations/:id', async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
    try {
      const { rows } = await pool.query('SELECT content_type, data FROM app_illustrations WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).end();
      res.set('Content-Type', rows[0].content_type);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(rows[0].data);
    } catch (err) { log.error('illustrations', 'Image read failed', { err: err.message }); return res.status(500).end(); }
  });
  return router;
}
function illustrationRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  const path = '/api/apps/:slug/featured-illustration';
  router.use(path, async (req, res, next) => {
    try {
      const app = await getAppForUser(pool, req.params.slug, req.user, 'view', NON_SECRET_APP_COLUMNS.join(', '));
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!(await canManageApp(pool, app, req.user))) return res.status(403).json({ error: 'Only app managers can change this illustration.' });
      req.illustrationApp = app;
      next();
    } catch (err) { next(err); }
  });
  router.get(path, (req, res) => res.json({ illustration: req.illustrationApp.featured_illustration || null }));
  router.post(path, attachmentUploadLimiter, express.raw({ type: 'application/octet-stream', limit: '2mb' }), async (req, res, next) => {
    const framing = parseFraming({ zoom: Number(req.query.zoom), x: Number(req.query.x), y: Number(req.query.y) });
    const contentType = validateImage(req.body);
    if (!framing || !contentType) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP under 1 MB and valid image framing.' });
    const id = crypto.randomBytes(16).toString('hex');
    const illustration = { url: `/app-illustrations/${id}`, ...framing };
    try {
      // One statement keeps the image and the framing atomic, even on replacement.
      await pool.query(`WITH image AS (
        INSERT INTO app_illustrations (app_id, id, content_type, data) VALUES ($1, $2, $3, $4)
        ON CONFLICT (app_id) DO UPDATE SET id = EXCLUDED.id, content_type = EXCLUDED.content_type, data = EXCLUDED.data
        RETURNING app_id)
        UPDATE apps SET featured_illustration = $5::jsonb WHERE id = (SELECT app_id FROM image)`,
      [req.illustrationApp.id, id, contentType, req.body, JSON.stringify(illustration)]);
      res.json({ illustration });
    } catch (err) { next(err); }
  });
  router.patch(path, async (req, res, next) => {
    const framing = parseFraming(req.body);
    if (!framing) return res.status(400).json({ error: 'Choose valid image framing.' });
    try {
      const { rows } = await pool.query(`UPDATE apps SET featured_illustration = featured_illustration || $2::jsonb
        WHERE id = $1 AND featured_illustration IS NOT NULL RETURNING featured_illustration`,
      [req.illustrationApp.id, JSON.stringify(framing)]);
      if (!rows.length) return res.status(409).json({ error: 'The illustration was removed. Upload an image again.' });
      res.json({ illustration: rows[0].featured_illustration });
    } catch (err) { next(err); }
  });
  router.delete(path, async (req, res, next) => {
    try {
      await pool.query(`WITH removed AS (DELETE FROM app_illustrations WHERE app_id = $1)
        UPDATE apps SET featured_illustration = NULL WHERE id = $1`, [req.illustrationApp.id]);
      res.json({ illustration: null });
    } catch (err) { next(err); }
  });
  return router;
}
module.exports = { illustrationRoutes, illustrationImageRoutes, parseFraming, validateImage };

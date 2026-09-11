const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { getAppForUser, NON_SECRET_APP_COLUMNS } = require('../services/app-access');
const { canManageApp } = require('../services/app-admins');
const { sniffImageType } = require('../services/attachments');
const log = require('../services/logger');
const { attachmentUploadLimiter } = require('../middleware/rate-limits');

// The card colours an illustration may carry, kept in step with
// frontend/src/features/home/panels/ui.tsx (asserted by
// tests/featured-illustration-tint.test.js, since a .tsx cannot be required
// from here).
//
// TONES are the twelve tone-50 colours the editor offers (`.home-tone-cream`
// … `-gray` in app.css). LEGACY_TINTS are the five hashed tints it offered
// briefly before them; they are still accepted so an illustration saved then
// keeps its colour through a later reframe, and still render, but nothing
// picks a new one.
//
// A card whose illustration carries neither wears the hash of its own slug,
// so a stored value is an OVERRIDE and the absent case is the default rather
// than a missing value. Nothing outside these lists is accepted: the palette
// is the app's own, and an arbitrary colour is exactly what this field is not.
const TONES = ['cream', 'yellow', 'orange', 'coral', 'pink', 'purple',
  'indigo', 'blue', 'teal', 'mint', 'sage', 'gray'];
const LEGACY_TINTS = [1, 2, 3, 4, 5];
const isCardColour = tint => (typeof tint === 'string' ? TONES.includes(tint) : LEGACY_TINTS.includes(tint));

/**
 * Framing, plus the optional card colour that travels with it.
 *
 * The tint is omitted from the result when it was not supplied, which is what
 * makes PATCH's `||` jsonb merge leave an already-saved colour alone rather
 * than writing a null over it.
 */
function parseFraming(body) {
  const { zoom, x, y, tint } = body || {};
  if (![zoom, x, y].every(v => typeof v === 'number' && Number.isFinite(v))
      || zoom < 0.5 || zoom > 3 || x < -100 || x > 100 || y < -100 || y > 100) return null;
  if (tint === undefined || tint === null) return { zoom, x, y };
  return isCardColour(tint) ? { zoom, x, y, tint } : null;
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
      const { rows } = await pool.query('SELECT content_type, data FROM app_illustrations WHERE id = $1 UNION ALL SELECT dark_content_type AS content_type, dark_data AS data FROM app_illustrations WHERE dark_id = $1', [req.params.id]);
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
    const framing = parseFraming({
      zoom: Number(req.query.zoom), x: Number(req.query.x), y: Number(req.query.y),
      // A query value is always a string, so a tone name arrives ready and a
      // legacy tint has to be coerced back to the number it is stored as —
      // the editor stopped sending those, but a page cached from before it
      // did has not. Absent stays absent, so an upload that chose no colour
      // is not rejected for it.
      tint: typeof req.query.tint === 'string' && /^[0-9]+$/.test(req.query.tint)
        ? Number(req.query.tint) : req.query.tint,
    });
    const contentType = validateImage(req.body);
    if (!framing || !contentType) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP under 1 MB, a card colour from the set, and valid image framing.' });
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
  // Both variants and their shared framing are published in one statement.
  // Raw JSON avoids the shell's smaller general-purpose JSON body limit.
  router.put(path, attachmentUploadLimiter, express.raw({ type: 'application/octet-stream', limit: '3mb' }), async (req, res, next) => {
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Could not read the illustration pair.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Could not read the illustration pair.' });
    const framing = parseFraming(body);
    const decode = value => typeof value === 'string' && value.length <= 1398104 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) ? Buffer.from(value, 'base64') : null;
    const light = body.light === undefined ? null : decode(body.light);
    const dark = body.dark === undefined || body.dark === null ? null : decode(body.dark);
    if (!framing || (body.light !== undefined && !validateImage(light)) ||
        (body.dark !== undefined && body.dark !== null && !validateImage(dark))) {
      return res.status(400).json({ error: 'Choose PNG, JPEG or WebP images under 1 MB and valid shared framing.' });
    }
    const lightId = light ? crypto.randomBytes(16).toString('hex') : null;
    const darkId = dark ? crypto.randomBytes(16).toString('hex') : null;
    try {
      const { rows } = await pool.query(`WITH pair AS (
        INSERT INTO app_illustrations (app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
        SELECT a.id, COALESCE($2, i.id), COALESCE($3, i.content_type), COALESCE($4, i.data),
          CASE WHEN $8 THEN $5 ELSE i.dark_id END,
          CASE WHEN $8 THEN $6 ELSE i.dark_content_type END,
          CASE WHEN $8 THEN $7 ELSE i.dark_data END
        FROM apps a LEFT JOIN app_illustrations i ON i.app_id = a.id
        WHERE a.id = $1 AND ($2::text IS NOT NULL OR i.id IS NOT NULL)
        ON CONFLICT (app_id) DO UPDATE SET id = EXCLUDED.id, content_type = EXCLUDED.content_type,
          data = EXCLUDED.data, dark_id = EXCLUDED.dark_id, dark_content_type = EXCLUDED.dark_content_type, dark_data = EXCLUDED.dark_data
        RETURNING app_id, id, dark_id)
        UPDATE apps a SET featured_illustration = COALESCE(a.featured_illustration, '{}'::jsonb) || $9::jsonb ||
          jsonb_build_object('url', '/app-illustrations/' || pair.id, 'darkUrl', CASE WHEN pair.dark_id IS NULL THEN NULL ELSE '/app-illustrations/' || pair.dark_id END)
        FROM pair WHERE a.id = pair.app_id RETURNING featured_illustration`,
      [req.illustrationApp.id, lightId, light && validateImage(light), light, darkId, dark && validateImage(dark), dark,
        body.dark !== undefined, JSON.stringify(framing)]);
      if (!rows.length) return res.status(409).json({ error: 'Upload a light image first.' });
      res.json({ illustration: rows[0].featured_illustration });
    } catch (err) { next(err); }
  });
  router.patch(path, async (req, res, next) => {
    const framing = parseFraming(req.body);
    if (!framing) return res.status(400).json({ error: 'Choose valid image framing and a card colour from the set.' });
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
module.exports = { illustrationRoutes, illustrationImageRoutes, parseFraming, validateImage, TONES, LEGACY_TINTS };

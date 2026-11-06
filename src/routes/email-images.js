// Images an admin uploads from the email template editor
// (frontend/src/features/admin/email-templates/image-panel.tsx), hosted here
// at an address any mail client can load. Two routers, mounted in two places:
//
//   emailImageRoutes        GET /email-images/:id, the bytes. Mounted before
//     authMiddleware in server.js and listed in PUBLIC_PATHS, because the
//     reader's mail client fetches it with no session at all. Access control
//     is the unguessable 32-hex id, as for /challenge-illustrations/.
//   emailImageAdminRoutes   POST /api/admin/email-images, the upload. Composed
//     into ./admin.js behind its adminMiddleware, under the same-site guard
//     server.js puts on every /api/admin write, and requireAdminWrite here, so
//     a view-only admin is refused before the rate limiter or the body read.
//
// The template stores the absolute address the upload returns (imageOrigin
// below), because a mail is read far from Homeroom's own pages.
//
// Only PNG, JPEG, GIF and WebP are taken, told by their first bytes, never by
// a name or a declared type. SVG is not: mail clients do not draw it reliably,
// and it is the one image type that can carry script. The bytes stored are
// the bytes uploaded; nothing is re-encoded.
//
// Nothing is ever deleted and there is no route to do it: an archived version
// of a template still names its images, and a restored one has to draw them.
'use strict';

const express = require('express');
const crypto = require('crypto');
const log = require('../services/logger');
const { sniffImageType } = require('../services/attachments');
const { attachmentUploadLimiter } = require('../middleware/rate-limits');
const { requireAdminWrite } = require('../middleware/admin');
const { PRODUCTION_ORIGIN } = require('../services/cli-auth-constants');

const MAX_BYTES = 1024 * 1024;
const MAX_FILENAME_CHARS = 200;
const FILE_ID = /^[a-f0-9]{32}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Served on every image response, as for the challenge illustrations: a file
// opened directly as a page runs nothing and loads nothing.
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const MESSAGES = {
  format: 'Choose a PNG, JPEG, GIF or WebP image. SVG and other files cannot be used in email.',
  tooLarge: 'The image must be 1 MB or smaller.',
  failed: 'The image could not be saved. Nothing was changed; try again.',
};

const firstHeader = (value) => String(value || '').split(',')[0].trim();

/**
 * The origin an uploaded image's address names. In production it is the
 * canonical public origin, never a Host header. Anywhere else (a staging
 * preview, a local server) it is the origin the editor was opened on, so an
 * image uploaded there loads there: a preview inherits production's domain
 * setting, and naming production would point at bytes production never had.
 */
function imageOrigin(req, env = process.env) {
  if (env.NODE_ENV === 'production' && env.USERNODE_ENV !== 'staging') return PRODUCTION_ORIGIN;
  const proto = firstHeader(req.headers['x-forwarded-proto']) || req.protocol;
  const host = firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host);
  if (!/^https?$/.test(proto) || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return PRODUCTION_ORIGIN;
  return `${proto}://${host}`;
}

// The name the file had, for the record only: trimmed, at most 200
// characters, no control characters, else empty.
function parseFilename(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || [...name].length > MAX_FILENAME_CHARS || /[\u0000-\u001f\u007f]/.test(name)) return '';
  return name;
}

// express.raw, with its size refusal turned into the same 400 envelope as
// every other refusal instead of the default 413 error page.
const rawBody = express.raw({ type: 'application/octet-stream', limit: MAX_BYTES });
function readUpload(req, res, next) {
  rawBody(req, res, (err) => {
    if (err && err.type === 'entity.too.large') return res.status(400).json({ error: MESSAGES.tooLarge });
    return next(err);
  });
}

function emailImageRoutes(pool) {
  const router = express.Router();
  router.get('/email-images/:id', async (req, res) => {
    if (!FILE_ID.test(req.params.id)) return res.status(404).end();
    try {
      const { rows } = await pool.query('SELECT content_type, data FROM email_images WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).end();
      res.set('Content-Type', rows[0].content_type);
      res.set('X-Content-Type-Options', 'nosniff');
      // Immutable: an id is minted per upload and its bytes never change.
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Content-Security-Policy', IMAGE_CSP);
      res.set('Content-Disposition', 'inline');
      return res.send(rows[0].data);
    } catch (err) {
      log.error('email-images', 'Image read failed', { message: err.message });
      return res.status(500).end();
    }
  });
  return router;
}

function emailImageAdminRoutes(pool) {
  const router = express.Router();

  // ── POST /api/admin/email-images?filename= ───────────────────────────
  // The body is the file itself. Answers 201 { id, url }.
  router.post('/api/admin/email-images', requireAdminWrite, attachmentUploadLimiter, readUpload, async (req, res) => {
    const data = req.body;
    const contentType = Buffer.isBuffer(data) ? sniffImageType(data) : null;
    if (!contentType || !TYPES.has(contentType)) return res.status(400).json({ error: MESSAGES.format });
    const id = crypto.randomBytes(16).toString('hex');
    try {
      await pool.query(
        `INSERT INTO email_images (id, content_type, data, filename, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, contentType, data, parseFilename(req.query.filename), req.user?.id ?? null]
      );
      return res.status(201).json({ id, url: `${imageOrigin(req)}/email-images/${id}` });
    } catch (err) {
      log.error('email-images', 'Image upload failed', { message: err.message });
      return res.status(500).json({ error: MESSAGES.failed });
    }
  });

  return router;
}

module.exports = { emailImageRoutes, emailImageAdminRoutes, imageOrigin, parseFilename, IMAGE_CSP, MAX_BYTES };

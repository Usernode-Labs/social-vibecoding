'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { appStorageAuth } = require('../middleware/app-storage-auth');
const appFiles = require('../services/app-files');
const log = require('../services/logger');

// Dapp → platform app-storage API (#752). App containers call these
// with their per-app token (USERNODE_STORAGE_TOKEN) plus the user's
// iframe JWT — the exact app-llm-proxy credential pattern. Mounted in
// server.js BEFORE authMiddleware because callers are app containers,
// not browser sessions; the middleware's private-IP gate keeps it off
// the public internet.
//
// Upload body convention: raw application/octet-stream with ?filename=
// and ?visibility= query params (the platform's raw-body-not-multer
// upload convention — see services/attachments.js). One file per POST.
//
// `deps.store` is injectable for tests; defaults to the module-level
// MinIO wrapper.
function appStorageRoutes(config, deps = {}) {
  const router = Router();
  const pool = getPool(config);
  const store = deps.store !== undefined ? deps.store : appFiles.getStore(config);
  const auth = appStorageAuth(pool, config);

  const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appStorage?.appId || 'anon'}:user:${req.appStorage?.userId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-storage', 'Rate-limited', {
        appId: req.appStorage?.appId, userId: req.appStorage?.userId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // Limit must exceed MAX_FILE_BYTES so the service's own size check
  // (with its structured file_too_large code) fires before the parser's.
  const rawBody = express.raw({ type: 'application/octet-stream', limit: '6mb' });

  router.post('/api/app-storage/files', auth, uploadLimiter, rawBody, async (req, res) => {
    try {
      const { appId, userId } = req.appStorage;
      const result = await appFiles.storeAppFile(pool, store, {
        appId,
        userId,
        filename: String(req.query.filename || '').trim(),
        visibility: req.query.visibility,
        staging: false, // production containers only — staging never holds the token
        data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      if (!result.ok) {
        return res.status(result.status).json({ ok: false, code: result.code, error: result.error });
      }
      return res.json({ ok: true, ...result.file });
    } catch (err) {
      // express.raw over-limit bodies raise PayloadTooLargeError before
      // the handler runs; anything landing here is a genuine failure.
      log.error('app-storage', 'Upload failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'upload_failed', error: 'Upload failed' });
    }
  });

  // Takedown path: the calling app may delete ANY of its own files
  // (not just the requesting user's — moderation needs that). The user
  // token still identifies who initiated the request, for the log.
  router.delete('/api/app-storage/files/:id', auth, async (req, res) => {
    try {
      const { appId, userId } = req.appStorage;
      const result = await appFiles.deleteAppFile(pool, store, {
        appId, fileId: String(req.params.id || ''),
      });
      if (!result.ok) {
        return res.status(result.status).json({ ok: false, code: result.code, error: result.error });
      }
      log.info('app-storage', 'File deleted via app API', {
        appId, fileId: req.params.id, requestedBy: userId,
      });
      return res.json({ ok: true });
    } catch (err) {
      log.error('app-storage', 'Delete failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'delete_failed', error: 'Delete failed' });
    }
  });

  router.get('/api/app-storage/usage', auth, async (req, res) => {
    try {
      const { appId, userId } = req.appStorage;
      return res.json({ ok: true, ...(await appFiles.usageReport(pool, appId, userId)) });
    } catch (err) {
      log.error('app-storage', 'Usage read failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'usage_failed', error: 'Usage read failed' });
    }
  });

  return router;
}

module.exports = appStorageRoutes;

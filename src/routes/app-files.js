'use strict';

const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const platformJwt = require('../services/platform-jwt');
const appFiles = require('../services/app-files');
const { appFileUploadLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// App file storage (#752) — the browser-facing halves. Two routers:
//
//   appFileServeRoutes  — GET /app-files/:id, mounted in server.js
//       BEFORE authMiddleware (sibling of /app-icons/:id and
//       /issue-images/:id): app pages load these with plain <img> tags
//       from their own subdomains, so there is no auth dance to do.
//       For visibility='public' rows the unguessable 32-hex id is the
//       access control; visibility='private' rows additionally require
//       a valid platform user JWT via ?token= (the iframe token the
//       app's frontend already holds). Bytes stream from the MinIO
//       sidecar — this route never buffers whole files.
//
//   appFileShellRoutes  — /api/apps/:slug/files*, mounted behind
//       authMiddleware (session cookie). Called ONLY by the platform
//       shell's bridge relay (public/js/app-view.js
//       handleStorageBridgeMessage) on behalf of usernode.uploadFile()
//       / deleteFile() / getStorageUsage() in the app iframe.
//
// `deps.store` is injectable for tests; defaults to the module-level
// MinIO wrapper.

// The iframe-token shape check, matching app-storage-auth: a plain user
// identity (numeric id, no infrastructure scope). Self-contained on
// purpose — this route is pre-auth, so no middleware attached req.user.
//
// Scoped to the OWNING app's audience since the RSA cutover: a token
// minted for app A no longer unlocks app B's private files, which is the
// same cross-app replay hole app-llm-auth/app-storage-auth closed.
function verifyUserToken(raw, appId) {
  if (!raw || typeof raw !== 'string') return null;
  const claims = platformJwt.orNull(
    () => platformJwt.verifyAppIdentityToken(raw, { appId })
  );
  if (!claims || typeof claims.id !== 'number' || claims.scope) return null;
  return claims;
}

function appFileServeRoutes(config, deps = {}) {
  const router = Router();
  const pool = getPool(config);
  const store = deps.store !== undefined ? deps.store : appFiles.getStore(config);

  router.get('/app-files/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT app_id, filename, content_type, visibility FROM app_files WHERE id = $1',
        [id]
      );
      if (!rows.length) return res.status(404).end();
      const file = rows[0];

      if (file.visibility === 'private') {
        // Private files require a valid platform user JWT minted for THIS
        // app — apps append their iframe token to the URL. 404 (not 401)
        // keeps private ids non-enumerable, same stance as everything else.
        if (!verifyUserToken(req.query.token, file.app_id)) return res.status(404).end();
      }
      if (!store) {
        log.warn('app-files', 'Serve requested but storage unconfigured', { id });
        return res.status(503).end();
      }

      let stream;
      try {
        stream = await store.getFileStream(file.app_id, id);
      } catch (err) {
        // Row-without-object (partial restore, failed delete retry):
        // degrade to 404 for fresh fetchers, loudly in the log.
        log.warn('app-files', 'Object missing for metadata row', { id, err: err.message });
        return res.status(404).end();
      }

      const safeName = String(file.filename || 'file').replace(/["\\\r\n]/g, '_');
      res.set('Content-Type', file.content_type || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', `inline; filename="${safeName}"`);
      // Rows are immutable (no overwrite API): a deleted id 404s for
      // fresh fetchers, so the year-long immutable header is safe for
      // public files. Private URLs carry the ?token= in the cache key
      // and the token rotates hourly, so keep their TTL short.
      res.set('Cache-Control', file.visibility === 'private'
        ? 'private, max-age=3600'
        : 'public, max-age=31536000, immutable');

      stream.on('error', (err) => {
        log.warn('app-files', 'Stream error while serving', { id, err: err.message });
        if (!res.headersSent) res.status(404);
        res.end();
      });
      stream.pipe(res);
    } catch (err) {
      log.error('app-files', 'Failed to serve app file', { id, err: err.message });
      res.status(500).end();
    }
  });

  return router;
}

function appFileShellRoutes(config, deps = {}) {
  const router = Router();
  const pool = getPool(config);
  const store = deps.store !== undefined ? deps.store : appFiles.getStore(config);

  // Limit must exceed MAX_FILE_BYTES so the service's structured
  // file_too_large error fires before the parser's PayloadTooLarge.
  const rawBody = express.raw({ type: 'application/octet-stream', limit: '6mb' });

  // Upload on behalf of the app iframe. Uploading requires the same
  // access as using the app ('view'); 404 on deny so private apps
  // aren't enumerable. `?staging=1` is set by the shell when the relay
  // message came from the staging preview iframe — those rows are
  // stamped and GC'd after 7 days (see services/app-files.js).
  router.post('/api/apps/:slug/files', appFileUploadLimiter, rawBody, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const result = await appFiles.storeAppFile(pool, store, {
        appId: app.id,
        userId: req.user.id,
        filename: String(req.query.filename || '').trim(),
        visibility: req.query.visibility,
        staging: req.query.staging === '1',
        data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      if (!result.ok) {
        return res.status(result.status).json({ code: result.code, error: result.error });
      }
      return res.json(result.file);
    } catch (err) {
      log.error('app-files', 'Shell upload failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

  // Bridge deletions are uploader-only: an app frontend may remove the
  // current user's own files, never someone else's (app-wide takedowns
  // go through the server-side API with the app token).
  router.delete('/api/apps/:slug/files/:fileId', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const result = await appFiles.deleteAppFile(pool, store, {
        appId: app.id,
        fileId: String(req.params.fileId || ''),
        requireUserId: req.user.id,
      });
      if (!result.ok) {
        return res.status(result.status).json({ code: result.code, error: result.error });
      }
      return res.json({ ok: true });
    } catch (err) {
      log.error('app-files', 'Shell delete failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Delete failed' });
    }
  });

  router.get('/api/apps/:slug/files/usage', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      return res.json(await appFiles.usageReport(pool, app.id, req.user.id));
    } catch (err) {
      log.error('app-files', 'Shell usage read failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Usage read failed' });
    }
  });

  return router;
}

module.exports = { appFileServeRoutes, appFileShellRoutes };

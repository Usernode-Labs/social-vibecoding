'use strict';

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { clientIp } = require('../services/client-ip');
const uploads = require('../services/external-agent-patch-upload');

// PUT /api/external-tasks/:taskId/patch — a coding agent hands in a large
// patch for a connector work order without retyping it into a tool call
// (#4264). services/external-agent-patch-upload.js has the why; this is the
// door.
//
// The work order prints the exact command:
//
//   git format-patch <base>..HEAD --stdout | curl -sS --max-time 120 -X PUT \
//     -H 'Authorization: Bearer svpu_…' --data-binary @- <origin>/api/external-tasks/<id>/patch
//
// POST is accepted too, since curl sends one when `-X PUT` is dropped.
//
// MOUNTED BEFORE THE JSON PARSER AND BEFORE authMiddleware, like the GitHub
// webhook: the body is raw patch bytes, whatever Content-Type curl puts on
// them, and the caller is a sandbox that holds no Homeroom session. The task
// token in the Authorization header is the whole of the authentication.
//
// ORDER IS THE POINT. The per-address bucket runs before anything is looked
// up, the token is checked before a single body byte is read, and only then
// is the body buffered, against a hard limit. So an unauthenticated caller
// can make the server neither query much nor hold a megabyte.
//
// Nothing here logs the token or the body. A refusal logs its code and the
// task id; a stored upload logs its id and size.

const IP_RATE_PER_MINUTE = 30;
const TASK_RATE_PER_MINUTE = 10;

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

function refuse(res, result) {
  const { status = 400, code, message, limitBytes } = result;
  return res.status(status).json({
    ok: false,
    error: code,
    message,
    ...(limitBytes ? { limitBytes } : {}),
  });
}

// The same shared, Postgres-backed token bucket the connector's own POST /mcp
// is limited by (routes/mcp-remote.js). If it cannot run, the request does
// not run either.
function defaultLimiter(pool) {
  const { consumeSharedTokenBucket } = require('../services/cli-auth');
  return async ({ namespace, subject, ratePerMinute }) => consumeSharedTokenBucket(pool, {
    namespace, subject, ratePerMinute, capacity: ratePerMinute,
  });
}

function externalAgentPatchUploadRoutes(config, deps = {}) {
  const router = express.Router();
  const pool = deps.pool || getPool(config);
  const limit = deps.limiter || defaultLimiter(pool);
  const staging = () => process.env.USERNODE_ENV === 'staging';

  const bucket = async (res, options) => {
    try {
      const state = await limit(options);
      if (state && state.allowed) return true;
      res.setHeader('Retry-After', String((state && state.retryAfter) || 60));
      res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: 'Too many uploads. Wait a minute and run the command again.',
      });
      return false;
    } catch {
      res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
      return false;
    }
  };

  // Header-only checks: the address bucket, the token, the task's bucket.
  const authenticate = async (req, res, next) => {
    // A staging preview runs unreviewed code and has no connector work orders
    // to upload to; it does not take uploads at all.
    if (staging()) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await bucket(res, {
      namespace: 'patch-upload-ip', subject: clientIp(req), ratePerMinute: IP_RATE_PER_MINUTE,
    }))) return undefined;

    const taskId = uploads.taskIdOf(req.params.taskId);
    const token = uploads.tokenFromHeader(req.get('authorization'));
    let auth;
    try {
      auth = await uploads.authenticateUpload(pool, { taskId, token });
    } catch (err) {
      log.error('patch-upload', 'token lookup failed', { taskId, err: err.message });
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
    }
    if (!auth.ok) {
      log.warn('patch-upload', 'upload refused', { taskId, code: auth.code, ip: clientIp(req) });
      return refuse(res, auth);
    }
    if (!(await bucket(res, {
      namespace: 'patch-upload-task', subject: String(auth.taskId), ratePerMinute: TASK_RATE_PER_MINUTE,
    }))) return undefined;
    req.patchUpload = auth;
    return next();
  };

  // Raw bytes, any Content-Type, read only once the token checked out. One
  // byte over the limit is enough to know it is too large.
  const rawBody = (req, res, next) => {
    express.raw({ type: () => true, limit: uploads.MAX_UPLOADED_PATCH_BYTES + 1 })(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large' || err.status === 413) {
        return refuse(res, {
          status: 413,
          code: 'patch_too_large',
          message: `That patch is over the ${Math.round(uploads.MAX_UPLOADED_PATCH_BYTES / 1024)} KB an upload can `
            + 'be. Push the branch to your fork instead and submit it with `branch`.',
          limitBytes: uploads.MAX_UPLOADED_PATCH_BYTES,
        });
      }
      return refuse(res, { status: 400, code: 'invalid_request', message: 'The upload could not be read.' });
    });
  };

  const store = async (req, res) => {
    const auth = req.patchUpload;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let stored;
    try {
      stored = await uploads.storeUpload(pool, { taskId: auth.taskId, tokenId: auth.tokenId, body });
    } catch (err) {
      log.error('patch-upload', 'storing the upload failed', { taskId: auth.taskId, err: err.message });
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
    }
    if (!stored.ok) {
      log.warn('patch-upload', 'upload refused', { taskId: auth.taskId, code: stored.code, bytes: body.length });
      return refuse(res, stored);
    }
    log.info('patch-upload', 'patch uploaded', {
      taskId: stored.taskId, uploadId: stored.uploadId, bytes: stored.bytes,
    });
    return res.status(201).json({
      ok: true,
      taskId: stored.taskId,
      uploadId: stored.uploadId,
      bytes: stored.bytes,
      sha256: stored.sha256,
      nextStep: `Call submit_work with taskId ${stored.taskId} and patchUploadId ${stored.uploadId} (instead of `
        + '`patch`). Uploading again replaces this upload and prints a new uploadId.',
    });
  };

  // Literal paths, so the route inventories can read them; uploads.uploadPath
  // builds the same one for the work order.
  router.put('/api/external-tasks/:taskId/patch', noStore, authenticate, rawBody, store);
  router.post('/api/external-tasks/:taskId/patch', noStore, authenticate, rawBody, store);
  return router;
}

module.exports = {
  externalAgentPatchUploadRoutes,
  IP_RATE_PER_MINUTE,
  TASK_RATE_PER_MINUTE,
};

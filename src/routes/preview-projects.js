'use strict';

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { isDirectInternalCall } = require('../services/client-ip');
const previewProjects = require('../services/preview-projects');

// /api/preview-projects/:slug — a platform preview asks production to make,
// build, run and remove the projects someone makes inside it.
// services/preview-projects.js has the why and the limits; this is the door.
//
// MOUNTED BEFORE THE JSON PARSER AND BEFORE authMiddleware, like the patch
// upload: the caller is a preview's own process, which holds no session,
// and a build's body is up to the source limit, far over the global
// parser's. Each route parses its own body, and only once the caller is
// known.
//
// WHO MAY CALL: only from inside the cluster, directly (no proxy in front:
// client-ip.js isDirectInternalCall), and only with a preview's credential.
// The session comes from the credential, never from the request, so a
// preview reaches its own projects and nothing else. Off, in a preview, or
// for anyone else, it is not there at all (404).
//
// Nothing here logs the credential, a body or an env value.

const SESSION_RATE_PER_MINUTE = 120;
// Base64 of the source limit, with room for the JSON around it.
const BUILD_BODY_LIMIT = Math.ceil(previewProjects.MAX_SOURCE_BYTES * 1.4) + 64 * 1024;

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

function notFound(res) {
  return res.status(404).json({ ok: false, error: 'not_found' });
}

function refuse(res, result) {
  const { status = 400, code, message } = result;
  return res.status(status).json({ ok: false, error: code, message });
}

function unavailable(res) {
  return res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
}

function defaultLimiter(pool) {
  const { consumeSharedTokenBucket } = require('../services/cli-auth');
  return async ({ namespace, subject, ratePerMinute }) => consumeSharedTokenBucket(pool, {
    namespace, subject, ratePerMinute, capacity: ratePerMinute,
  });
}

function previewProjectsRoutes(config, deps = {}) {
  const router = express.Router();
  const pool = deps.pool || getPool(config);
  const service = deps.service || previewProjects;
  const limit = deps.limiter || defaultLimiter(pool);
  const internal = deps.isInternal || isDirectInternalCall;

  const authenticate = async (req, res, next) => {
    if (!internal(req) || !(await service.enabled(config, pool))) return notFound(res);
    const token = service.tokenFromHeader(req.get('authorization'));
    let auth;
    try {
      auth = await service.authenticate(config, pool, token);
    } catch (err) {
      log.error('preview-projects', 'Credential lookup failed', { err: err.message });
      return unavailable(res);
    }
    if (!auth.ok) return refuse(res, auth);
    try {
      const state = await limit({
        namespace: 'preview-projects', subject: String(auth.sessionId), ratePerMinute: SESSION_RATE_PER_MINUTE,
      });
      if (!state || !state.allowed) {
        res.setHeader('Retry-After', String((state && state.retryAfter) || 60));
        return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Wait a minute.' });
      }
    } catch {
      return unavailable(res);
    }
    req.previewProjects = { sessionId: auth.sessionId };
    return next();
  };

  const json = (max) => (req, res, next) => {
    express.json({ limit: max })(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large' || err.status === 413) {
        return refuse(res, { status: 413, code: 'too_large', message: 'That request is too large.' });
      }
      return refuse(res, { status: 400, code: 'invalid_request', message: 'The request could not be read.' });
    });
  };

  // One handler shape for every operation: the service's answer, as JSON.
  const answer = (run) => async (req, res) => {
    const { sessionId } = req.previewProjects;
    let result;
    try {
      result = await run({ sessionId, slug: String(req.params.slug || ''), body: req.body || {}, query: req.query || {} });
    } catch (err) {
      log.error('preview-projects', 'Request failed', { sessionId, slug: req.params.slug, err: err.message });
      return unavailable(res);
    }
    if (!result.ok) return refuse(res, result);
    const { ok: _ok, status = 200, ...rest } = result;
    return res.status(status).json({ ok: true, ...rest });
  };

  router.put('/api/preview-projects/:slug', noStore, authenticate, json('16kb'), answer(({ sessionId, slug, body }) =>
    service.createProject(config, pool, { sessionId, slug, appId: body.appId, name: body.name })));
  router.get('/api/preview-projects/:slug', noStore, authenticate, answer(({ sessionId, slug, query }) =>
    service.describe(config, pool, { sessionId, slug, runtime: query.runtime === '1' })));
  router.get('/api/preview-projects/:slug/logs', noStore, authenticate, answer(({ sessionId, slug, query }) =>
    service.logs(config, pool, { sessionId, slug, tail: query.tail })));
  router.post('/api/preview-projects/:slug/build', noStore, authenticate, json(BUILD_BODY_LIMIT), answer(async ({ sessionId, slug, body }) => {
    const result = await service.startBuild(config, pool, { sessionId, slug, files: body.files });
    return result.ok ? { ...result, status: 202 } : result;
  }));
  router.post('/api/preview-projects/:slug/deploy', noStore, authenticate, json('512kb'), answer(async ({ sessionId, slug, body }) => {
    const result = await service.startDeploy(config, pool, { sessionId, slug, imageRef: body.imageRef, env: body.env });
    return result.ok ? { ...result, status: 202 } : result;
  }));
  router.post('/api/preview-projects/:slug/restart', noStore, authenticate, answer(({ sessionId, slug }) =>
    service.restart(config, pool, { sessionId, slug })));
  router.delete('/api/preview-projects/:slug', noStore, authenticate, answer(({ sessionId, slug }) =>
    service.remove(config, pool, { sessionId, slug })));
  return router;
}

module.exports = {
  previewProjectsRoutes,
  SESSION_RATE_PER_MINUTE,
  BUILD_BODY_LIMIT,
};

'use strict';

// Run routes (#routes) — the viewer's own runs, and nothing else.
//
//   GET    /api/routes             → { runs }          your finished runs
//   POST   /api/routes             → { run }           start one
//   GET    /api/routes/:id         → { run, points }   one run and its trace
//   POST   /api/routes/:id/points  → { appended }      append a batch of fixes
//   POST   /api/routes/:id/finish  → { run }           finalize
//   DELETE /api/routes/:id         → { deleted: true } remove it
//
// PRIVATE BY CONSTRUCTION, the same shape as routes/friends.js: every route
// reads or writes the signed-in viewer's own rows, and there is no route
// that lists, counts or names anybody else's run. A run that is not yours
// answers a generic 404 rather than a 403 — a 403 would confirm the row
// exists, which is exactly the fact this feature is not allowed to disclose.
// Every response is `Cache-Control: private, no-store`.
//
// NO COMMUNITY-MEMBERSHIP GATE. The gates on proposing, voting and chat
// guard a write INTO a community. This is a person's own private data,
// which is the same reason a direct message needs none; the auth middleware
// is the whole of the door.
//
// ?demo=1 on a staging preview answers from services/run-routes.js's
// fixtures and writes nothing. It exists because a private list is blank in
// a preview of an account that has never recorded a run, and the seeding
// rule forbids attributing demo rows to whoever opened the preview. The
// plain route stays honest: a real account sees its own runs, which is the
// empty state on a fresh one.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const routes = require('../services/run-routes');
const { strictId } = require('../services/conversations');
const { runRouteWriteLimiter } = require('../middleware/rate-limits');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const NOT_FOUND = { error: 'Run not found' };
const TOO_MANY_POINTS = {
  error: `That run already holds the maximum of ${routes.MAX_POINTS_PER_RUN} points.`,
  code: 'route_full',
};
const TOO_MANY_RUNS = {
  error: `You already have ${routes.MAX_RUNS_PER_USER} runs. Delete one to record another.`,
  code: 'too_many_runs',
};

function privateJson(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function isDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

/** One fix from the client, or null if it is not usable as one. */
function readPoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = Number(raw.seq);
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  const point = { seq, lat, lng };
  if (!routes.usablePoint(point)) return null;
  const at = Date.parse(raw.recorded_at);
  point.recorded_at = Number.isNaN(at) ? new Date().toISOString() : new Date(at).toISOString();
  const optional = ['accuracy_m', 'altitude_m', 'speed_mps'];
  for (const key of optional) {
    const value = raw[key];
    point[key] = value === null || value === undefined || !Number.isFinite(Number(value))
      ? null
      : Number(value);
  }
  return point;
}

function runRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  router.use('/api/routes', privateJson);

  router.get('/api/routes', async (req, res) => {
    try {
      if (isDemo(req)) return res.json(routes.demoList());
      return res.json({ runs: await routes.listFor(pool, req.user.id) });
    } catch (err) {
      log.error('run-routes', 'list failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/routes', runRouteWriteLimiter, async (req, res) => {
    try {
      const startedAt = Date.parse(req.body?.started_at);
      const at = Number.isNaN(startedAt) ? new Date().toISOString() : new Date(startedAt).toISOString();
      if (isDemo(req)) return res.json({ run: routes.demoRun(routes.DEMO_RUNS[0].id), demo: true });
      if (await routes.countFor(pool, req.user.id) >= routes.MAX_RUNS_PER_USER) {
        return res.status(429).json(TOO_MANY_RUNS);
      }
      const run = await routes.createRun(pool, req.user.id, at);
      return res.json({ run });
    } catch (err) {
      log.error('run-routes', 'start failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/routes/:id', async (req, res) => {
    const id = strictId(req.params.id);
    if (!id) return res.status(404).json(NOT_FOUND);
    try {
      if (isDemo(req)) {
        const demo = routes.demoDetail(id);
        if (demo) return res.json(demo);
        return res.status(404).json(NOT_FOUND);
      }
      const run = await routes.ownedRun(pool, req.user.id, id);
      if (!run) return res.status(404).json(NOT_FOUND);
      return res.json({ run, points: await routes.pointsFor(pool, id) });
    } catch (err) {
      log.error('run-routes', 'read failed', { userId: req.user.id, id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/routes/:id/points', runRouteWriteLimiter, async (req, res) => {
    const id = strictId(req.params.id);
    if (!id) return res.status(404).json(NOT_FOUND);
    const raw = Array.isArray(req.body?.points) ? req.body.points : [];
    const points = raw.slice(0, routes.MAX_POINTS_PER_RUN).map(readPoint).filter(Boolean);
    try {
      // Read-only in a preview: the demo runs are fixtures, not rows.
      if (isDemo(req)) {
        if (!routes.demoRun(id)) return res.status(404).json(NOT_FOUND);
        return res.json({ appended: points.length, demo: true });
      }
      const run = await routes.ownedRun(pool, req.user.id, id);
      if (!run) return res.status(404).json(NOT_FOUND);
      if (run.point_count + points.length > routes.MAX_POINTS_PER_RUN) {
        return res.status(429).json(TOO_MANY_POINTS);
      }
      const appended = await routes.appendPoints(pool, id, points);
      return res.json({ appended });
    } catch (err) {
      log.error('run-routes', 'append failed', { userId: req.user.id, id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/routes/:id/finish', runRouteWriteLimiter, async (req, res) => {
    const id = strictId(req.params.id);
    if (!id) return res.status(404).json(NOT_FOUND);
    try {
      const finishedAt = Date.parse(req.body?.finished_at);
      const at = Number.isNaN(finishedAt) ? new Date().toISOString() : new Date(finishedAt).toISOString();
      if (isDemo(req)) {
        const demo = routes.demoRun(id);
        if (!demo) return res.status(404).json(NOT_FOUND);
        return res.json({ run: demo, demo: true });
      }
      const run = await routes.finishRun(pool, req.user.id, id, at);
      if (!run) return res.status(404).json(NOT_FOUND);
      return res.json({ run });
    } catch (err) {
      log.error('run-routes', 'finish failed', { userId: req.user.id, id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/routes/:id', runRouteWriteLimiter, async (req, res) => {
    const id = strictId(req.params.id);
    if (!id) return res.status(404).json(NOT_FOUND);
    try {
      if (isDemo(req)) {
        if (!routes.demoRun(id)) return res.status(404).json(NOT_FOUND);
        return res.json({ deleted: true, demo: true });
      }
      const removed = await routes.deleteRun(pool, req.user.id, id);
      if (!removed) return res.status(404).json(NOT_FOUND);
      return res.json({ deleted: true });
    } catch (err) {
      log.error('run-routes', 'delete failed', { userId: req.user.id, id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { runRoutes };

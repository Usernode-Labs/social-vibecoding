'use strict';

// #3654: the Homeroom bot benchmark's HTTP surface (services/bench/).
//
// Admin console routes live under /api/admin/homeroom-bot/bench, beside the
// bot's own: the read is open to any admin (view-only included, as the bot's
// dashboard is), and every write is requireAdminWrite. The services own every
// query and every rule; this layer only gates, parses and answers.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');
const suites = require('../services/bench/suites');

const BASE = '/api/admin/homeroom-bot/bench';

function idParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// One error shape for every handler: a service's refusal carries its own
// status; anything thrown is logged and answered as a 500.
function handler(label, fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent) return undefined;
      if (out && out.ok === false) return res.status(out.status || 400).json({ error: out.error });
      return res.json(out);
    } catch (err) {
      log.error('bench', `${label} failed`, { message: err.message });
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      return undefined;
    }
  };
}

function homeroomBenchRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use(BASE, adminMiddleware);

  // ── Suites and tasks (#3654 B) ──────────────────────────────────────
  router.get('/api/admin/homeroom-bot/bench/suites', handler('List bench suites', async () => ({
    suites: await suites.listSuites(pool),
    targets: suites.TARGETS,
    stages: suites.TASK_STAGES,
  })));

  router.get('/api/admin/homeroom-bot/bench/suites/:id/tasks', handler('List bench tasks', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid suite id' };
    const suite = await suites.suiteRow(pool, id);
    if (!suite) return { ok: false, status: 404, error: 'Suite not found' };
    return { suite, tasks: await suites.listTasks(pool, id) };
  }));

  router.post('/api/admin/homeroom-bot/bench/suites', requireAdminWrite, handler('Create bench suite', async (req) => {
    const { name, kind, notes } = req.body || {};
    const out = await suites.createSuite(pool, { name, kind, notes, actorId: req.user.id });
    if (out.ok) log.info('bench', 'Suite created', { by: req.user.username, name: out.suite.name, version: out.suite.version });
    return out;
  }));

  router.post('/api/admin/homeroom-bot/bench/suites/:id/freeze', requireAdminWrite, handler('Freeze bench suite', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid suite id' };
    return suites.freezeSuite(pool, id);
  }));

  router.post('/api/admin/homeroom-bot/bench/suites/:id/version', requireAdminWrite, handler('Version bench suite', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid suite id' };
    return suites.newVersion(pool, id, { actorId: req.user.id });
  }));

  // "Add to a benchmark suite": one run, or several (the sampler's picks).
  router.post('/api/admin/homeroom-bot/bench/suites/:id/tasks', requireAdminWrite, handler('Add bench task', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid suite id' };
    const body = req.body || {};
    const runIds = Array.isArray(body.runIds) ? body.runIds : [body.runId];
    const ids = runIds.map(idParam).filter(Boolean).slice(0, 100);
    if (!ids.length) return { ok: false, status: 400, error: 'runId or runIds is required' };
    const added = [];
    const refused = [];
    for (const runId of ids) {
      // eslint-disable-next-line no-await-in-loop
      const out = await suites.addTaskFromRun(pool, { suiteId: id, runId, stage: body.stage, config });
      if (out.ok) added.push(out.task); else refused.push({ runId, error: out.error, status: out.status });
    }
    if (!added.length && refused.length === 1) return { ok: false, status: refused[0].status, error: refused[0].error };
    return { added, refused };
  }));

  router.post('/api/admin/homeroom-bot/bench/suites/:id/import-pr', requireAdminWrite, handler('Import bench task from a PR', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid suite id' };
    const { appSlug, issueNumber, prNumber } = req.body || {};
    const out = await suites.importTaskFromPr(pool, { suiteId: id, appSlug, issueNumber, prNumber, config });
    if (out.ok) log.info('bench', 'Build task imported from a PR', { by: req.user.username, appSlug, prNumber, hidden: out.hiddenChecks });
    return out;
  }));

  router.delete('/api/admin/homeroom-bot/bench/tasks/:id', requireAdminWrite, handler('Remove bench task', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid task id' };
    return suites.removeTask(pool, { taskId: id });
  }));

  // An admin's own label for a task: its reference, as a person wrote it.
  router.post('/api/admin/homeroom-bot/bench/tasks/:id/reference', requireAdminWrite, handler('Label bench task', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid task id' };
    const { reference = {}, tags = {} } = req.body || {};
    if (typeof reference !== 'object' || typeof tags !== 'object') return { ok: false, status: 400, error: 'reference and tags must be objects' };
    return suites.setReference(pool, { taskId: id, patch: reference || {}, tags: tags || {}, source: 'human', actorId: req.user.id });
  }));

  router.get('/api/admin/homeroom-bot/bench/sample', handler('Sample bench tasks', async (req) => {
    const q = req.query || {};
    return suites.proposeSample(pool, {
      suiteId: idParam(q.suiteId),
      stage: String(q.stage || ''),
      n: Math.min(Number(q.n) || 10, 100),
      seed: Number.isInteger(Number(q.seed)) ? Number(q.seed) : 1,
      config,
    });
  }));

  return router;
}

module.exports = { homeroomBenchRoutes, BASE };

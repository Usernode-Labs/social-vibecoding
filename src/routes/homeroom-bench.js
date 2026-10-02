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
const catalog = require('../services/bench/catalog');
const lane = require('../services/bench/lane');
const runner = require('../services/bench/runner');
const grading = require('../services/bench/grading');
const { benchGradingLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const report = require('../services/bench/report');
// The CSV writer the other admin exports share: quoting plus the
// spreadsheet formula-injection guard (model-written text is exactly why).
const { csvField } = require('./topochain/helpers');

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

  // The Benchmark area's overview: what exists, and the lane's state.
  router.get('/api/admin/homeroom-bot/bench', handler('Bench overview', async () => {
    const { rows: [c] } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM bench_suites) AS suites,
              (SELECT COUNT(*)::int FROM bench_runs) AS runs,
              (SELECT COUNT(*)::int FROM bench_runs WHERE status IN ('queued', 'running')) AS open_runs`,
    );
    return { suites: c.suites, runs: c.runs, openRuns: c.open_runs, lane: lane.laneStatus(), hiddenChecks: runner.HIDDEN_CHECKS_GAP };
  }));

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
    const out = await suites.setReference(pool, { taskId: id, patch: reference || {}, tags: tags || {}, source: 'human', actorId: req.user.id });
    // Trials already run on the task are graded again against it.
    if (out.ok) await require('../services/bench/graders').regradeTask(pool, id, { github: runner.guardedGithub(require('../services/github')) });
    return out;
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

  // ── Runs (#3654 C) ──────────────────────────────────────────────────
  router.get('/api/admin/homeroom-bot/bench/models', handler('List bench models', async () => {
    const { rows } = await pool.query('SELECT DISTINCT UNNEST(models) AS id FROM bench_runs');
    return { models: await catalog.listModels(pool, rows.map((r) => r.id)), baseline: catalog.BASELINE };
  }));

  router.get('/api/admin/homeroom-bot/bench/runs', handler('List bench runs', async () => ({
    runs: await lane.listRuns(pool),
    lane: lane.laneStatus(),
    defaults: { capUsd: lane.DEFAULT_CAP_USD, repeats: lane.DEFAULT_REPEATS, maxConcurrency: lane.MAX_CONCURRENCY },
    hiddenChecks: runner.HIDDEN_CHECKS_GAP,
  })));

  router.post('/api/admin/homeroom-bot/bench/runs', requireAdminWrite, handler('Launch bench run', async (req) => {
    const out = await lane.launchRun(pool, req.body || {}, { actorId: req.user.id });
    if (out.ok) {
      log.info('bench', 'Run launched', {
        by: req.user.username, runId: out.run.id, trials: out.trials, estimateUsd: out.estimateUsd, capUsd: out.run.cap_usd,
      });
    }
    return out;
  }));

  router.post('/api/admin/homeroom-bot/bench/runs/:id/cancel', requireAdminWrite, handler('Cancel bench run', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid run id' };
    const out = await lane.cancelRun(pool, id);
    if (out.ok) log.info('bench', 'Run cancelled', { by: req.user.username, runId: id });
    return out;
  }));

  // ── Results (#3654 F) ───────────────────────────────────────────────
  router.get('/api/admin/homeroom-bot/bench/runs/:id/report', handler('Bench run report', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid run id' };
    const out = await report.runReport(pool, id, { slice: String(req.query?.slice || 'verdict') });
    if (!out) return { ok: false, status: 404, error: 'Run not found' };
    return { ...out, agreement: await grading.agreement(pool, { runId: id }) };
  }));

  // Every trial of a run, as CSV. A bulk download sits behind the write gate,
  // like the bot's own verdict export beside it (routes/admin.js says why).
  router.get('/api/admin/homeroom-bot/bench/runs/:id/trials.csv', requireAdminWrite, async (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid run id' });
    try {
      const rows = await report.csvRows(pool, id);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="homeroom-bot-benchmark-run-${id}.csv"`);
      res.write(`${report.CSV_COLUMNS.join(',')}\n`);
      for (const row of rows) res.write(`${row.map(csvField).join(',')}\n`);
      log.info('bench', 'Trials exported', { by: req.user.username, runId: id, rows: rows.length });
      return res.end();
    } catch (err) {
      log.error('bench', 'Trials export failed', { message: err.message });
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      return res.end();
    }
  });

  // ── Grading (#3654 D) ───────────────────────────────────────────────

  // The console's spot check of a run: its judged trials, blind, with the
  // judge's grade and critique; and how far the judge agrees with people.
  router.get('/api/admin/homeroom-bot/bench/runs/:id/review', handler('Review bench grades', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid run id' };
    return {
      items: await grading.spotCheck(pool, { runId: id, limit: Number(req.query?.limit) || 20 }),
      agreement: await grading.agreement(pool, { runId: id }),
    };
  }));

  // A person's grade: it overrides the judge's on that trial.
  router.post('/api/admin/homeroom-bot/bench/trials/:id/grade', requireAdminWrite, handler('Grade bench trial', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return { ok: false, status: 400, error: 'Invalid trial id' };
    const { verdict, critique } = req.body || {};
    return grading.overrideGrade(pool, { trialId: id, verdict, critique, user: req.user });
  }));

  // ── The judge's doors, for the admin-only connector tools ───────────
  //
  // OUTSIDE /api/admin on purpose: a connector token can never reach
  // /api/admin (services/cli-api-policy.js denies the prefix outright), so
  // these four are on the connector's allowlist under their own prefix, and
  // each one refuses anybody who is not a FULL platform admin before it reads
  // a thing (requireAdminWrite: is_admin and not view-only). They hand out
  // tasks from any app, private ones included, which is why a member's
  // connector must never reach them. The grading writes are rate limited per
  // person. A grade sent through a connector or the CLI is recorded as the
  // judge's (`opus`), with the person's name; one sent from a browser is a
  // person's.
  const graderOf = (req) => (req.cliAuthenticated ? 'opus' : 'human');

  router.get('/api/bot-bench/queue', requireAdminWrite, handler('Bench grading queue', async (req) => {
    const kind = req.query?.kind === 'label' ? 'label' : 'grade';
    return grading.queue(pool, { kind, limit: Number(req.query?.limit) || 20 });
  }));

  router.get('/api/bot-bench/items/:token', requireAdminWrite, handler('Bench item', async (req) => grading.getItem(pool, req.params.token)));

  router.post('/api/bot-bench/items/:token/grade', requireAdminWrite, benchGradingLimiter, sameOriginBrowserOnly, handler('Bench grade', async (req) => {
    const { verdict, critique, criteria } = req.body || {};
    return grading.submitGrade(pool, {
      itemId: req.params.token, verdict, critique, criteria: criteria && typeof criteria === 'object' ? criteria : {},
      grader: graderOf(req), user: req.user,
    });
  }));

  router.post('/api/bot-bench/tasks/:token/label', requireAdminWrite, benchGradingLimiter, sameOriginBrowserOnly, handler('Bench label', async (req) => {
    const b = req.body || {};
    const github = require('../services/github');
    return grading.labelTask(pool, {
      itemId: req.params.token,
      verdict: b.verdict ?? null,
      action: b.action ?? null,
      answers: b.answers ?? null,
      notes: b.notes ?? null,
      expectedFiles: b.expectedFiles ?? null,
      allowedTestEdits: b.allowedTestEdits ?? null,
      specPoints: b.specPoints ?? null,
      tags: b.tags && typeof b.tags === 'object' ? b.tags : {},
      source: graderOf(req) === 'opus' ? 'opus' : 'human',
      user: req.user,
      regrade: { github: runner.guardedGithub(github) },
    });
  }));

  return router;
}

module.exports = { homeroomBenchRoutes, BASE };

'use strict';

// The App bench studio's HTTP surface (services/bench/studio.js), and the
// admin connector's reads and writes of the rest of the Homeroom bot
// benchmark, the bot's own data, and the recent before/after screenshots
// (services/bench/connector-data.js).
//
// Two doors onto the same services:
//
//   /api/admin/homeroom-bot/bench/studio/…   the console's Studio place
//       (frontend/src/features/admin/admin-bench-studio.tsx). Any admin
//       reads, as every benchmark read is; every write is requireAdminWrite.
//
//   /api/bot-studio/…   the admin connector's (services/mcp-tools.js), on
//       its allowlist (services/cli-api-policy.js CONNECTOR_ALLOWED_ROUTES).
//       OUTSIDE /api/admin because a connector can never reach that prefix,
//       and gated like the benchmark's own connector doors
//       (routes/homeroom-bench.js /api/bot-bench): requireAdminWrite FIRST on
//       every route, reads included, because they read tasks, builds and
//       screenshots of every app, private ones too; then, on every write, a
//       per-person limiter and the same-origin browser guard. A launch
//       spends the platform's money: it must name its cap, and a cap over
//       CONNECTOR_CONFIRM_CAP_USD needs `confirmLargeCap`.
//
// Watching is open by design (the person driving a studio run chooses what to
// change next); a classic run's per-trial reads are refused while it waits
// for the judge (studio.trialRows, studio.trialDetail), so blind grading
// stays blind.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { benchRunLimiter, benchStudioLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const log = require('../services/logger');
const studio = require('../services/bench/studio');
const packs = require('../services/bench/packs');
const data = require('../services/bench/connector-data');
const suites = require('../services/bench/suites');
const taste = require('../services/bench/taste');

const CONSOLE = '/api/admin/homeroom-bot/bench/studio';
const CONNECTOR_CONFIRM_CAP_USD = 100;

function idParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// One error shape for every handler, as routes/homeroom-bench.js has it: a
// service's refusal carries its own status (and a code where it has one);
// anything thrown is logged and answered as a 500.
function handler(label, fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent) return undefined;
      if (out && out.ok === false) {
        return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
      }
      return res.json(out);
    } catch (err) {
      log.error('bench', `${label} failed`, { message: err.message });
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      return undefined;
    }
  };
}

const bad = (error) => ({ ok: false, status: 400, error });

function benchStudioRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── Shared handlers ─────────────────────────────────────────────────

  const launch = (via) => async (req) => {
    const b = req.body || {};
    if (via === 'connector' && Number(b.capUsd) > CONNECTOR_CONFIRM_CAP_USD && b.confirmLargeCap !== true) {
      return bad(`A cap over $${CONNECTOR_CONFIRM_CAP_USD} needs confirmLargeCap`);
    }
    const out = await studio.launch(pool, config, {
      briefSet: b.briefSet, refs: b.refs, briefs: b.briefs, models: b.models, contextPackIds: b.contextPackIds,
      references: b.references, repeats: b.repeats, capUsd: b.capUsd, concurrency: b.concurrency, note: b.note,
    }, { actorId: req.user.id });
    if (out.ok) log.info('bench', 'Studio run launched', { by: req.user.username, via, runId: out.run.id, trials: out.trials, capUsd: out.run.capUsd });
    return out;
  };
  const watch = async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid run id');
    const since = typeof req.query?.since === 'string' && req.query.since ? req.query.since : null;
    return studio.watchRun(pool, id, { since });
  };
  const trialAct = (what) => async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid trial id');
    let out;
    if (what === 'rerun') out = await studio.rerunTrial(pool, id);
    else if (what === 'cancel') out = await require('../services/bench/lane').cancelTrial(pool, id);
    else if (what === 'keep') out = await studio.keepTrial(pool, id, (req.body || {}).keep !== false);
    else out = await studio.deployPreview(pool, config, { trialId: id, user: req.user });
    if (out.ok) log.info('bench', `Studio trial ${what}`, { by: req.user.username, trialId: id });
    return out;
  };
  const createPack = async (req) => {
    const b = req.body || {};
    const out = await packs.create(pool, {
      name: b.name, parentId: b.parentId, guidance: b.guidance, stageGuidance: b.stageGuidance, files: b.files, notes: b.notes,
    }, { actorId: req.user.id });
    if (out.ok) log.info('bench', 'Context pack saved', { by: req.user.username, packId: out.pack.id, name: out.pack.name, version: out.pack.version });
    return out;
  };
  const getPack = async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid pack id');
    return packs.get(pool, id);
  };
  const studioHome = async () => ({
    ok: true,
    runs: await studio.listStudioRuns(pool, { limit: 20 }),
    packs: await packs.list(pool, { limit: 50 }),
    host: await studio.hostRow(pool).then((h) => (h ? { slug: h.slug, status: h.status, repoUrl: h.repo_url } : null)),
    starter: studio.starterBriefs().map((b) => ({ ref: b.ref, appName: b.appName })),
    limits: {
      briefs: studio.MAX_BRIEFS, models: studio.MAX_MODELS, packs: studio.MAX_PACKS, references: studio.MAX_REFERENCES,
      concurrency: studio.MAX_CONCURRENCY, livePreviews: studio.MAX_LIVE_PREVIEWS, previewHours: studio.PREVIEW_HOURS,
    },
  });
  const galleryRead = async (req) => studio.gallery(pool, {
    taskId: idParam(req.query?.taskId), limit: Number(req.query?.limit) || 20,
  });

  // ── The console's Studio place ──────────────────────────────────────

  router.use(CONSOLE, adminMiddleware);
  router.get('/api/admin/homeroom-bot/bench/studio', handler('Studio overview', studioHome));
  router.get('/api/admin/homeroom-bot/bench/studio/gallery', handler('Studio gallery', galleryRead));
  router.get('/api/admin/homeroom-bot/bench/studio/runs/:id/watch', handler('Studio watch', watch));
  router.get('/api/admin/homeroom-bot/bench/studio/packs/:id', handler('Studio pack', getPack));
  router.post('/api/admin/homeroom-bot/bench/studio/launch', requireAdminWrite, handler('Studio launch', launch('console')));
  router.post('/api/admin/homeroom-bot/bench/studio/packs', requireAdminWrite, handler('Studio pack save', createPack));
  router.post('/api/admin/homeroom-bot/bench/studio/trials/:id/rerun', requireAdminWrite, handler('Studio rerun', trialAct('rerun')));
  router.post('/api/admin/homeroom-bot/bench/studio/trials/:id/cancel', requireAdminWrite, handler('Studio cancel', trialAct('cancel')));
  router.post('/api/admin/homeroom-bot/bench/studio/trials/:id/keep', requireAdminWrite, handler('Studio keep', trialAct('keep')));
  router.post('/api/admin/homeroom-bot/bench/studio/trials/:id/preview', requireAdminWrite, handler('Studio preview', trialAct('preview')));

  // ── The admin connector's doors ─────────────────────────────────────
  //
  // Every route: requireAdminWrite first. Every write: then a per-person
  // limiter, then the same-origin browser guard. tests/mcp-connector-policy
  // pins both, route by route.

  // The studio.
  router.get('/api/bot-studio', requireAdminWrite, handler('Studio overview (connector)', studioHome));
  router.get('/api/bot-studio/gallery', requireAdminWrite, handler('Studio gallery (connector)', galleryRead));
  router.get('/api/bot-studio/runs/:id/watch', requireAdminWrite, handler('Studio watch (connector)', watch));
  router.get('/api/bot-studio/runs/:id/reference-order', requireAdminWrite, handler('Studio reference order (connector)', async (req) => {
    const id = idParam(req.params.id);
    const taskId = idParam(req.query?.taskId);
    if (!id || !taskId) return bad('runId and taskId are required');
    return studio.referenceOrder(pool, config, { runId: id, taskId, packId: Number(req.query?.packId) || 0 });
  }));
  router.post('/api/bot-studio/launch', requireAdminWrite, benchRunLimiter, sameOriginBrowserOnly, handler('Studio launch (connector)', launch('connector')));
  router.post('/api/bot-studio/runs/:id/references', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Studio reference (connector)', async (req) => {
    const id = idParam(req.params.id);
    const b = req.body || {};
    const taskId = idParam(b.taskId);
    if (!id || !taskId) return bad('runId and taskId are required');
    const out = await studio.submitReference(pool, config, {
      runId: id, taskId, packId: Number(b.packId) || 0, label: b.label, patch: b.patch || null, repo: b.repo || null,
      branch: b.branch || null, user: req.user,
    });
    if (out.ok) log.info('bench', 'Studio reference handed in', { by: req.user.username, runId: id, taskId, trialId: out.trialId, label: out.label });
    return out;
  }));
  router.post('/api/bot-studio/trials/:id/rerun', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Studio rerun (connector)', trialAct('rerun')));
  router.post('/api/bot-studio/trials/:id/cancel', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Studio cancel (connector)', trialAct('cancel')));
  router.post('/api/bot-studio/trials/:id/keep', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Studio keep (connector)', trialAct('keep')));
  router.post('/api/bot-studio/trials/:id/preview', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Studio preview (connector)', trialAct('preview')));
  router.get('/api/bot-studio/packs', requireAdminWrite, handler('Studio packs (connector)', async () => ({ ok: true, packs: await packs.list(pool, { limit: 50 }) })));
  router.get('/api/bot-studio/packs/:id', requireAdminWrite, handler('Studio pack (connector)', getPack));
  router.post('/api/bot-studio/packs', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Studio pack save (connector)', createPack));

  // The rest of the benchmark: suites and their tasks, a run's trials one
  // by one, one trial in full (its screenshots with `images=1`).
  router.get('/api/bot-studio/suites', requireAdminWrite, handler('Bench suites (connector)', async () => ({
    ok: true,
    suites: (await suites.listSuites(pool)).map((s) => ({
      id: s.id, name: s.name, version: s.version, kind: s.kind, frozen: !!s.frozen_at, notes: s.notes || null,
      counts: s.counts || {}, total: s.total || 0, labelled: s.labelled || 0, runs: s.runs || 0, isDefault: !!s.is_default,
    })),
  })));
  router.get('/api/bot-studio/suites/:id', requireAdminWrite, handler('Bench suite (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid suite id');
    const suite = await suites.suiteRow(pool, id);
    if (!suite) return { ok: false, status: 404, error: 'Suite not found' };
    const tasks = await taste.withInputs(pool, await suites.listTasks(pool, id));
    return {
      ok: true,
      suite: { id: suite.id, name: suite.name, version: suite.version, kind: suite.kind, frozen: !!suite.frozen_at, notes: suite.notes || null },
      tasks: tasks.map((t) => ({
        id: t.id, stage: t.stage, app: t.app_slug || null, issueNumber: t.issue_number ?? null,
        tags: t.tags || {}, labelled: !!t.reference_source, referenceSource: t.reference_source || null,
        taste: t.taste ? { appName: t.taste.appName, brief: t.taste.brief, template: t.taste.template, sha: t.taste.sha, placeholder: !!t.taste.placeholder } : null,
      })),
    };
  }));
  router.post('/api/bot-studio/suites/:id/tasks', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Bench task add (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid suite id');
    const b = req.body || {};
    if (b.kind === 'first_version' || b.kind === 'capture') {
      return taste.addTask(pool, {
        suiteId: id, kind: b.kind, appSlug: b.appSlug, appName: b.appName, brief: b.brief, template: b.template,
        description: b.description, sha: b.sha, ref: b.ref || null,
      });
    }
    if (b.kind === 'runs') {
      const ids = (Array.isArray(b.runIds) ? b.runIds : []).map(idParam).filter(Boolean).slice(0, 50);
      if (!ids.length) return bad('runIds is required');
      const added = [];
      const refused = [];
      for (const runId of ids) {
        // eslint-disable-next-line no-await-in-loop
        const out = await suites.addTaskFromRun(pool, { suiteId: id, runId, stage: b.stage, config });
        if (out.ok) added.push({ runId, taskId: out.task.id, stage: out.task.stage }); else refused.push({ runId, error: out.error });
      }
      return { ok: true, added, refused };
    }
    if (b.kind === 'pr') {
      const out = await suites.importTaskFromPr(pool, { suiteId: id, appSlug: b.appSlug, issueNumber: b.issueNumber, prNumber: b.prNumber, config });
      return out.ok ? { ok: true, taskId: out.task?.id || null, hiddenChecks: out.hiddenChecks ?? null } : out;
    }
    return bad('kind is first_version, capture, runs or pr');
  }));
  router.post('/api/bot-studio/tasks/:id/taste', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Bench task edit (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid task id');
    const b = req.body || {};
    return taste.editTask(pool, { taskId: id, patch: { appName: b.appName, brief: b.brief, template: b.template, description: b.description, sha: b.sha } });
  }));
  router.get('/api/bot-studio/runs/:id/trials', requireAdminWrite, handler('Bench run trials (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid run id');
    return studio.trialRows(pool, id);
  }));
  router.get('/api/bot-studio/trials/:id', requireAdminWrite, handler('Bench trial (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid trial id');
    return studio.trialDetail(pool, id, { images: req.query?.images === '1' });
  }));

  // The Homeroom bot's own data, and a run's rating.
  router.get('/api/bot-studio/bot', requireAdminWrite, handler('Homeroom bot (connector)', async (req) => (
    data.botOverview(pool, config, req.query || {})
  )));
  router.post('/api/bot-studio/bot/runs/:id/rating', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Homeroom bot rating (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid run id');
    const b = req.body || {};
    const has = (key) => Object.prototype.hasOwnProperty.call(b, key);
    return data.rateRun(pool, {
      runId: id, rating: has('rating') ? b.rating : undefined, note: has('note') ? b.note : undefined,
      labelVerdict: has('labelVerdict') ? b.labelVerdict : undefined, actorId: req.user.id,
    });
  }));

  // The recent before/after screenshots (the console's Screenshot gallery).
  router.get('/api/bot-studio/shots', requireAdminWrite, handler('Recent shots (connector)', async (req) => {
    const q = req.query || {};
    const page = await data.recentShots(pool, q);
    if (q.stats === '1') page.stats = (await data.shotStats(pool, q)).stats;
    return page;
  }));
  router.get('/api/bot-studio/shots/:id', requireAdminWrite, handler('Recent shot images (connector)', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid proposal id');
    return data.shotImages(pool, id);
  }));

  return router;
}

module.exports = { benchStudioRoutes, CONSOLE, CONNECTOR_CONFIRM_CAP_USD };

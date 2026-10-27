'use strict';

// Before & after shots EVALS (services/shots-eval.js): the shots agent's
// configurations, the evals that compare them with the live agent on merged
// proposals, their shots, and the blind pairs an admin picks.
//
// The admin connector's doors (services/mcp-tools.js), on its allowlist
// (services/cli-api-policy.js CONNECTOR_ALLOWED_ROUTES). Outside /api/admin
// because a connector can never reach that prefix, and gated like the
// studio's and the bot configurations' doors: requireAdminWrite FIRST on
// every route, reads included, since an eval shows screenshots of any app,
// private ones too; then, on every write, the per-person limiter and the
// same-origin browser guard. None changes an app or a proposal: they save a
// configuration, launch or cancel an eval (which spends the platform's
// money, within its cap), and record a pick.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { requireAdminWrite } = require('../middleware/admin');
const { benchStudioLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const log = require('../services/logger');
const evals = require('../services/shots-eval');

// A launch through the connector over this cap needs `confirmLargeCap`,
// as the benchmark's does (routes/bench-studio.js CONNECTOR_CONFIRM_CAP_USD).
const CONNECTOR_CONFIRM_CAP_USD = 100;

function idParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handler(label, fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent) return undefined;
      if (out && out.ok === false) {
        return res.status(out.status || 400).json({
          error: out.error, ...(out.code ? { code: out.code } : {}), ...(out.refused ? { refused: out.refused } : {}),
        });
      }
      return res.json(out);
    } catch (err) {
      log.error('shots-eval', `${label} failed`, { message: err.message });
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      return undefined;
    }
  };
}

const bad = (error, code) => ({ ok: false, status: 400, error, ...(code ? { code } : {}) });

function shotsEvalRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/shots-evals/configs', requireAdminWrite, handler('Shots configurations', async (req) => (
    evals.listConfigs(pool, config, { prompts: req.query?.prompts === '1' })
  )));
  router.post('/api/shots-evals/configs', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Shots configuration save', async (req) => {
    const b = req.body || {};
    const out = await evals.saveConfig(pool, {
      key: b.key || null, label: b.label || null, recipe: b.recipe, notes: b.notes || null, actorId: req.user.id,
    });
    if (out.ok) log.info('shots-eval', 'Configuration saved', { by: req.user.username, id: out.config.id, key: out.config.key, version: out.config.version });
    return out;
  }));

  router.get('/api/shots-evals/pairs/next', requireAdminWrite, handler('Shots eval pair', async (req) => (
    evals.nextPair(pool, { runId: idParam(req.query?.run), images: req.query?.images !== '0' })
  )));
  router.post('/api/shots-evals/pairs/:token/pick', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Shots eval pick', async (req) => {
    const b = req.body || {};
    const out = await evals.submitPick(pool, {
      token: req.params.token, pick: b.pick, note: b.note || null, marks: b.marks || [], userId: req.user.id,
    });
    if (out.ok) log.info('shots-eval', 'Pair picked', { by: req.user.username });
    return out;
  }));

  router.get('/api/shots-evals', requireAdminWrite, handler('Shots evals', async (req) => (
    evals.listRuns(pool, { limit: req.query?.limit })
  )));
  router.post('/api/shots-evals', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Shots eval launch', async (req) => {
    const b = req.body || {};
    if (!config.shots?.execute) {
      return bad('Before & after shots are not being taken on this deployment, so no eval can run.', 'shots_disabled');
    }
    if (Number(b.capUsd) > CONNECTOR_CONFIRM_CAP_USD && b.confirmLargeCap !== true) {
      return bad(`A cap of $${b.capUsd} is over $${CONNECTOR_CONFIRM_CAP_USD}. Nothing was launched. Confirm that amount with the person, then pass confirmLargeCap.`, 'cap_needs_confirmation');
    }
    const out = await evals.launch(pool, config, {
      sessionIds: b.sessionIds ?? null, sameProposalsAs: b.sameProposalsAs ?? null, configIds: b.configIds || [],
      repeats: b.repeats ?? 1, capUsd: b.capUsd, label: b.label || null, actorId: req.user.id,
    });
    if (out.ok) {
      log.info('shots-eval', 'Eval launched', {
        by: req.user.username, id: out.eval.id, trials: out.eval.trials, capUsd: out.eval.capUsd,
      });
      await evals.look();
    }
    return out;
  }));
  router.get('/api/shots-evals/:id', requireAdminWrite, handler('Shots eval', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid eval id');
    return evals.getRun(pool, id);
  }));
  router.get('/api/shots-evals/:id/shots', requireAdminWrite, handler('Shots eval shots', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid eval id');
    const q = req.query || {};
    return evals.proposalShots(pool, id, {
      sessionId: idParam(q.session),
      change: q.change ? String(q.change).slice(0, 96) : null,
      viewport: q.viewport ? String(q.viewport).slice(0, 32) : null,
      side: q.side || null,
      variant: q.variant || 'context',
      repetition: idParam(q.repetition) || 1,
      published: q.published !== '0',
    });
  }));
  router.post('/api/shots-evals/:id/cancel', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Shots eval cancel', async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid eval id');
    const out = await evals.cancelRun(pool, id, { userId: req.user.id });
    if (out.ok) {
      log.info('shots-eval', 'Eval cancelled', { by: req.user.username, id, trials: out.cancelled });
    }
    return out;
  }));

  return router;
}

module.exports = { shotsEvalRoutes, CONNECTOR_CONFIRM_CAP_USD };

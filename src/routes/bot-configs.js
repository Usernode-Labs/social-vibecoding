'use strict';

// The Homeroom bot's CONFIGURATIONS (services/bot-configs.js), for first
// versions and for later changes (each a scope): their versions, roles and
// numbers, each scope's side builds' weekly budget, and the blind pairs an
// admin picks. A scope omitted is `first_version`, as before scopes.
//
// Two doors onto the same service, as routes/bench-studio.js has them:
//
//   /api/admin/homeroom-bot/configs…   the console's "Bot configurations"
//       section (frontend/src/features/admin/admin-bot-configs.tsx), one
//       scope at a time (?scope=). Any admin reads; a role change and a
//       side-build budget are requireAdminWrite. Recipes are written only
//       through the connector.
//
//   /api/bot-configs…   the admin connector's (services/mcp-tools.js), on
//       its allowlist (services/cli-api-policy.js CONNECTOR_ALLOWED_ROUTES).
//       Outside /api/admin because a connector can never reach that prefix,
//       and gated like the studio's doors: requireAdminWrite FIRST on every
//       route, reads included, since a pair shows screenshots of any app,
//       private ones too; then, on every write, the per-person limiter and
//       the same-origin browser guard.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { benchStudioLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const log = require('../services/logger');
const configs = require('../services/bot-configs');

const CONSOLE = '/api/admin/homeroom-bot/configs';

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
        return res.status(out.status || 400).json({ error: out.error, ...(out.code ? { code: out.code } : {}) });
      }
      return res.json(out);
    } catch (err) {
      log.error('bot-configs', `${label} failed`, { message: err.message });
      if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
      return undefined;
    }
  };
}

const bad = (error) => ({ ok: false, status: 400, error });

function botConfigRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  const setRole = (via) => async (req) => {
    const id = idParam(req.params.id);
    if (!id) return bad('Invalid configuration version id');
    const b = req.body || {};
    const out = await configs.setRole(pool, { id, role: b.role, scope: b.scope || null });
    if (out.ok) log.info('bot-configs', 'Configuration role set', { by: req.user.username, via, id, role: out.version.role, scope: out.version.scope, demoted: out.demoted });
    return out;
  };
  const setBudget = (via) => async (req) => {
    const b = req.body || {};
    const out = await configs.setSideWeeklyBudget(pool, { scope: b.scope || null, weeklyUsd: b.weeklyUsd, actorId: req.user.id });
    if (out.ok) log.info('bot-configs', 'Side builds\' weekly budget set', { by: req.user.username, via, scope: out.scope, limitUsd: out.sideBuilds.limitUsd });
    return out;
  };
  // A pair's diff summary is read from GitHub when it can be (a later change's).
  const github = () => {
    const gh = require('../services/github');
    return gh.isEnabled() ? gh : null;
  };

  // ── The console's section ───────────────────────────────────────────

  router.use(CONSOLE, adminMiddleware);
  router.get('/api/admin/homeroom-bot/configs', handler('Bot configurations', async (req) => (
    configs.listWithStats(pool, { scope: req.query?.scope || null })
  )));
  router.post('/api/admin/homeroom-bot/configs/budget', requireAdminWrite, handler('Bot configuration side budget', setBudget('console')));
  router.post('/api/admin/homeroom-bot/configs/:id/role', requireAdminWrite, handler('Bot configuration role', setRole('console')));

  // ── The admin connector's doors ─────────────────────────────────────

  router.get('/api/bot-configs', requireAdminWrite, handler('Bot configurations (connector)', async () => configs.listAllScopes(pool)));
  router.post('/api/bot-configs', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Bot configuration save (connector)', async (req) => {
    const b = req.body || {};
    const out = await configs.saveVersion(pool, {
      key: b.key || null, label: b.label || null, recipe: b.recipe, role: b.role || 'side', notes: b.notes || null, actorId: req.user.id,
      scope: b.scope || null,
    });
    if (out.ok) log.info('bot-configs', 'Configuration saved', { by: req.user.username, id: out.version.id, key: out.version.key, role: out.version.role, scope: out.version.scope });
    return out;
  }));
  router.post('/api/bot-configs/budget', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Bot configuration side budget (connector)', setBudget('connector')));
  router.post('/api/bot-configs/:id/role', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Bot configuration role (connector)', setRole('connector')));
  router.get('/api/bot-configs/pairs/next', requireAdminWrite, handler('Bot configuration pair (connector)', async (req) => (
    configs.nextPair(pool, { images: req.query?.images === '1', scope: req.query?.scope || null, github: github() })
  )));
  router.post('/api/bot-configs/pairs/:token/pick', requireAdminWrite, benchStudioLimiter, sameOriginBrowserOnly, handler('Bot configuration pick (connector)', async (req) => {
    const b = req.body || {};
    const out = await configs.submitPick(pool, {
      pairId: req.params.token, pick: b.pick, note: b.note || null, userId: req.user.id, scope: b.scope || null,
    });
    if (out.ok) log.info('bot-configs', 'Pair picked', { by: req.user.username, scope: b.scope || 'first_version' });
    return out;
  }));

  return router;
}

module.exports = { botConfigRoutes, CONSOLE };

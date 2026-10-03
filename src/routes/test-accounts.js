'use strict';

// Test accounts (services/test-accounts.js), for a full platform admin's
// connector session: create_test_account, list_test_accounts and
// retire_test_account in services/mcp-tools.js.
//
// They live at their own prefix, outside /api/admin and /api/auth, because a
// connector token can reach neither (services/cli-api-policy.js) — the same
// reason /api/bot-bench/* does. What earns them a place on the connector
// allowlist is the gate every handler puts first, which
// tests/mcp-connector-policy.test.js pins: requireAdminWrite (a full admin,
// never a view-only one), then the per-admin limiter, then the same-origin
// browser guard. No path here has a `password` segment, and none may: the
// policy denies any path that does.
//
// The one-time password rides back in the create response and nowhere else:
// it is not logged, not stored in plain text, and the response is no-store.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { requireAdminWrite } = require('../middleware/admin');
const { testAccountLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const log = require('../services/logger');
const testAccounts = require('../services/test-accounts');

function idParam(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// A service refusal answers with its own status, sentence and code; anything
// else is logged and answered as a 500. The sentence and code never carry a
// password: the service only ever puts one in a successful create.
function handler(label, fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (err) {
      if (err instanceof testAccounts.TestAccountError) {
        if (!res.headersSent) res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
        return;
      }
      log.error('test-accounts', `${label} failed`, { message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function testAccountRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.post('/api/test-accounts', requireAdminWrite, testAccountLimiter, sameOriginBrowserOnly, handler('Create test account', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const account = await testAccounts.create(pool, req.body || {}, { actorId: req.user.id, config });
    return { account };
  }));

  router.get('/api/test-accounts', requireAdminWrite, testAccountLimiter, sameOriginBrowserOnly, handler('List test accounts', async () => ({
    accounts: await testAccounts.list(pool),
    max: testAccounts.MAX_LIVE,
  })));

  router.post('/api/test-accounts/:id/retire', requireAdminWrite, testAccountLimiter, sameOriginBrowserOnly, handler('Retire test account', async (req) => {
    const userId = idParam(req.params.id);
    if (!userId) throw new testAccounts.TestAccountError(400, 'invalid_request', 'Invalid account id.');
    const retired = await testAccounts.retire(pool, {
      userId, confirmation: req.body && req.body.confirm,
    }, { actorId: req.user.id, config });
    return { retired };
  }));

  return router;
}

module.exports = { testAccountRoutes };

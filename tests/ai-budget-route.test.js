// #555: GET /api/me/ai-budget — the viewer's own daily AI allowance.
//
// Two properties matter beyond "it returns numbers":
//
//   1. It must return FULL figures when the cap is exhausted. The old
//      checkBudget() collapses to `{ error }` there, which is precisely
//      the state the drawer most needs to render ("Daily limit reached",
//      or "Using your own key"). getBudgetSnapshot must not inherit that.
//   2. It must carry NO global spend or global cap. services/status.js
//      redact() treats those as admin-only, and this is the one endpoint
//      every signed-in user polls.
//
// Run with: node --test tests/ai-budget-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Stubbed pool: one users+llm_usage row, plus the platform-default limit
// out of platform_settings.
const poolMod = require('../src/db/pool');
let row = {
  daily_limit_cents: null,
  total_cost_cents: 0,
  byok_cost_cents: 0,
  has_byok_key: false,
};
poolMod.getPool = () => ({
  async query(sql, params) {
    if (/SELECT value FROM platform_settings WHERE key/.test(sql)) {
      return params[0] === 'user_daily_limit_cents'
        ? { rows: [{ value: '2000' }] }
        : { rows: [] };
    }
    if (/SELECT daily_limit_cents FROM users/.test(sql)) {
      return { rows: [{ daily_limit_cents: row.daily_limit_cents }] };
    }
    if (/LEFT JOIN llm_usage/.test(sql)) {
      return {
        rows: [{
          total_cost_cents: row.total_cost_cents,
          byok_cost_cents: row.byok_cost_cents,
          has_byok_key: row.has_byok_key,
        }],
      };
    }
    return { rows: [] };
  },
});

const limits = require('../src/services/limits');
const { authRoutes } = require('../src/routes/auth');
const express = require('express');

let server;
let base;
let currentUser = { id: 7, username: 'ada' };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(authRoutes({ jwtSecret: 'test', dataEncryptionKey: 'x'.repeat(64) }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  limits.invalidate();
  currentUser = { id: 7, username: 'ada' };
  row = {
    daily_limit_cents: null,
    total_cost_cents: 0,
    byok_cost_cents: 0,
    has_byok_key: false,
  };
});

test('anonymous callers get 401', async () => {
  currentUser = null;
  const res = await fetch(`${base}/api/me/ai-budget`);
  assert.equal(res.status, 401);
});

test('returns the platform default cap with nothing spent', async () => {
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.limitCents, 2000);
  assert.equal(r.spentCents, 0);
  assert.equal(r.remainingCents, 2000);
  assert.equal(r.hasByokKey, false);
  assert.match(r.resetsAt, /T00:00:00\.000Z$/, 'resets at midnight UTC, not local');
});

test('a per-user override wins over the platform default', async () => {
  row.daily_limit_cents = 12000;
  row.total_cost_cents = 2500;
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.limitCents, 12000, 'the user’s own granted cap, not the default');
  assert.equal(r.remainingCents, 9500);
});

test('an exhausted cap still returns full figures, not an error', async () => {
  row.total_cost_cents = 5000; // over the 2000 cap
  const res = await fetch(`${base}/api/me/ai-budget`);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.error, undefined, 'checkBudget’s { error } shape must not leak here');
  assert.equal(r.limitCents, 2000);
  assert.equal(r.spentCents, 5000);
  assert.equal(r.remainingCents, 0, 'clamped, never negative');
});

test('BYOK spend is reported but never subtracted from the allowance', async () => {
  row.total_cost_cents = 500;
  row.byok_cost_cents = 9999;
  row.has_byok_key = true;
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.byokCents, 9999);
  assert.equal(r.hasByokKey, true);
  assert.equal(r.remainingCents, 1500, 'only platform-billed spend counts against the cap');
});

test('the payload carries no global spend or global cap', async () => {
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  for (const k of Object.keys(r)) {
    assert.ok(!/^global/i.test(k), `unexpected admin-only field ${k}`);
  }
  assert.deepEqual(Object.keys(r).sort(), [
    'byokCents', 'hasByokKey', 'limitCents', 'remainingCents', 'resetsAt', 'spentCents',
  ]);
});

test('no API key material is ever returned, only its presence', async () => {
  row.has_byok_key = true;
  const body = await fetch(`${base}/api/me/ai-budget`).then((x) => x.text());
  assert.ok(!/anthropic_key|last4|sk-ant/.test(body));
});

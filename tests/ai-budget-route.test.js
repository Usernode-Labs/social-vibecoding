// #555: GET /api/me/ai-budget — the viewer's own AI allowance, which
// since #2571 is one weekly figure for the whole account.
//
// Two properties matter beyond "it returns numbers":
//
//   1. It must return FULL figures when the cap is exhausted. The old
//      checkBudget() collapses to `{ error }` there, which is precisely
//      the state the drawer most needs to render ("Weekly limit reached",
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
  // NULL means "platform default" on either column. #2571: the weekly
  // default is the one that matters — it is the account's only cap — and
  // the stub below serves it from platform_settings as $50.
  weekly_limit_cents: null,
  weekly_spent_cents: 0,
  weekly_byok_cents: 0,
  total_cost_cents: 0,
  byok_cost_cents: 0,
  has_byok_key: false,
};
poolMod.getPool = () => ({
  async query(sql, params) {
    if (/SELECT value FROM platform_settings WHERE key/.test(sql)) {
      if (params[0] === 'user_daily_limit_cents') return { rows: [{ value: '2000' }] };
      if (params[0] === 'user_weekly_limit_cents') return { rows: [{ value: '5000' }] };
      return { rows: [] };
    }
    if (/SELECT daily_limit_cents(?:, weekly_limit_cents)? FROM users/.test(sql)) {
      return {
        rows: [{
          daily_limit_cents: row.daily_limit_cents,
          weekly_limit_cents: row.weekly_limit_cents,
        }],
      };
    }
    if (/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/.test(sql)) {
      return { rows: [{ total: row.weekly_spent_cents, byok: row.weekly_byok_cents }] };
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
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  server.unref();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (!server) return;
  // Node's global fetch keeps HTTP/1.1 sockets alive. Close them explicitly
  // so server close cannot strand the test runner after all
  // assertions have passed.
  server.close();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
});

test.beforeEach(() => {
  limits.invalidate();
  currentUser = { id: 7, username: 'ada' };
  row = {
    daily_limit_cents: null,
    weekly_limit_cents: null,
    weekly_spent_cents: 0,
    weekly_byok_cents: 0,
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
  assert.equal(r.limitCents, 5000, 'the $50 weekly default');
  assert.equal(r.spentCents, 0);
  assert.equal(r.remainingCents, 5000);
  assert.equal(r.hasByokKey, false);
  assert.match(r.resetsAt, /T00:00:00\.000Z$/, 'resets at a UTC midnight, not local');
  assert.equal(new Date(r.resetsAt).getUTCDay(), 1, 'and it is a Monday');
});

test('a per-user override wins over the platform default', async () => {
  row.weekly_limit_cents = 12000;
  row.weekly_spent_cents = 2500;
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.limitCents, 12000, 'the user’s own granted cap, not the default');
  assert.equal(r.remainingCents, 9500);
});

test('an exhausted cap still returns full figures, not an error', async () => {
  row.weekly_spent_cents = 7000; // over the 5000 cap
  const res = await fetch(`${base}/api/me/ai-budget`);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.error, undefined, 'checkBudget’s { error } shape must not leak here');
  assert.equal(r.limitCents, 5000);
  assert.equal(r.spentCents, 7000);
  assert.equal(r.remainingCents, 0, 'clamped, never negative');
});

test('BYOK spend is reported but never subtracted from the allowance', async () => {
  row.weekly_spent_cents = 500;
  row.weekly_byok_cents = 9999;
  row.has_byok_key = true;
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.byokCents, 9999, 'and over the same week the allowance covers');
  assert.equal(r.hasByokKey, true);
  assert.equal(r.remainingCents, 4500, 'only platform-billed spend counts against the cap');
});

test('the payload carries no global spend or global cap', async () => {
  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  for (const k of Object.keys(r)) {
    assert.ok(!/^global/i.test(k), `unexpected admin-only field ${k}`);
  }
  // lowBalancePct joined the payload in #593: the client warns at a
  // threshold, and the threshold is the server's to declare (limits.
  // LOW_BALANCE_PCT) rather than a number retyped in the browser. It is a
  // constant, not a fact about this user, so it discloses nothing.
  //
  // #1788 added the window fields: which of the two caps the three legacy
  // figures describe, plus the per-window breakdown behind them. All of it
  // is about THIS user's own allowance, so the admin-only rule above is
  // untouched.
  //
  // #838 added identityTier (which tier this user's weekly cap follows)
  // and weeklySource (override, tier value, or the base default): both
  // describe this user's own allowance, nothing platform-wide.
  assert.deepEqual(Object.keys(r).sort(), [
    'byokCents', 'capWindow', 'creditPolicy', 'dailyApplies',
    'dailyLimitCents', 'dailySpentCents', 'entitlementAvailable',
    'hasByokKey', 'identityTier', 'limitCents', 'limitSource', 'lowBalancePct',
    'remainingCents', 'resetLabel', 'resetsAt', 'spentCents', 'tier',
    'tierLimitCents', 'verificationRequired', 'weeklyApplies',
    'weeklyLimitCents', 'weeklySource', 'weeklySpentCents', 'windowLabel',
  ]);
});

test('no API key material is ever returned, only its presence', async () => {
  row.has_byok_key = true;
  const body = await fetch(`${base}/api/me/ai-budget`).then((x) => x.text());
  assert.ok(!/anthropic_key|last4|sk-ant/.test(body));
});

// ── #2571: one window, one set of headline figures ──────────────────────
//
// The client reads limitCents / spentCents / remainingCents and nothing
// else to draw the meter, the drawer row and the low-balance banner. #1788
// made those describe whichever of two caps was binding; this issue
// switches the per-user daily cap off, so they always describe the WEEK —
// and the payload says so, so the copy around them names the right
// boundary.

test('the headline figures always describe the week', async () => {
  row.daily_limit_cents = 2000;   // still stored, no longer enforced
  row.total_cost_cents = 300;     // today's share of the week's spend
  row.weekly_limit_cents = 5000;  // $50/week, $2 of it left
  row.weekly_spent_cents = 4800;
  row.has_byok_key = false;

  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.capWindow, 'weekly');
  assert.equal(r.limitCents, 5000);
  assert.equal(r.spentCents, 4800);
  assert.equal(r.remainingCents, 200);
  assert.equal(r.windowLabel, 'This week');
  assert.equal(r.resetLabel, 'Monday 00:00 UTC');
  assert.equal(new Date(r.resetsAt).getUTCDay(), 1, 'and resets on a Monday');

  // The daily breakdown is still reported — the setting exists and the
  // admin console reads it — but it is explicitly not in force.
  assert.equal(r.dailyApplies, false);
  assert.equal(r.dailyLimitCents, 2000);
  assert.equal(r.dailySpentCents, 300);
  assert.equal(r.weeklyApplies, true);
  assert.equal(r.weeklyLimitCents, 5000);
  assert.equal(r.weeklySpentCents, 4800);
});

test('a day spent past the stored daily cap never becomes the headline', async () => {
  row.daily_limit_cents = 2000;
  row.total_cost_cents = 3900;    // far past the stored daily figure
  row.weekly_limit_cents = 5000;
  row.weekly_spent_cents = 3900;  // $11 left this week

  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.capWindow, 'weekly', 'never "daily" — that window is off');
  assert.equal(r.limitCents, 5000);
  assert.equal(r.remainingCents, 1100);
  assert.equal(r.windowLabel, 'This week');
  assert.equal(r.resetLabel, 'Monday 00:00 UTC');
  assert.equal(r.dailyApplies, false);
});

// The trap this one guards: public/js/credit-options.js maps
// limitCents === 0 to the red "exhausted" state. A user whose stored DAILY
// figure is 0, and who has a perfectly healthy weekly allowance, must not
// be told they are out of credits.
test('a zero stored daily cap never reaches the client as a zero limit', async () => {
  row.daily_limit_cents = 0;
  row.total_cost_cents = 4000;
  row.weekly_limit_cents = 12500;
  row.weekly_spent_cents = 4000;

  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.dailyApplies, false);
  assert.equal(r.capWindow, 'weekly');
  assert.equal(r.limitCents, 12500, 'the weekly cap is the only one there is');
  assert.equal(r.spentCents, 4000);
  assert.equal(r.remainingCents, 8500);
  assert.notEqual(r.limitCents, 0);
});

test('with no weekly cap in force the payload says so rather than inventing one', async () => {
  row.daily_limit_cents = 0;
  row.total_cost_cents = 0;
  row.weekly_limit_cents = 0;
  row.weekly_spent_cents = 0;

  const r = await fetch(`${base}/api/me/ai-budget`).then((x) => x.json());
  assert.equal(r.dailyApplies, false);
  assert.equal(r.weeklyApplies, false);
  assert.equal(r.capWindow, 'none');
  // This is a display route, not a gate — it reports the state and lets
  // checkBudget do the refusing (reason: 'no_allowance').
  assert.equal(r.limitCents, 0);
});

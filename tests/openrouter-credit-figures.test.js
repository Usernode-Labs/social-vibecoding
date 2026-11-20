'use strict';

// Credit is the ACCOUNT's credit; the bot key's remaining is its weekly
// budget (src/services/openrouter-credit.js).
//
// On 20 Nov 2026 production said "OpenRouter credit: $500 left, about 12
// days" and warned that credit was below $500, with $1,923.86 in the
// account: the figure was the lower of the account's credit and what was
// left of the bot key's $800 week. These tests enter where that figure is
// read: OpenRouter's own answers to GET /credits and GET /key, through the
// real management and key clients and the real credential store, with only
// `fetch` stubbed. Homeroom's own ledger (limits.js) and the admins' alerts
// are handed in, each at its own module's edge.
//
// Run with: node --test tests/openrouter-credit-figures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// changed() tells every admin socket through ws.broadcastToAdmins; stand in
// for it before anything requires it.
const wsPath = require.resolve('../src/services/ws');
const broadcasts = [];
require.cache[wsPath] = {
  id: wsPath, filename: wsPath, loaded: true,
  exports: { broadcastToAdmins: (payload) => { broadcasts.push(payload); return 0; } },
};

const credit = require('../src/services/openrouter-credit');
const view = require('../src/services/platform-limits-view');
const alerts = require('../src/services/platform-limit-alerts');
const { encrypt } = require('../src/services/secrets');

const DATA_KEY = 'test-data-encryption-key-for-credit-figures';
const BASE = 'https://openrouter.test/api/v1';
const CONFIG = {
  dataEncryptionKey: DATA_KEY,
  openrouterApiBase: BASE,
  openrouterOrigin: 'https://homeroom.test',
  openrouterManagementApiKey: 'mgmt-test-key',
};
const NO_MANAGEMENT = { ...CONFIG, openrouterManagementApiKey: '' };
const BOT_KEY = 'sk-or-v1-test-bot-key';
const BOT_ID = 7;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const collapse = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/**
 * A database holding what these paths read: the platform settings (the
 * stored credit state among them), the bot's users row, its OpenRouter
 * credential as the credential store keeps it (really encrypted), and the
 * platform_limit_alerts row a limit's level lives in. Anything else (an
 * incident's event row) is accepted and kept in `other`.
 */
function database({ state = null, bot = true } = {}) {
  const settings = new Map();
  if (state) settings.set(credit.KEY_STATE, JSON.stringify(state));
  const levels = new Map();
  const other = [];
  return {
    settings, levels, other,
    stateNow() { return JSON.parse(settings.get(credit.KEY_STATE) || 'null'); },
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/^INSERT INTO platform_settings/.test(sql)) {
        // The staging seed names its key in the statement; every other writer passes it.
        const named = /VALUES \('([a-z_]+)', \$1/.exec(sql);
        if (named) settings.set(named[1], params[0]);
        else settings.set(params[0], params[1]);
        return { rows: [] };
      }
      if (/FROM platform_settings/.test(sql)) {
        const keys = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      if (/FROM users WHERE username = \$1 AND is_synthetic = TRUE/.test(sql)) return { rows: bot ? [{ id: BOT_ID }] : [] };
      // credential-store.js readMetadata, then readSecret.
      if (/FROM credentials\.user_ai_credentials/.test(sql)) {
        if (!bot) return { rows: [] };
        return { rows: [{
          id: 1, provider: 'openrouter', purpose: 'coding_agent', secret_last4: 'tkey', status: 'valid', revision: 3,
          metadata: { source: 'usernode_managed' }, secret_enc: encrypt(BOT_KEY, DATA_KEY),
        }] };
      }
      // platform-limit-alerts.js evaluate: the level's row, locked and written.
      if (/^INSERT INTO platform_limit_alerts/.test(sql)) {
        if (!levels.has(params[0])) levels.set(params[0], { level: 'ok', used: null, cap: null, measured_at: null, detail: null });
        return { rows: [] };
      }
      if (/FROM platform_limit_alerts WHERE limit_key = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ level: levels.get(params[0]).level, window_ms: null }] };
      }
      if (/^UPDATE platform_limit_alerts/.test(sql)) {
        levels.set(params[0], {
          level: params[1], used: params[2], cap: params[3], measured_at: new Date().toISOString(),
          detail: params[6] ? JSON.parse(params[6]) : null,
        });
        return { rows: [] };
      }
      other.push(sql);
      return { rows: [] };
    },
  };
}

/**
 * OpenRouter, at `fetch`: GET /credits answers the account's totals to the
 * management key, GET /key the bot key's own limit. `answers` is mutable, so
 * a test moves the figures between reads; `null` for either is a 500.
 */
function openrouter(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    const auth = String(init.headers?.Authorization || '');
    calls.push({ path: pathname, auth });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/v1/credits') {
      assert.equal(auth, 'Bearer mgmt-test-key', 'the account is read with the management key');
      if (!answers.credits) return json(500, { error: { message: 'unavailable' } });
      return json(200, { data: { total_credits: answers.credits.total, total_usage: answers.credits.used } });
    }
    if (pathname === '/api/v1/key') {
      assert.equal(auth, `Bearer ${BOT_KEY}`, 'the key is read with the bot\'s own key');
      if (!answers.key) return json(500, { error: { message: 'unavailable' } });
      return json(200, { data: {
        label: 'sk-or-v1-tes...key', limit: answers.key.limit, limit_remaining: answers.key.remaining,
        limit_reset: answers.key.reset === undefined ? 'weekly' : answers.key.reset, usage: 0,
      } });
    }
    throw new Error(`unexpected request to OpenRouter: ${pathname}`);
  };
  return { calls, fetchImpl };
}

async function withOpenRouter(answers, fn) {
  const real = global.fetch;
  const or = openrouter(answers);
  global.fetch = or.fetchImpl;
  try {
    return await fn(or);
  } finally {
    global.fetch = real;
  }
}

/** What the admins were told (createPlatformIncidentNotifications), at notifications.js's edge. */
function admins() {
  const told = [];
  return {
    told,
    notifications: () => ({
      async createPlatformIncidentNotifications(_pool, args) { told.push(args.detail); return []; },
      async hydrateAndPush() {},
    }),
  };
}

/** Homeroom's own count of the bot's week and its weekly cap, at limits.js's edge. */
const ledger = (spentCents, capCents = 80000) => ({
  getEffectiveUserWeeklyLimitCents: async () => capCents,
  getWeeklySpentCents: async () => spentCents,
});

const noWake = () => ({ async botCreditBack() {} });

// ── 1. Production on 20 Nov: a weekly key with $499.96 left, $1,923.86 in the account ──

test('a weekly key with $500 left and $1,900 in the account: no credit warning, the budget measured at 37% and no row', async () => {
  // The state production held: the lower figure as `balanceCents`, and the
  // false "below $500" warning already said (low disarmed).
  const db = database({ state: {
    balanceCents: 49996, accountCents: 192386, keyCents: 49996, dailyCents: 4021,
    at: new Date(Date.now() - 15 * MIN).toISOString(), armed: { low: false, urgent: true }, outage: null,
  } });
  const { told, notifications } = admins();
  await withOpenRouter({ credits: { total: 5000, used: 3076.14 }, key: { limit: 800, remaining: 499.96 } }, async (or) => {
    const out = await credit.sweep(db, CONFIG, { staging: false, notifications, platform: noWake });
    assert.deepEqual(or.calls.map((c) => c.path), ['/api/v1/credits', '/api/v1/key']);
    assert.deepEqual(out.events, [], 'nothing to say: the account has $1,923.86');
    assert.equal(out.creditCents, 192386, 'credit is the account\'s credit');
    assert.equal(out.spendableCents, 49996, 'what the bot can spend is the lower figure, kept for the pause only');
  });
  assert.deepEqual(told, [], 'no "credit is below $500" notice');
  const state = db.stateNow();
  assert.deepEqual(state.armed, { low: true, urgent: true }, 'the false warning is re-armed: credit is above both lines');
  assert.deepEqual([state.creditCents, state.creditSource, state.keyCents, state.keyLimitCents, state.keyReset],
    [192386, 'account', 49996, 80000, 'weekly']);
  assert.equal('balanceCents' in state, false, 'the lower-of-the-two figure is no longer kept under that name');
  assert.equal('dailyCents' in state, false);

  const status = await credit.status(db);
  assert.equal(status.creditCents, 192386);
  assert.equal(status.keyUsedCents, 30004, 'OpenRouter counts $300.04 of the week used');
  assert.equal(view.creditRow(status), null, 'no credit row');

  // The weekly budget: OpenRouter's $300.04 runs ahead of Homeroom's $281.47.
  const measured = await credit.budget(db, { limits: ledger(28147) });
  assert.deepEqual([measured.used, measured.cap], [30004, 80000]);
  assert.deepEqual(
    (({ source, openrouterUsedCents, homeroomUsedCents, refused }) => ({ source, openrouterUsedCents, homeroomUsedCents, refused }))(measured.detail),
    { source: 'openrouter', openrouterUsedCents: 30004, homeroomUsedCents: 28147, refused: false },
  );
  assert.equal(new Date(measured.detail.resetsAt).getUTCDay(), 1, 'the week turns on a Monday');
  assert.equal(Math.floor((measured.used / measured.cap) * 100), 37);

  // As a platform limit: under 80%, so no level, no notice and no row.
  const created = [];
  const result = await alerts.evaluate(db, {}, 'bot_budget', {
    staging: false, measure: { limits: ledger(28147) },
    create: async (_db, args) => { created.push(args.detail); return []; }, publish: async () => {},
  });
  assert.equal(result.level, 'ok');
  assert.deepEqual(created, []);
  assert.equal(view.capacityRow('bot_budget', db.levels.get('bot_budget'), { percent: 80 }), null, 'the row shows only from 80% used');
});

test('the budget row and its notice come at 80%, from whichever count is further along', async () => {
  const db = database();
  const { notifications } = admins();
  await withOpenRouter({ credits: { total: 5000, used: 3076.14 }, key: { limit: 800, remaining: 152 } }, async () => {
    await credit.sweep(db, CONFIG, { staging: false, notifications, platform: noWake });
  });
  const created = [];
  const deps = {
    staging: false, measure: { limits: ledger(61000) },
    create: async (_db, args) => { created.push(args.detail); return []; }, publish: async () => {},
  };
  const warn = await alerts.evaluate(db, {}, 'bot_budget', deps);
  assert.deepEqual([warn.level, warn.used, warn.cap], ['warn', 64800, 80000], 'OpenRouter\'s $648 of $800: 81%');
  assert.deepEqual(created, ['bot_budget_warn:64800:80000']);
  await alerts.evaluate(db, {}, 'bot_budget', deps);
  assert.equal(created.length, 1, 'still near: one notice a crossing');
  const row = view.capacityRow('bot_budget', db.levels.get('bot_budget'), { percent: 80 });
  assert.deepEqual([row.key, row.state, row.percent], ['bot_budget', 'near', 81]);
  assert.equal(row.detail.usedCents, 64800);
  assert.equal(new Date(row.detail.resetsAt).getUTCDay(), 1);
  assert.equal('daysLeft' in row, false, 'an allowance that resets never gets a days estimate');

  // Homeroom's own count further along than OpenRouter's is the one said.
  const own = await credit.budget(db, { limits: ledger(70000) });
  assert.deepEqual([own.used, own.detail.source], [70000, 'homeroom']);
});

// ── 2. The $500 and $200 lines are the account's ────────────────────────

test('account credit under the lines: the warnings are on the account\'s figure, whatever is left of the key', async () => {
  const db = database();
  const { told, notifications } = admins();
  const deps = { staging: false, notifications, platform: noWake };
  const answers = { credits: { total: 5000, used: 4520 }, key: { limit: 800, remaining: 700 } };
  await withOpenRouter(answers, async () => {
    let out = await credit.sweep(db, CONFIG, deps);
    assert.deepEqual(out.events.map((e) => [e.type, e.thresholdCents, e.balanceCents]), [['low', 50000, 48000]]);
    assert.deepEqual(told, ['credit:low:500:480:0'], 'the account\'s $480, with no days estimate before a day of readings');
    // Lower still, but the same level: said once.
    answers.credits.used = 4600;
    out = await credit.sweep(db, CONFIG, deps);
    assert.deepEqual(out.events, []);
    answers.credits.used = 4816;
    out = await credit.sweep(db, CONFIG, deps);
    assert.deepEqual(out.events.map((e) => [e.type, e.thresholdCents, e.balanceCents]), [['urgent', 20000, 18400]]);
  });
  assert.equal(told[1], 'credit:urgent:200:184:0');
  const row = view.creditRow(await credit.status(db));
  assert.deepEqual([row.state, row.urgent, row.balanceCents], ['near', true, 18400], 'the row is the account\'s credit');
});

test('a key nearly spent is not low credit', async () => {
  const db = database();
  const { told, notifications } = admins();
  await withOpenRouter({ credits: { total: 5000, used: 3100 }, key: { limit: 800, remaining: 150 } }, async () => {
    const out = await credit.sweep(db, CONFIG, { staging: false, notifications, platform: noWake });
    assert.deepEqual(out.events, []);
  });
  assert.deepEqual(told, []);
  assert.equal(view.creditRow(await credit.status(db)), null);
});

// ── 3. Without a management key ─────────────────────────────────────────

test('no management key: the account cannot be read, an allowance is not credit, and no row stands for ever', async () => {
  const db = database();
  const { told, notifications } = admins();
  await withOpenRouter({ credits: null, key: { limit: 800, remaining: 120 } }, async (or) => {
    const out = await credit.sweep(db, NO_MANAGEMENT, { staging: false, notifications, platform: noWake });
    assert.deepEqual(or.calls.map((c) => c.path), ['/api/v1/key'], 'only the key is asked');
    assert.deepEqual(out.events, []);
    assert.equal(out.creditCents, null);
    assert.equal(out.spendableCents, 12000);
  });
  assert.deepEqual(told, [], 'no warning: $120 of a weekly key is not $120 of credit');
  const status = await credit.status(db);
  assert.deepEqual([status.creditCents, status.management, status.keyUsedCents], [null, false, 68000]);
  assert.equal(view.creditRow(status), null, 'no "couldn\'t check" row');
  // Even with a figure from before the key was taken away.
  assert.equal(view.creditRow({ ...status, creditCents: 41200, creditAt: status.at, creditSource: 'account', creditRead: false }), null);
  // The budget is still measured: it needs only the key.
  const measured = await credit.budget(db, { limits: ledger(50000) });
  assert.deepEqual([measured.used, measured.cap, measured.detail.source], [68000, 80000, 'openrouter']);
});

test('a deploy with no management key and no bot key has nothing to read, and what is stored stands', async () => {
  const stored = { accountCents: 18400, creditCents: 18400, creditAt: '2026-11-20T12:00:00.000Z', at: '2026-11-20T12:00:00.000Z', armed: { low: false, urgent: false }, outage: null };
  const db = database({ state: stored, bot: false });
  await withOpenRouter({ credits: null, key: null }, async (or) => {
    await credit.sweep(db, NO_MANAGEMENT, { staging: true, platform: noWake });
    assert.deepEqual(or.calls, [], 'nothing is asked');
  });
  assert.deepEqual(db.stateNow(), stored);
});

test('a capped key that never resets stands in for the account\'s credit', async () => {
  const db = database();
  const { told, notifications } = admins();
  await withOpenRouter({ credits: null, key: { limit: 1000, remaining: 150, reset: null } }, async () => {
    const out = await credit.sweep(db, NO_MANAGEMENT, { staging: false, notifications, platform: noWake });
    assert.deepEqual(out.events.map((e) => e.type), ['low', 'urgent'], 'prepaid credit in effect: $150 is under both lines');
    assert.equal(out.creditCents, 15000);
  });
  assert.deepEqual(told, ['credit:low:500:150:0', 'credit:urgent:200:150:0']);
  const status = await credit.status(db);
  assert.deepEqual([status.creditSource, status.management, status.keyReset], ['key', false, null]);
  const row = view.creditRow(status);
  assert.deepEqual([row.state, row.urgent, row.balanceCents], ['near', true, 15000]);
  assert.deepEqual(await credit.budget(db, { limits: { getEffectiveUserWeeklyLimitCents: async () => 0, getWeeklySpentCents: async () => 0 } }),
    { used: 0, cap: 0, detail: null }, 'a key that never resets is not a weekly budget, and with no weekly cap there is none: nothing of nothing');
  const unread = { getEffectiveUserWeeklyLimitCents: async () => { throw new Error('db down'); }, getWeeklySpentCents: async () => 0 };
  assert.equal(await credit.budget(db, { limits: unread }), null, 'a ledger that cannot be read measures nothing, so the figure grows old');
});

// ── 4. Which one ran out ────────────────────────────────────────────────

const REFUSED_402 = 'API Error: 402 This request would exceed your available credits given your current in-flight requests.';

test('a 402 with the key spent and credit in the account: the weekly budget is what ran out, and it lifts when the key can spend again', async () => {
  const db = database();
  const { told, notifications } = admins();
  let nudges = 0;
  let woken = 0;
  const deps = {
    config: CONFIG, staging: false, notifications, limitsChanged: () => {},
    budgetNudge: async () => { nudges += 1; }, platform: () => ({ async botCreditBack() { woken += 1; } }),
  };
  const answers = { credits: { total: 5000, used: 3076.14 }, key: { limit: 800, remaining: 0.4 } };
  await withOpenRouter(answers, async (or) => {
    const noted = await credit.noteOutage(db, { words: REFUSED_402 }, deps);
    assert.deepEqual([noted.fresh, noted.cause], [true, 'budget']);
    assert.deepEqual(or.calls.map((c) => c.path), ['/api/v1/credits', '/api/v1/key'], 'asked now, not from a read a quarter of an hour old');
    assert.deepEqual(told, [], 'no "OpenRouter credit ran out" alert');
    assert.equal(nudges, 1, 'the budget\'s own limit is evaluated at once: its notice is the alert');
    assert.deepEqual((({ cause, causeFrom }) => ({ cause, causeFrom }))(db.stateNow().outage), { cause: 'budget', causeFrom: 'figures' });
    assert.deepEqual((({ out, cause }) => ({ out, cause }))(await credit.creditState(db)), { out: true, cause: 'budget' });
    // The incident says so.
    assert.equal(db.other.filter((sql) => /INSERT INTO events/.test(sql)).length, 1);

    // The sweep: still spent, still out, and still the budget.
    let out = await credit.sweep(db, CONFIG, deps);
    assert.deepEqual(out.events, []);
    const status = await credit.status(db);
    assert.equal(status.outage.cause, 'budget');
    assert.equal(view.creditRow(status), null, 'the credit row does not say "out": the account has $1,923.86');

    // The budget, as a limit: used up while OpenRouter refuses, whatever cents its count shows.
    const measured = await credit.budget(db, { limits: ledger(70000) });
    assert.deepEqual([measured.used, measured.cap, measured.detail.usedCents, measured.detail.refused], [80000, 80000, 79960, true]);
    const created = [];
    const level = await alerts.evaluate(db, {}, 'bot_budget', {
      staging: false, measure: { limits: ledger(70000) },
      create: async (_db, args) => { created.push(args.detail); return []; }, publish: async () => {},
    });
    assert.equal(level.level, 'full');
    assert.deepEqual(created, ['bot_budget_full:80000:80000'], 'one notice: the weekly budget is used up');
    assert.equal(view.capacityRow('bot_budget', db.levels.get('bot_budget'), { percent: 80 }).state, 'at');

    // Monday, or a raised budget: the key can spend again. Not within five minutes of the refusal.
    answers.key.remaining = 800;
    out = await credit.sweep(db, CONFIG, deps);
    assert.deepEqual(out.events, [], 'an outage stands five minutes at least');
    const state = db.stateNow();
    db.settings.set(credit.KEY_STATE, JSON.stringify({ ...state, outage: { ...state.outage, since: new Date(Date.now() - 2 * credit.BACK_AFTER_MS).toISOString() } }));
    out = await credit.sweep(db, CONFIG, deps);
    assert.deepEqual(out.events.map((e) => e.type), ['back']);
  });
  assert.equal(db.stateNow().outage, null);
  assert.equal(woken, 1, 'the lane is woken');
  assert.equal(nudges, 2, 'and the budget\'s limit is evaluated again, so its row goes');
  assert.equal((await credit.budget(db, { limits: ledger(70000) })).detail.refused, false);
});

test('OpenRouter\'s own "Key limit exceeded" names the cause without a read', async () => {
  const db = database();
  const { told, notifications } = admins();
  let nudges = 0;
  await withOpenRouter({ credits: null, key: null }, async (or) => {
    const noted = await credit.noteOutage(db, { words: 'Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/settings/keys' },
      { staging: false, notifications, limitsChanged: () => {}, budgetNudge: async () => { nudges += 1; } });
    assert.equal(noted.cause, 'budget');
    assert.deepEqual(or.calls, []);
  });
  assert.deepEqual((({ cause, causeFrom }) => ({ cause, causeFrom }))(db.stateNow().outage), { cause: 'budget', causeFrom: 'refusal' });
  assert.deepEqual(told, []);
  assert.equal(nudges, 1);
  // With OpenRouter's own count not read, the budget is said as all used,
  // never as Homeroom's lower count beside "used up".
  const measured = await credit.budget(db, { limits: ledger(28147) });
  assert.deepEqual([measured.used, measured.cap, measured.detail.usedCents, measured.detail.source, measured.detail.refused],
    [80000, 80000, 80000, 'homeroom', true]);
  // The refusal itself is an outage wherever a provider's own words are read:
  // an error a turn's result carries, and the runtime's "API Error" notice.
  assert.equal(credit.creditOut({ agentError: '403 Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/settings/keys' }), true);
  assert.equal(credit.creditOut({ lastResultText: 'API Error: 403 Key limit exceeded (weekly limit).' }), true);
  // Never a model's own reply that happens to say so.
  assert.equal(credit.creditOut({ lastResultText: 'Blocked: the page shows "Key limit exceeded" and needs a design first.' }), false);
  assert.equal(require('../src/services/provider-error').refusalCode(403, '{"error":{"message":"Key limit exceeded (weekly limit)","code":403}}'), 'credit_out');
  assert.equal(require('../src/services/provider-error').refusalCode(403, '{"error":{"message":"Forbidden"}}'), 'authentication');
  assert.equal(require('../src/services/bot-turn-failure').sort({
    providerText: '{"error":{"message":"Key limit exceeded (weekly limit)","code":403}}',
  }).class, 'credit');
});

test('a 402 with the account empty: credit is what ran out, said as credit', async () => {
  const db = database();
  const { told, notifications } = admins();
  let nudges = 0;
  await withOpenRouter({ credits: { total: 5000, used: 4999.88 }, key: { limit: 800, remaining: 300 } }, async () => {
    const noted = await credit.noteOutage(db, { words: REFUSED_402 },
      { config: CONFIG, staging: false, notifications, limitsChanged: () => {}, budgetNudge: async () => { nudges += 1; } });
    assert.deepEqual([noted.fresh, noted.cause], [true, 'credit']);
  });
  assert.deepEqual(told, ['credit:out'], 'the admins are told credit ran out');
  assert.equal(nudges, 0);
  assert.deepEqual((({ cause, causeFrom }) => ({ cause, causeFrom }))(db.stateNow().outage), { cause: 'credit', causeFrom: 'figures' });
  const row = view.creditRow(await credit.status(db));
  assert.equal(row.state, 'out', 'the credit row says out');
  assert.equal((await credit.budget(db, { limits: ledger(50000) })).detail.refused, false, 'the budget is not what refused');
});

test('with nothing to judge from, an outage is credit, and the next read corrects it', async () => {
  const db = database();
  const { told, notifications } = admins();
  let nudges = 0;
  const deps = { staging: false, notifications, limitsChanged: () => {}, budgetNudge: async () => { nudges += 1; }, platform: noWake };
  // No config at hand and nothing stored: the refusal's own words are all there is.
  const noted = await credit.noteOutage(db, { words: REFUSED_402 }, deps);
  assert.equal(noted.cause, 'credit');
  assert.equal(db.stateNow().outage.causeFrom, 'default');
  assert.deepEqual(told, ['credit:out']);
  await withOpenRouter({ credits: { total: 5000, used: 3000 }, key: { limit: 800, remaining: 2 } }, async () => {
    const out = await credit.sweep(db, CONFIG, deps);
    assert.equal(out.cause, 'budget');
  });
  assert.deepEqual((({ cause, causeFrom }) => ({ cause, causeFrom }))(db.stateNow().outage), { cause: 'budget', causeFrom: 'figures' });
  assert.equal(nudges, 1, 'the budget\'s limit is evaluated when the cause turns out to be the budget');
});

// ── 5. How long the credit lasts ────────────────────────────────────────

test('the days estimate is read off the account\'s own credit, and a top-up is not negative spend', async () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  // $100 a day for two days, a $1,000 top-up, then $100 over the last day.
  const readings = [
    { at: at(3 * DAY), cents: 60000 }, { at: at(2 * DAY), cents: 50000 }, { at: at(DAY + 12 * HOUR), cents: 45000 },
    { at: at(DAY), cents: 145000 }, { at: at(0), cents: 135000 },
  ];
  const burn = credit.burnOf(readings, now);
  assert.equal(Math.round(burn.dailyCents), 10000, '$250 spent over the two and a half days that were not a top-up');
  assert.equal(credit.daysLeft(135000, burn.dailyCents), 13.5);
  assert.equal(credit.burnOf(readings.slice(-2), now).days, 1);
  assert.equal(credit.burnOf(readings.slice(0, 1), now), null, 'one reading is no rate');
  assert.equal(credit.burnOf([{ at: at(6 * HOUR), cents: 500 }, { at: at(0), cents: 400 }], now), null, 'under a day of readings is no estimate');

  // The ring: one reading every three hours at most, a week at most.
  let ring = [];
  for (let h = 200; h >= 0; h -= 1) ring = credit.pushReading(ring, { at: at(h * HOUR), cents: 100000 + h * 10 });
  assert.equal(ring.length, 56, 'every third hour of the last seven days');
  assert.ok(now - Date.parse(ring[0].at) <= credit.READING_KEEP_MS);

  // Through the sweep: the low warning carries the account's own rate.
  const db = database({ state: {
    accountCents: 60000, creditCents: 60000, creditAt: at(15 * MIN), at: at(15 * MIN), armed: { low: true, urgent: true }, outage: null,
    readings: [{ at: at(2 * DAY), cents: 68000 }, { at: at(DAY), cents: 64000 }, { at: at(3 * HOUR), cents: 60500 }],
  } });
  const { told, notifications } = admins();
  await withOpenRouter({ credits: { total: 5000, used: 4520 }, key: { limit: 800, remaining: 700 } }, async () => {
    await credit.sweep(db, CONFIG, { staging: false, notifications, platform: noWake, now: () => now });
  });
  assert.equal(told.length, 1);
  assert.match(told[0], /^credit:low:500:480:\d+$/);
  const days = Number(told[0].split(':')[4]);
  assert.ok(days >= 4 && days <= 6, `about five days at $100 a day, said ${days}`);
  const status = credit.statusOf(db.stateNow(), {}, now);
  assert.ok(status.daysLeft > 4 && status.daysLeft < 6);
  assert.equal(status.burnDays, 2);
});

// ── 6. The pure rules ───────────────────────────────────────────────────

test('what counts as credit, what the bot can spend, and which one ran out', () => {
  assert.deepEqual(credit.creditOf({ accountCents: 192386, keyCents: 49996, keyReset: 'weekly' }), { cents: 192386, source: 'account' });
  assert.deepEqual(credit.creditOf({ accountCents: null, keyCents: 49996, keyReset: 'weekly' }), { cents: null, source: null });
  assert.deepEqual(credit.creditOf({ accountCents: null, keyCents: 49996, keyReset: null }), { cents: 49996, source: 'key' });
  assert.deepEqual(credit.creditOf({ accountCents: null, keyCents: 49996 }), { cents: null, source: null }, 'a cadence not read is not known to be prepaid');
  assert.equal(credit.spendableOf({ accountCents: 192386, keyCents: 49996 }), 49996);
  assert.equal(credit.spendableOf({ accountCents: 1200, keyCents: 49996 }), 1200);
  assert.equal(credit.spendableOf({ accountCents: null, keyCents: null }), null);

  assert.equal(credit.causeOf({ accountCents: 192386, keyCents: 40, keyReset: 'weekly' }), 'budget');
  assert.equal(credit.causeOf({ accountCents: null, keyCents: 40, keyReset: 'weekly' }), 'budget', 'the account unread, the key an allowance');
  assert.equal(credit.causeOf({ accountCents: null, keyCents: 40, keyReset: null }), 'credit', 'a prepaid key is the credit');
  assert.equal(credit.causeOf({ accountCents: 12, keyCents: 30000, keyReset: 'weekly' }), 'credit');
  assert.equal(credit.causeOf({ accountCents: 12, keyCents: 40, keyReset: 'weekly' }), 'credit', 'both gone: adding credit comes first');
  assert.equal(credit.causeOf({ accountCents: 192386, keyCents: 49996, keyReset: 'weekly' }), null, 'neither is spent: the figures do not say');

  assert.equal(credit.refusalCause('API Error: 403 Key limit exceeded (weekly limit).'), 'budget');
  assert.equal(credit.refusalCause({ providerRequest: { limitSource: 'openrouter_key_limit' } }), 'budget');
  assert.equal(credit.refusalCause(REFUSED_402), null);

  // The warnings read the credit; the lifting of an outage reads what the bot can spend.
  const out = credit.outageSet(null, { words: REFUSED_402, cause: 'budget', causeFrom: 'figures', now: Date.now() - 10 * MIN });
  let r = credit.decide(out, { creditCents: 192386, spendableCents: 40 });
  assert.deepEqual(r.events, [], 'credit to spare lifts nothing while the key is spent');
  assert.ok(r.state.outage);
  r = credit.decide(out, { creditCents: 192386, spendableCents: 80000 });
  assert.deepEqual(r.events.map((e) => e.type), ['back']);
  r = credit.decide(null, { creditCents: null, spendableCents: 12000 });
  assert.deepEqual(r.events, [], 'no credit figure, no warning');
  assert.deepEqual(r.state.armed, { low: true, urgent: true });
  assert.equal(credit.outageCause({ since: '2026-11-19T12:00:00Z', words: '402' }), 'credit', 'an outage from before causes were kept');
});

// ── 7. Raising the budget reaches the key ───────────────────────────────

test('a saved weekly budget is taken to the bot\'s key at once, then the figures are read back', async () => {
  const bot = require('../src/services/homeroom-bot');
  const steps = [];
  const pool = { async query() { return { rows: [{ id: BOT_ID }] }; } };
  await bot.syncBudget(pool, CONFIG, {
    managedOpenRouter: {
      managedKeysEnabled: () => true,
      stateForUser: async (_pool, userId) => ({ managed_key_id: 4, userId }),
      syncAllowance: async ({ userId, state }) => { steps.push(`key:${userId}:${state.managed_key_id}`); },
    },
    credit: { sweep: async (_pool, config) => { steps.push(`sweep:${config === CONFIG}`); } },
    limitAlerts: { evaluate: async (_pool, _config, key) => { steps.push(`limit:${key}`); } },
  });
  // In this order: while the bot is paused on a used-up budget no coding
  // turn starts, and that was the only thing that brought the key's own
  // limit in line; then the read that lifts the pause; then the row.
  assert.deepEqual(steps, [`key:${BOT_ID}:4`, 'sweep:true', 'limit:bot_budget']);
  // No bot account yet: nothing to take anywhere.
  const none = [];
  await bot.syncBudget({ async query() { return { rows: [] }; } }, CONFIG, {
    credit: { sweep: async () => { none.push('sweep'); } }, limitAlerts: { evaluate: async () => { none.push('limit'); } },
  });
  assert.deepEqual(none, []);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(source, /if \(valid\.weeklyLimitCents !== undefined\) \{[\s\S]*?await syncBudget\(pool, config\)\.catch\(/,
    'saving the budget in Admin, Homeroom bot, Settings does it');
});

// ── 8. What a staging copy shows (the before and after shots) ───────────

test('the staging sample shows both rows, and a preview with no keys leaves it standing', async () => {
  const migrate = require('../src/db/migrate');
  const db = database({ bot: false });
  const before = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await migrate.seedStagingPlatformLimit(db);
    // The preview's own sweep: no management key, no bot key, nothing to ask.
    await withOpenRouter({ credits: null, key: null }, async (or) => {
      await credit.sweep(db, NO_MANAGEMENT, { platform: noWake });
      assert.deepEqual(or.calls, []);
    });
  } finally {
    if (before === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = before;
  }
  const status = await credit.status(db);
  const row = view.creditRow(status);
  assert.deepEqual([row.state, row.urgent, row.balanceCents, row.daysLeft], ['near', true, 18400, 2], 'the account\'s $184, about two days');
  // Still "just read" hours on: a preview outlives the 45 minutes a read is stood on.
  assert.equal(view.creditRow(status, { now: Date.now() + 6 * HOUR }).state, 'near');
  const stored = db.levels.get('bot_budget');
  assert.deepEqual([stored.level, stored.used, stored.cap], ['warn', 64800, 80000], 'the budget\'s level, measured by its own code');
  const budgetRow = view.capacityRow('bot_budget', stored, { percent: 80 });
  assert.deepEqual([budgetRow.state, budgetRow.percent, budgetRow.detail.usedCents], ['near', 81, 64800]);
  assert.equal(new Date(budgetRow.detail.resetsAt).getUTCDay(), 1);
  // Off staging the seed writes nothing.
  const prod = database();
  await migrate.seedStagingPlatformLimit(prod);
  assert.equal(prod.stateNow(), null);
});

// Tests for the app-LLM grant management API (issue #34) —
// src/routes/llm-grants.js. Covers the consent-flow contract:
// create with the default cap, cap validation (zero / negative /
// non-integer / above-user-limit), revoke, re-grant reactivation,
// and the staging-only ?demo=1 injection.
//
// Run with: node --test tests/app-llm-grants.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Override the pool BEFORE requiring the route module. The mock keeps
// a tiny in-memory grant store and answers the SQL shapes the router
// (and limits.getEffectiveUserLimitCents) issue.
const poolMod = require('../src/db/pool');

const state = {
  userLimit: 2500,
  grants: new Map(), // `${appId}:${userId}` -> row
  apps: new Map([['demo-app', { id: 11, name: 'Demo App', slug: 'demo-app', manifest_snapshot: null }]]),
  // Today's app_llm_usage row joined by the bootstrap query (issue
  // #655). NUMERIC(10,4) comes back from pg as strings.
  usage: { spent: null, byok: null },
};

function mockQuery(sql, params) {
  if (/SELECT daily_limit_cents FROM users/.test(sql)) {
    return { rows: [{ daily_limit_cents: state.userLimit }] };
  }
  if (/SELECT value FROM platform_settings/.test(sql)) {
    return { rows: [{ value: '2500' }] };
  }
  if (/SELECT id, name, slug FROM apps WHERE slug/.test(sql)) {
    const app = state.apps.get(params[0]);
    return { rows: app ? [app] : [] };
  }
  if (/SELECT id, name, slug, manifest_snapshot FROM apps WHERE slug/.test(sql)) {
    const app = state.apps.get(params[0]);
    return { rows: app ? [app] : [] };
  }
  if (/SELECT anthropic_key_enc FROM users/.test(sql)) {
    return { rows: [] };
  }
  if (/INSERT INTO app_llm_grants/.test(sql)) {
    const [appId, userId, cap, byok] = params;
    const key = `${appId}:${userId}`;
    const existing = state.grants.get(key);
    const row = {
      app_id: appId, user_id: userId, status: 'active',
      daily_cap_cents: cap, allow_byok: byok,
      created_at: existing?.created_at || new Date().toISOString(),
      revoked_at: null,
    };
    state.grants.set(key, row);
    return { rows: [row] };
  }
  if (/UPDATE app_llm_grants SET status = 'revoked'/.test(sql)) {
    const [appId, userId] = params;
    const row = state.grants.get(`${appId}:${userId}`);
    if (!row) return { rows: [] };
    row.status = 'revoked';
    row.revoked_at = new Date().toISOString();
    return { rows: [{ app_id: appId }] };
  }
  if (/UPDATE app_llm_grants SET/.test(sql)) {
    const [appId, userId, ...rest] = params;
    const row = state.grants.get(`${appId}:${userId}`);
    if (!row) return { rows: [] };
    // The router builds SET clauses in param order: cap (if present)
    // then allowByok (if present).
    if (/daily_cap_cents = \$3/.test(sql)) row.daily_cap_cents = rest[0];
    if (/allow_byok = \$3/.test(sql)) row.allow_byok = rest[0];
    if (/allow_byok = \$4/.test(sql)) row.allow_byok = rest[1];
    return { rows: [row] };
  }
  // Bootstrap query: one (app, user) grant LEFT JOINed with today's
  // spend (issue #655). Must be matched before the list-endpoint
  // branch below — both SQL shapes contain `FROM app_llm_grants g`.
  if (/FROM app_llm_grants g[\s\S]*WHERE g\.app_id = \$1 AND g\.user_id = \$2/.test(sql)) {
    const row = state.grants.get(`${params[0]}:${params[1]}`);
    if (!row) return { rows: [] };
    return {
      rows: [{
        ...row,
        spent_today_cents: state.usage.spent,
        byok_spent_today_cents: state.usage.byok,
      }],
    };
  }
  if (/FROM app_llm_grants g/.test(sql)) {
    const userId = params[0];
    const rows = [...state.grants.values()]
      .filter((g) => g.user_id === userId)
      .map((g) => ({
        ...g,
        app_name: 'Demo App', app_slug: 'demo-app',
        spent_today_cents: 0, byok_spent_today_cents: 0,
      }));
    return { rows };
  }
  return { rows: [] };
}

poolMod.getPool = () => ({ query: async (sql, params) => mockQuery(sql, params) });

const limits = require('../src/services/limits');
const { llmGrantsRoutes } = require('../src/routes/llm-grants');
const express = require('express');

function startServer({ user = { id: 7, username: 'tester' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(llmGrantsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function withServer(fn) {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  limits.invalidate();
  state.grants.clear();
  state.userLimit = 2500;
  state.usage = { spent: null, byok: null };
  delete process.env.USERNODE_ENV;
});

test('POST creates a grant with the default $1.00 cap', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app' }),
    });
    assert.equal(res.status, 200);
    const { grant } = await res.json();
    assert.equal(grant.status, 'active');
    assert.equal(grant.dailyCapCents, 100);
    assert.equal(grant.allowByok, false);
  });
});

test('POST rejects zero, negative, non-integer, and above-limit caps', async () => {
  await withServer(async (base) => {
    for (const bad of [0, -5, 1.5, 'abc', 99999]) {
      const res = await fetch(`${base}/api/me/llm-grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appSlug: 'demo-app', dailyCapCents: bad }),
      });
      assert.equal(res.status, 400, `cap ${bad} should be rejected`);
    }
    // The user's own limit is the inclusive upper bound.
    const ok = await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app', dailyCapCents: 2500 }),
    });
    assert.equal(ok.status, 200);
  });
});

test('DELETE revokes; POST after revoke reactivates the same row', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app', dailyCapCents: 200 }),
    });
    const del = await fetch(`${base}/api/me/llm-grants/11`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(state.grants.get('11:7').status, 'revoked');

    const re = await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app', dailyCapCents: 300, allowByok: true }),
    });
    assert.equal(re.status, 200);
    const { grant } = await re.json();
    assert.equal(grant.status, 'active');
    assert.equal(grant.dailyCapCents, 300);
    assert.equal(grant.allowByok, true);
    assert.equal(state.grants.get('11:7').revoked_at, null);
  });
});

test('PATCH updates the cap with the same validation', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app' }),
    });
    const bad = await fetch(`${base}/api/me/llm-grants/11`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dailyCapCents: -1 }),
    });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/me/llm-grants/11`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dailyCapCents: 500 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(state.grants.get('11:7').daily_cap_cents, 500);
  });
});

test('?demo=1 injects fabricated grants ONLY in staging', async () => {
  await withServer(async (base) => {
    // Not staging: demo param is ignored, real (empty) list returned.
    let res = await fetch(`${base}/api/me/llm-grants?demo=1`);
    let body = await res.json();
    assert.equal(body.demo, undefined);
    assert.equal(body.grants.length, 0);

    process.env.USERNODE_ENV = 'staging';
    res = await fetch(`${base}/api/me/llm-grants?demo=1`);
    body = await res.json();
    assert.equal(body.demo, true);
    assert.equal(body.grants.length, 2);
    assert.match(body.grants[0].appName, /^Staging demo/);
    // Plain staging request without the param stays real.
    res = await fetch(`${base}/api/me/llm-grants`);
    body = await res.json();
    assert.equal(body.grants.length, 0);
  });
});

test("bootstrap endpoint includes today's spend on the grant (issue #655)", async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app', dailyCapCents: 500 }),
    });
    // pg returns NUMERIC(10,4) columns as strings; grantJson numbers them.
    state.usage = { spent: '12.3400', byok: '0.5000' };
    const res = await fetch(`${base}/api/apps/demo-app/llm-grant`);
    assert.equal(res.status, 200);
    const { grant } = await res.json();
    assert.equal(grant.dailyCapCents, 500);
    assert.equal(grant.spentTodayCents, 12.34);
    assert.equal(grant.byokSpentTodayCents, 0.5);
  });
});

test('bootstrap endpoint reports zero spend when no usage row exists today', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/me/llm-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appSlug: 'demo-app' }),
    });
    const res = await fetch(`${base}/api/apps/demo-app/llm-grant`);
    const { grant } = await res.json();
    assert.equal(grant.spentTodayCents, 0);
    assert.equal(grant.byokSpentTodayCents, 0);
  });
});

test('bootstrap endpoint sanitizes the manifest llm block and clamps the suggestion', async () => {
  state.apps.set('demo-app', {
    id: 11, name: 'Demo App', slug: 'demo-app',
    manifest_snapshot: {
      llm: { purpose: 'Summarizes things', suggested_daily_cap_cents: 999999 },
    },
  });
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/apps/demo-app/llm-grant`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.llm.purpose, 'Summarizes things');
    // Clamped to the user's effective daily limit.
    assert.equal(body.llm.suggestedCapCents, 2500);
    assert.equal(body.defaultCapCents, 100);
    assert.equal(body.maxCapCents, 2500);
    assert.equal(body.grant, null);
    assert.equal(body.hasApiKey, false);
  });
  state.apps.set('demo-app', { id: 11, name: 'Demo App', slug: 'demo-app', manifest_snapshot: null });
});

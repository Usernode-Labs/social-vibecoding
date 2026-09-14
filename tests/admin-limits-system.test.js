// #361: admin LLM-spend-limits route handles the new system-tokens cap.
//
// PUT /api/admin/limits with `system` persists
// system_tokens_daily_limit_cents and invalidates the limits cache; GET
// returns it. Validation mirrors the existing user/global params.
//
// Run with: node --test tests/admin-limits-system.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// A stateful platform_settings store so a PUT is observable by the
// follow-up read inside the same handler (which re-reads via limits.js).
const poolMod = require('../src/db/pool');
const store = new Map([
  ['user_daily_limit_cents', '2500'],
  ['global_daily_limit_cents', '20000'],
  ['system_tokens_daily_limit_cents', '2500'],
]);
poolMod.getPool = () => ({
  async query(sql, params) {
    if (/SELECT value FROM platform_settings WHERE key/.test(sql)) {
      const v = store.get(params[0]);
      return { rows: v == null ? [] : [{ value: v }] };
    }
    if (/INSERT INTO platform_settings/.test(sql)) {
      store.set(params[0], params[1]);
      return { rows: [] };
    }
    return { rows: [] };
  },
});

const limits = require('../src/services/limits');
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
    next();
  });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('GET /api/admin/limits returns the system-tokens cap', async () => {
  limits.invalidate();
  const r = await fetch(`${base}/api/admin/limits`).then((x) => x.json());
  assert.equal(r.system_tokens_daily_limit_cents, 2500);
});

test('PUT /api/admin/limits persists system and re-reads it (cache invalidated)', async () => {
  limits.invalidate();
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: 5000 }),
  }).then((x) => x.json());
  assert.equal(r.system_tokens_daily_limit_cents, 5000, 'response reflects the new value immediately');
  assert.equal(store.get('system_tokens_daily_limit_cents'), '5000', 'persisted to platform_settings');

  // A fresh GET (cache was invalidated on the PUT) shows the new value.
  const g = await fetch(`${base}/api/admin/limits`).then((x) => x.json());
  assert.equal(g.system_tokens_daily_limit_cents, 5000);
});

test('PUT /api/admin/limits rejects a negative/non-integer system cap', async () => {
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: -1 }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /system/);
});

test('PUT /api/admin/limits with only user/global leaves system untouched', async () => {
  limits.invalidate();
  store.set('system_tokens_daily_limit_cents', '5000');
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 3000 }),
  }).then((x) => x.json());
  assert.equal(r.user_daily_limit_cents, 3000);
  assert.equal(r.system_tokens_daily_limit_cents, 5000, 'system cap is preserved when not sent');
});

// ── #1788: the weekly cap is the fourth setting on the same route ────────
//
// It shares the daily cap's whole shape — one platform_settings key, one
// param on this PUT, the same validation, the same cache invalidation — so
// what these cover is that it actually got wired into all four of those
// places rather than three.

test('GET /api/admin/limits returns the default weekly cap when none is stored', async () => {
  limits.invalidate();
  store.delete('user_weekly_limit_cents');
  const r = await fetch(`${base}/api/admin/limits`).then((x) => x.json());
  assert.equal(r.user_weekly_limit_cents, 17500,
    'seven days of the $25 daily default, so an untouched deployment gains no new refusals');
});

test('PUT /api/admin/limits persists weekly and re-reads it (cache invalidated)', async () => {
  limits.invalidate();
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekly: 30000 }),
  }).then((x) => x.json());
  assert.equal(r.user_weekly_limit_cents, 30000, 'response reflects the new value immediately');
  assert.equal(store.get('user_weekly_limit_cents'), '30000', 'persisted to platform_settings');

  const g = await fetch(`${base}/api/admin/limits`).then((x) => x.json());
  assert.equal(g.user_weekly_limit_cents, 30000, 'and the cache was dropped, so a fresh read agrees');
});

test('a weekly cap of 0 is storable, and means "no weekly cap"', async () => {
  limits.invalidate();
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekly: 0 }),
  }).then((x) => x.json());
  assert.equal(r.user_weekly_limit_cents, 0);
  assert.equal(store.get('user_weekly_limit_cents'), '0',
    'stored as an explicit zero rather than falling back to the default');
});

test('PUT /api/admin/limits rejects a negative/non-integer weekly cap', async () => {
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekly: -1 }),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /weekly/);

  const f = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weekly: 12.5 }),
  });
  assert.equal(f.status, 400, 'cents are integers');
});

test('PUT /api/admin/limits with only user leaves weekly untouched', async () => {
  limits.invalidate();
  store.set('user_weekly_limit_cents', '30000');
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 3000 }),
  }).then((x) => x.json());
  assert.equal(r.user_daily_limit_cents, 3000);
  assert.equal(r.user_weekly_limit_cents, 30000, 'weekly cap is preserved when not sent');
  assert.equal(store.get('user_weekly_limit_cents'), '30000');
});

test('sending nothing at all is a client error naming every accepted param', async () => {
  const r = await fetch(`${base}/api/admin/limits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  for (const p of ['user', 'weekly', 'global', 'system']) {
    assert.match(body.error, new RegExp(p), `the error names ${p}`);
  }
});

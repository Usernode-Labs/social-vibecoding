// Tests for the dashboard admin-vs-non-admin colour split + per-card
// Overview tooltips (#341).
//
// Three layers:
//   1. Behavioural — mount the analytics router with a mocked pool and
//      assert each modified endpoint returns the `_admin` companion fields /
//      `is_admin` row flag, that the reworked general-users endpoint (#456)
//      returns its daily DAU/WAU/MAU series, and that includeAdmins is wired
//      into the SQL gate (the NOT-IN admin-exclusion fragment appears when
//      the box is off and is dropped when it is on).
//   2. Source guards — pin the SQL companions on src/routes/dashboard.js and
//      the staging seed contract on src/db/migrate.js (string-assertion
//      style, matching tests/ai-progress-estimate.test.js).
//   3. Client — dashboard.js registers a per-card tooltip definition for each
//      of the ten Overview cards and threads the amber admin colour through.
//
// Run with: node --test tests/dashboard-admin-split.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. Behavioural: mounted router + mocked pool ────────────────────────

// Swap the pool BEFORE requiring the route module (it destructures getPool at
// require time). A single handler answers every query shape and records the
// SQL so we can assert the includeAdmins gate.
const poolMod = require('../src/db/pool');
let lastQueries = [];
function handler(sql) {
  lastQueries.push(sql);
  // Funnels — three queries.
  if (/signed_up_admin/.test(sql)) {
    return { rows: [{
      signed_up: 100, signed_up_admin: 5,
      opened_dapp: 80, opened_dapp_admin: 4,
      returned: 60, returned_admin: 3,
      engaged: 40, engaged_admin: 2,
      creators: 10, creators_admin: 1,
    }] };
  }
  if (/started_admin/.test(sql) && /LEFT JOIN users usr/.test(sql)) {
    return { rows: [{
      started: 50, started_admin: 5,
      produced_pr: 40, produced_pr_admin: 4,
      promoted: 30, promoted_admin: 3,
      received_vote: 20, received_vote_admin: 2,
      merged: 10, merged_admin: 1,
    }] };
  }
  if (/COUNT\(DISTINCT cs\.user_id\)/.test(sql)) {
    return { rows: [{
      started: 25, started_admin: 3,
      produced_pr: 20, produced_pr_admin: 2,
      promoted: 15, promoted_admin: 1,
      merged: 8, merged_admin: 1,
    }] };
  }
  // Growth.
  if (/new_users_admin/.test(sql)) {
    return { rows: [{
      wk: '2026-06-08', new_users: 7, new_users_admin: 2,
      new_apps: 3, new_apps_admin: 1,
      promoted_prs: 4, promoted_prs_admin: 1,
      merged_prs: 2, merged_prs_admin: 1,
    }] };
  }
  // General users (#456 rework) — a single query returns the daily
  // DAU/WAU/MAU series. The pre-#456 weekly engagement admin split was
  // removed when the chart became a plain daily line chart.
  if (/COUNT\(DISTINCT a\.user_id\)/.test(sql)) {
    return { rows: [{ day: '2026-06-08', dau: 12, wau: 18, mau: 30 }] };
  }
  // Top users.
  if (/COUNT\(cs\.id\)::int AS sessions/.test(sql)) {
    return { rows: [
      { name: 'alice', is_admin: false, sessions: 9, produced_pr: 5, promoted: 3, received_vote: 2, merged: 1 },
      { name: 'ops', is_admin: true, sessions: 7, produced_pr: 4, promoted: 2, received_vote: 1, merged: 1 },
    ] };
  }
  // Spend by builder.
  if (/JOIN llm_usage lu/.test(sql)) {
    return { rows: [
      { name: 'alice', is_admin: false, platform_cents: 500, user_key_cents: 100 },
      { name: 'ops', is_admin: true, platform_cents: 300, user_key_cents: 50 },
    ] };
  }
  // Daily spend.
  if (/platform_cents_admin/.test(sql)) {
    return { rows: [{
      day: '2026-06-16', platform_cents: 420, user_key_cents: 90,
      platform_cents_admin: 60, user_key_cents_admin: 10,
      system_cents: 175,
    }] };
  }
  return { rows: [] };
}
poolMod.getPool = () => ({ query: (sql) => handler(sql) });

const { dashboardRoutes } = require('../src/routes/dashboard');
const express = require('express');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 1, username: 'admin', isAdmin: true }; next(); });
  app.use(dashboardRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = (p) => fetch(`${base}${p}`).then((r) => r.json());

test('funnels: every stage carries an _admin companion when includeAdmins=true', async () => {
  const f = await get('/api/admin/analytics/funnels?includeAdmins=true');
  for (const k of ['signed_up', 'opened_dapp', 'returned', 'engaged', 'creators']) {
    assert.ok(`${k}_admin` in f.dappUsage, `dappUsage.${k}_admin missing`);
  }
  for (const k of ['started', 'produced_pr', 'promoted', 'received_vote', 'merged']) {
    assert.ok(`${k}_admin` in f.prSessions, `prSessions.${k}_admin missing`);
  }
  for (const k of ['started', 'produced_pr', 'promoted', 'merged']) {
    assert.ok(`${k}_admin` in f.prUsers, `prUsers.${k}_admin missing`);
  }
  // Non-admin value stays the base count.
  assert.equal(f.dappUsage.signed_up, 100);
  assert.equal(f.dappUsage.signed_up_admin, 5);
});

test('growth: each weekly row carries the four _admin companions', async () => {
  const g = await get('/api/admin/analytics/growth?includeAdmins=true');
  const w = g.weeks[0];
  for (const k of ['new_users', 'new_apps', 'promoted_prs', 'merged_prs']) {
    assert.ok(`${k}_admin` in w, `${k}_admin missing`);
  }
  assert.equal(w.new_users_admin, 2);
});

// #456 reworked the old weekly "engagement" split into a daily General
// users endpoint (DAU / 7-day rolling WAU / 30-day rolling MAU), rendered as
// plain line charts. The amber admin split only ever applied to bar charts,
// so it was intentionally dropped here — these two cases now pin the
// reworked contract instead of the removed admin companions.
test('general-users: the daily series carries dau, wau and mau (#456 rework)', async () => {
  const e = await get('/api/admin/analytics/general-users?includeAdmins=true');
  const d = e.daily[0];
  assert.equal(d.dau, 12);
  assert.equal(d.wau, 18);
  assert.equal(d.mau, 30);
});

test('top-users: rows carry the is_admin flag', async () => {
  const d = await get('/api/admin/analytics/top-users?includeAdmins=true');
  assert.equal(d.users.find((u) => u.name === 'ops').is_admin, true);
  assert.equal(d.users.find((u) => u.name === 'alice').is_admin, false);
});

test('spend-by-builder: rows carry the is_admin flag', async () => {
  const d = await get('/api/admin/analytics/spend-by-builder?includeAdmins=true');
  assert.equal(d.builders.find((b) => b.name === 'ops').is_admin, true);
});

test('spend: each day carries the admin-portion breakout columns', async () => {
  const d = await get('/api/admin/analytics/spend?includeAdmins=true');
  const day = d.days[0];
  assert.ok('platform_cents_admin' in day);
  assert.ok('user_key_cents_admin' in day);
  // Each bar's total height is unchanged — the admin amber is stacked by
  // subtracting the admin portion from the non-admin segment (see the
  // renderSpend client guard below), so the payload totals stay the full value.
  assert.equal(day.platform_cents, 420);
  assert.equal(day.platform_cents_admin, 60);
});

test('spend: each day carries a system_cents series (#361)', async () => {
  const d = await get('/api/admin/analytics/spend?includeAdmins=true');
  const day = d.days[0];
  assert.ok('system_cents' in day, 'system_cents column must be returned');
  assert.equal(day.system_cents, 175);
});

test('spend: the system aggregate ignores the includeAdmins filter (#361)', async () => {
  lastQueries = [];
  await get('/api/admin/analytics/spend?includeAdmins=false');
  const sql = lastQueries.find((s) => /system_token_usage/.test(s));
  assert.ok(sql, 'the spend query must aggregate system_token_usage');
  // The sys CTE must not carry the per-user admin NOT-IN gate.
  const sysCte = sql.slice(sql.indexOf('sys AS'));
  assert.doesNotMatch(sysCte, /NOT IN \(SELECT id FROM users WHERE is_admin\)/,
    'system spend is not user-attributed, so the admin filter must not apply to it');
});

test('includeAdmins gates the SQL: NOT-IN admin filter present when off, dropped when on', async () => {
  lastQueries = [];
  await get('/api/admin/analytics/growth?includeAdmins=false');
  const offSql = lastQueries.find((s) => /new_users_admin/.test(s));
  assert.match(offSql, /NOT IN \(SELECT id FROM users WHERE is_admin\)/,
    'with the box off, admin rows must still be excluded via the NOT-IN filter');

  lastQueries = [];
  await get('/api/admin/analytics/growth?includeAdmins=true');
  const onSql = lastQueries.find((s) => /new_users_admin/.test(s));
  assert.doesNotMatch(onSql, /NOT IN \(SELECT id FROM users WHERE is_admin\)/,
    'with the box on, admins are included so the NOT-IN filter is dropped (the split FILTER does the work)');
});

// ── 2. Source guards — route SQL companions ──────────────────────────────

test('route: overview is unchanged (no admin companions — cards aren\'t bars)', () => {
  const src = read('src/routes/dashboard.js');
  const start = src.indexOf("analytics/overview'");
  const end = src.indexOf("analytics/funnels'");
  const overview = src.slice(start, end);
  assert.doesNotMatch(overview, /_admin/, 'overview must not gain admin-split columns');
});

test('route: general-users returns the daily DAU/WAU/MAU series (#456 rework)', () => {
  const src = read('src/routes/dashboard.js');
  const start = src.indexOf("analytics/general-users'");
  assert.ok(start !== -1, 'general-users endpoint must exist');
  const body = src.slice(start, src.indexOf('router.get', start + 1));
  assert.match(body, /AS +dau\b/, 'general-users must return a dau column');
  assert.match(body, /AS +wau\b/, 'general-users must return a wau column');
  assert.match(body, /AS +mau\b/, 'general-users must return a mau column');
});

test('route: per-user endpoints select the is_admin row flag', () => {
  const src = read('src/routes/dashboard.js');
  const topStart = src.indexOf("analytics/top-users'");
  const sbbStart = src.indexOf("analytics/spend-by-builder'");
  assert.match(src.slice(topStart, sbbStart), /u\.is_admin AS is_admin/, 'top-users must select is_admin');
  assert.match(src.slice(sbbStart), /u\.is_admin AS is_admin/, 'spend-by-builder must select is_admin');
});

// ── 2b. Source guards — staging seed ─────────────────────────────────────

test('migrate: the admin-split staging seed is defined and invoked', () => {
  const src = read('src/db/migrate.js');
  assert.match(src, /await seedStagingDashboardAdminSplit\(pool\)/, 'seed must be called in migrate()');
  assert.ok(src.indexOf('async function seedStagingDashboardAdminSplit') !== -1,
    'seedStagingDashboardAdminSplit must be defined');
});

test('migrate: the seed is staging-gated, idempotent, fixture-tagged', () => {
  const src = read('src/db/migrate.js');
  const start = src.indexOf('async function seedStagingDashboardAdminSplit');
  const body = src.slice(start, src.indexOf('async function', start + 1));
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'must be a no-op outside staging');
  assert.match(body, /\[staging fixture\]/, 'seeded rows must carry the staging prefix');
  assert.match(body, /ON CONFLICT/, 'inserts must be idempotent');
  // Touches an admin actor and the source tables each admin-split chart reads.
  assert.match(body, /900030/, 'must attach activity to the seeded admin user');
  assert.match(body, /INTO chat_sessions/, 'must seed promoted/merged admin sessions');
  assert.match(body, /INTO app_activity/, 'must seed admin dapp activity');
  assert.match(body, /'dapp_active_day'/, 'must seed dapp_active_day events');
  assert.match(body, /'pr_promoted'/, 'must seed a pr_promoted event');
  assert.match(body, /INTO pr_kudos/, 'must seed a kudos given by the admin');
  assert.match(body, /INTO llm_usage/, 'must seed admin LLM spend for the Daily spend amber segment');
});

// ── 3. Client — per-card tooltips + amber colour ─────────────────────────

const CARD_IDS = [
  'total-users', 'new-7d', 'new-30d', 'wau-mau', 'apps',
  'promoted-open', 'promoted-all', 'merged-all', 'kudos', 'llm-today',
];

test('dashboard.js: a per-card tooltip definition exists for each of the ten cards', () => {
  const src = read('public/js/dashboard.js');
  const mapStart = src.indexOf('const CARD_INFO');
  assert.ok(mapStart !== -1, 'CARD_INFO map must be defined');
  const mapBody = src.slice(mapStart, src.indexOf('};', mapStart));
  for (const id of CARD_IDS) {
    assert.match(mapBody, new RegExp(`'${id}':`), `CARD_INFO must define '${id}'`);
  }
  // WAU/MAU definition must spell out both active-user windows.
  assert.match(mapBody, /WAU/);
  assert.match(mapBody, /MAU/);
});

test('dashboard.js: renderCounters renders + wires a (?) icon per card', () => {
  const src = read('public/js/dashboard.js');
  assert.match(src, /data-card-info="\$\{c\.id\}"/, 'each card must render a (?) icon');
  assert.match(src, /wireInfoIcon\(el, `card-\$\{c\.id\}`, CARD_INFO\[c\.id\]\)/,
    'each card icon must be registered in the tip store with focus wiring');
});

test('dashboard.js: the amber admin colour + Non-admin/Admin legend are wired', () => {
  const src = read('public/js/dashboard.js');
  assert.match(src, /const ADMIN_COLOR = '#f59e0b'/, 'amber admin colour constant must exist');
  assert.match(src, /function adminLegend/, 'a reusable Non-admin/Admin legend helper must exist');
  // barChart stacks admin sub-rects; funnel splits a second amber segment;
  // top-users swaps the fill; spend-by-builder uses an amber outline.
  assert.match(src, /opts\.adminValues/, 'barChart must accept a parallel admin series');
  assert.match(src, /stroke="\$\{ADMIN_COLOR\}"/, 'spend-by-builder must outline admin bars in amber');
});

test('dashboard.js: renderSpend stacks an amber admin segment on Daily spend', () => {
  const src = read('public/js/dashboard.js');
  const start = src.indexOf('function renderSpend');
  const end = src.indexOf('function renderSpendByBuilder');
  const body = src.slice(start, end);
  assert.ok(start !== -1 && end !== -1, 'renderSpend must be defined before renderSpendByBuilder');
  // Non-admin remainder = colour total minus the admin portion, clamped at 0.
  assert.match(body, /Math\.max\(0, plat\[i\] - pAdmin\)/,
    'platform/both modes must subtract the admin portion from the violet segment');
  assert.match(body, /Math\.max\(0, byok\[i\] - uAdmin\)/,
    'user/both modes must subtract the admin portion from the green segment');
  // The admin spend is drawn as an amber (ADMIN_COLOR) segment.
  assert.match(body, /color: ADMIN_COLOR/, 'admin spend must be stacked as an ADMIN_COLOR segment');
  // A dedicated "Admin spend" amber legend swatch when the box is on.
  assert.match(body, /Admin spend/, 'an "Admin spend" legend swatch must be added');
  assert.match(body, /hasAdminSpend/, 'the admin swatch must be gated on there being admin spend');
});

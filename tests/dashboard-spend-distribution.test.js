// Tests for the "Daily spend distribution" dashboard chart slice:
// GET /api/admin/analytics/spend-distribution + the staging seed + the
// client renderer wiring.
//
// The test runner has no live Postgres (the pool is mocked), so — like
// tests/dashboard-admin-split.test.js — this works in two layers:
//   1. Behavioural — mount the analytics router with a mocked pool and
//      assert the endpoint returns the seven bucket keys (b0..b6) per day,
//      and that the includeAdmins NOT-IN gate is woven into BOTH the paid-
//      bucket aggregate and the $0 (registered-as-of-day) subquery.
//   2. Source guards — pin the bucketing boundaries, the $20+ BYOK split
//      predicate, and the $0-derivation on src/routes/dashboard.js, the
//      staging seed contract on src/db/migrate.js, the dapp.json proposal
//      check, and the client renderer/INFO wiring on
//      public/js/admin-analytics.js (was public/js/dashboard.js +
//      public/dashboard.html before #860 folded the page into the
//      #admin/analytics console section).
//
// Run with: node --test tests/dashboard-spend-distribution.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. Behavioural: mounted router + mocked pool ────────────────────────

const poolMod = require('../src/db/pool');
let lastQueries = [];
function handler(sql) {
  lastQueries.push(sql);
  // The spend-distribution query is the only one selecting b6.
  if (/COALESCE\(a\.b6/.test(sql)) {
    return { rows: [
      { day: '2026-05-28', b0: 40, b1: 5, b2: 3, b3: 2, b4: 1, b5: 2, b6: 1 },
      { day: '2026-05-29', b0: 42, b1: 4, b2: 2, b3: 1, b4: 0, b5: 1, b6: 2 },
    ] };
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

test('spend-distribution: each day carries all seven bucket counts', async () => {
  const d = await get('/api/admin/analytics/spend-distribution?includeAdmins=true');
  assert.ok(Array.isArray(d.days), 'days array must be returned');
  const day = d.days[0];
  for (const k of ['day', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']) {
    assert.ok(k in day, `day.${k} missing`);
  }
  assert.equal(day.b0, 40);
  assert.equal(day.b5, 2); // $20+ capped
  assert.equal(day.b6, 1); // $20+ own key
});

test('spend-distribution: includeAdmins gates BOTH the bucket agg and the $0 subquery', async () => {
  lastQueries = [];
  await get('/api/admin/analytics/spend-distribution?includeAdmins=false');
  const offSql = lastQueries.find((s) => /COALESCE\(a\.b6/.test(s));
  // The per-user gate must appear twice: once on the llm_usage aggregate
  // (lu.user_id) and once on the registered-as-of-day subquery (u2.id), so
  // the $0 baseline is admin-consistent with the paid buckets.
  const notIns = offSql.match(/NOT IN \(SELECT id FROM users WHERE is_admin\)/g) || [];
  assert.equal(notIns.length, 2,
    'with the box off, both the bucket aggregate and the $0 subquery must exclude admins');

  lastQueries = [];
  await get('/api/admin/analytics/spend-distribution?includeAdmins=true');
  const onSql = lastQueries.find((s) => /COALESCE\(a\.b6/.test(s));
  assert.doesNotMatch(onSql, /NOT IN \(SELECT id FROM users WHERE is_admin\)/,
    'with the box on, admins are included so the NOT-IN filter is dropped everywhere');
});

// ── 2. Source guards — route SQL ─────────────────────────────────────────

test('route: bucket boundaries match the spec ($5/$10/$15/$20 in cents)', () => {
  const src = read('src/routes/dashboard.js');
  const start = src.indexOf("analytics/spend-distribution'");
  assert.ok(start > 0, 'spend-distribution endpoint must exist');
  const sql = src.slice(start, src.indexOf('return router;', start));
  // b1..b4 upper bounds and the $20+ threshold, in cents.
  assert.match(sql, /total_cost_cents > 0\s+AND lu\.total_cost_cents <= 500/, 'b1 = (0,500]');
  assert.match(sql, /total_cost_cents > 500\s+AND lu\.total_cost_cents <= 1000/, 'b2 = (500,1000]');
  assert.match(sql, /total_cost_cents > 1000\s+AND lu\.total_cost_cents <= 1500/, 'b3 = (1000,1500]');
  assert.match(sql, /total_cost_cents > 1500\s+AND lu\.total_cost_cents <\s+2000/, 'b4 = (1500,2000)');
  assert.match(sql, /total_cost_cents >= 2000/, '$20+ threshold = 2000 cents');
});

test('route: the $20+ tier splits on the BYOK "usable key" predicate', () => {
  const src = read('src/routes/dashboard.js');
  // Capability OR same-day own-key spend (the chosen, snapshot-corrected signal).
  assert.match(src, /u\.anthropic_key_enc IS NOT NULL OR lu\.byok_cost_cents > 0/,
    'BYOK predicate must be key-configured OR own-key spend that day');
  const start = src.indexOf("analytics/spend-distribution'");
  const sql = src.slice(start, src.indexOf('return router;', start));
  assert.match(sql, /total_cost_cents >= 2000 AND NOT \$\{byok\}/, 'b5 = $20+ capped (no usable key)');
  assert.match(sql, /total_cost_cents >= 2000 AND \$\{byok\}/, 'b6 = $20+ kept going (usable key)');
});

test('route: the $0 bucket is derived as registered-as-of-day minus paid buckets', () => {
  const src = read('src/routes/dashboard.js');
  const start = src.indexOf("analytics/spend-distribution'");
  const sql = src.slice(start, src.indexOf('return router;', start));
  assert.match(sql, /GREATEST\(0,/, '$0 derivation must clamp at 0');
  assert.match(sql, /FROM users u2\s+WHERE u2\.created_at::date <= s\.day/,
    '$0 baseline = users registered as of that day');
});

// ── 3. Staging seed guard — src/db/migrate.js ────────────────────────────

test('seed: seedStagingSpendDistribution is staging-gated and registered', () => {
  const src = read('src/db/migrate.js');
  assert.match(src, /async function seedStagingSpendDistribution\(pool\)/, 'seed fn must exist');
  assert.match(src, /await seedStagingSpendDistribution\(pool\);/, 'seed must be called from migrate()');
  const start = src.indexOf('async function seedStagingSpendDistribution');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.match(body, /USERNODE_ENV !== 'staging'/, 'seed must be a strict no-op outside staging');
});

test('seed: both $20+ sub-buckets are represented (own-key and no-key users)', () => {
  const src = read('src/db/migrate.js');
  const start = src.indexOf('async function seedStagingSpendDistribution');
  const body = src.slice(start, src.indexOf('\nasync function', start + 10));
  // A tier-5 user (capped, no key) and a tier-6 user (own key, anthropic_key_enc set).
  assert.match(body, /tier: 5/, 'must seed a $20+ capped user');
  assert.match(body, /tier: 6, key: true/, 'must seed a $20+ own-key user');
  // Own-key users get a non-null sentinel key; the chart only tests IS NOT NULL.
  assert.match(body, /anthropic_key_enc/, 'own-key users must set anthropic_key_enc');
  // Obviously-fake usernames, never real users.
  assert.match(body, /staging-demo-spend-/, 'fixtures must use the staging-demo-spend- prefix');
});

// ── 4. Proposal check + client wiring ────────────────────────────────────

test('dapp.json: a proposal check targets #admin/analytics with #spend-distribution', () => {
  // #860: the chart lives in the #admin/analytics console section now, and
  // the self-app is hash-routed — a plain /dashboard pathname would only
  // hit the redirect stub.
  const manifest = JSON.parse(read('dapp.json'));
  const t = (manifest.tests || []).find((x) => x.path === '/#admin/analytics' && x.expectSelector === '#spend-distribution');
  assert.ok(t, 'a /#admin/analytics test asserting #spend-distribution must be declared');
});

test('client: admin-analytics.js renders the chart, registers its INFO, and loads the endpoint', () => {
  const js = read('public/js/admin-analytics.js');
  assert.match(js, /function renderSpendDistribution\(\)/, 'renderer must exist');
  assert.match(js, /'spend-distribution':/, 'INFO entry must exist');
  assert.match(js, /analytics\/spend-distribution/, 'loadAll must fetch the endpoint');
  // Seven segments b0..b6 with the capped/own-key labels.
  for (const k of ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']) {
    assert.match(js, new RegExp(`key: '${k}'`), `segment ${k} must be defined`);
  }
  assert.match(js, /\$20\+ capped/, 'capped label must be present');
  assert.match(js, /\$20\+ own key/, 'own-key label must be present');
});

test('markup: admin-analytics.js mounts the #spend-distribution container', () => {
  const html = read('public/js/admin-analytics.js');
  assert.match(html, /id="spend-distribution"/, 'mount point must exist');
  assert.match(html, /data-info="spend-distribution"/, 'info icon must be wired');
});

// ── 5. "Hide $0 / Show $0" toggle ────────────────────────────────────────

test('html: the chart header carries a Hide/Show $0 toggle', () => {
  const html = read('public/js/admin-analytics.js');
  assert.match(html, /data-zero-toggle="spend-distribution"/, 'toggle group must exist');
  assert.match(html, /data-zero="hide"[^>]*>Hide \$0/, 'a "Hide $0" button must exist');
  assert.match(html, /data-zero="show"[^>]*>Show \$0/, 'a "Show $0" button must exist');
  // Hide is the default-active button (violet), Show is inactive (zinc).
  assert.match(
    html,
    /data-zero="hide" class="zero-btn[^"]*bg-violet-600/,
    'Hide $0 must be the default-active (violet) button',
  );
});

test('client: the renderer filters the $0 bucket unless the toggle is on', () => {
  const js = read('public/js/admin-analytics.js');
  // State var + persistence key, defaulting OFF (Hide $0).
  assert.match(js, /SPEND_DIST_ZERO_KEY\s*=\s*'dashSpendDistIncludeZero'/, 'localStorage key must be defined');
  assert.match(
    js,
    /let spendDistIncludeZero\s*=\s*localStorage\.getItem\(SPEND_DIST_ZERO_KEY\)\s*===\s*'true'/,
    'state must default to false (Hide $0) and read from localStorage',
  );
  // The b0 segment is dropped when the toggle is off, keeping all paid buckets.
  assert.match(
    js,
    /spendDistIncludeZero\s*\?\s*allSegs\s*:\s*allSegs\.filter\(\(s\)\s*=>\s*s\.key\s*!==\s*'b0'\)/,
    'segments must exclude b0 when Hide $0 is active',
  );
});

test('client: the toggle persists and re-renders without refetching', () => {
  const js = read('public/js/admin-analytics.js');
  assert.match(js, /function wireZeroToggle\(\)/, 'the toggle wiring fn must exist');
  assert.match(js, /wireZeroToggle\(\)/, 'the toggle must be wired in init()');
  // On click it persists the choice and re-renders from the cached payload.
  assert.match(js, /localStorage\.setItem\(SPEND_DIST_ZERO_KEY, String\(spendDistIncludeZero\)\)/, 'choice must persist');
  // wireZeroToggle re-renders directly; it must NOT trigger a data reload.
  const fn = js.slice(js.indexOf('function wireZeroToggle'), js.indexOf('function wireZeroToggle') + 1200);
  assert.match(fn, /renderSpendDistribution\(\)/, 'must re-render the chart');
  assert.ok(!/loadAll\(\)/.test(fn), 'must not refetch (no loadAll) on toggle');
});

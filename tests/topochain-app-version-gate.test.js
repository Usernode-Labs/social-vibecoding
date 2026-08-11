// The mobile release gate: POST /api/v4/app-version/check keeps its exact
// contract while gaining the telemetry the admin screen needs.
//
// The bug this addresses: with no active app_version_configs row the
// endpoint answers `upgrade: 0` to every caller — including builds that
// should be forced to update. That is correct per SPEC 1318, but it makes
// a switched-OFF gate indistinguishable from an UNUSED one, and nothing
// on the admin screen said which.
//
// The danger in fixing it is the fix itself: this endpoint is FULLY
// PUBLIC, so a telemetry write must not be able to turn a 200 into a 500.
// Most of this file is about that.
//
// Run with: node --test tests/topochain-app-version-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

// Minimal app around the public router with an injected pool. public.js
// destructures `getPool` at module load, so the pool module has to be
// swapped in require.cache and public.js re-required — the same idiom
// tests/topochain-public-api.test.js uses (withInjectedPool there).
function makeApp(queryImpl) {
  const poolPath = require.resolve(path.join(ROOT, 'src/db/pool.js'));
  const publicPath = require.resolve(path.join(ROOT, 'src/routes/topochain/public.js'));
  const authPath = require.resolve(path.join(ROOT, 'src/middleware/topochain-auth.js'));
  const standingsPath = require.resolve(path.join(ROOT, 'src/services/topochain/standings.js'));
  const original = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => ({ query: queryImpl }) },
    loaded: true, id: poolPath, filename: poolPath,
    paths: original ? original.paths : [],
  };
  delete require.cache[publicPath];
  delete require.cache[authPath];
  delete require.cache[standingsPath];
  try {
    const { topochainPublicRoutes } = require(publicPath);
    const app = express();
    app.use(express.json());
    app.use(topochainPublicRoutes({ databaseUrl: 'postgres://fake/fake' }));
    return app;
  } finally {
    if (original) require.cache[poolPath] = original;
    else delete require.cache[poolPath];
    delete require.cache[publicPath];
    delete require.cache[authPath];
    delete require.cache[standingsPath];
  }
}

async function post(app, body) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v4/app-version/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const VALID = { os: 'ios', app_version: '1.4.0', build_number: 50 };

// A pool where the config SELECT returns `configRows` and every other
// statement (i.e. the events INSERT) runs `onOther`.
function poolWith(configRows, onOther = async () => ({ rows: [] })) {
  return async (sql, params) => {
    if (/FROM app_version_configs/.test(sql)) return { rows: configRows };
    return onOther(sql, params);
  };
}

// ─── the contract is unchanged ──────────────────────────────────────────

test('with no config row: all three keys, upgrade 0', async () => {
  const res = await post(makeApp(poolWith([])), VALID);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    success: true, data: { upgrade: 0, details: null, update_url: null },
  });
});

test('below min_build_number: forced update with the URL', async () => {
  const res = await post(makeApp(poolWith([{
    min_build_number: 100, recommended_build_number: 110,
    must_update_message: 'Update now.', should_update_message: null,
    update_url: 'https://example.invalid/ios',
  }])), VALID);
  assert.equal(res.body.data.upgrade, 2);
  assert.equal(res.body.data.details, 'Update now.');
  assert.equal(res.body.data.update_url, 'https://example.invalid/ios');
});

test('between recommended and min: suggested update', async () => {
  const res = await post(makeApp(poolWith([{
    min_build_number: 10, recommended_build_number: 100,
    must_update_message: null, should_update_message: 'New version out.',
    update_url: 'https://example.invalid/ios',
  }])), VALID);
  assert.equal(res.body.data.upgrade, 1);
  assert.equal(res.body.data.details, 'New version out.');
});

test('at or above both: upgrade 0 and NO update_url', async () => {
  const res = await post(makeApp(poolWith([{
    min_build_number: 10, recommended_build_number: 20,
    must_update_message: null, should_update_message: null,
    update_url: 'https://example.invalid/ios',
  }])), VALID);
  assert.deepEqual(res.body.data, { upgrade: 0, details: null, update_url: null });
});

test('validation still 422s before anything is recorded', async () => {
  let wrote = false;
  const app = makeApp(poolWith([], async () => { wrote = true; return { rows: [] }; }));
  const res = await post(app, { os: 'windows', app_version: '1', build_number: 1 });
  assert.equal(res.status, 422);
  assert.equal(res.body.success, false);
  assert.ok(!wrote, 'a rejected request must not be counted as a version check');
});

// ─── the telemetry write can never break the endpoint ───────────────────

test('a throwing events write still returns a normal 200', async () => {
  const app = makeApp(poolWith([], async (sql) => {
    if (/INSERT INTO events/.test(sql)) throw new Error('events table is on fire');
    return { rows: [] };
  }));
  const res = await post(app, VALID);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { upgrade: 0, details: null, update_url: null });
});

test('a rejecting events write still returns a normal 200', async () => {
  const app = makeApp(poolWith([{
    min_build_number: 100, recommended_build_number: null,
    must_update_message: null, should_update_message: null, update_url: null,
  }], async (sql) => {
    if (/INSERT INTO events/.test(sql)) return Promise.reject(new Error('deadlock'));
    return { rows: [] };
  }));
  const res = await post(app, VALID);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.upgrade, 2);
});

test('both outcomes are recorded, with os and upgrade', async () => {
  const writes = [];
  const app = makeApp(poolWith([{
    min_build_number: 100, recommended_build_number: null,
    must_update_message: null, should_update_message: null, update_url: null,
  }], async (sql, params) => {
    if (/INSERT INTO events/.test(sql)) writes.push(params);
    return { rows: [] };
  }));
  await post(app, VALID);

  assert.equal(writes.length, 1, 'exactly one row per check');
  const [, , , type, metadata] = writes[0];
  assert.equal(type, 'app_version_checked');
  assert.deepEqual(JSON.parse(metadata), { os: 'ios', upgrade: 2 });
});

test('the no-config path records too (that is the case being diagnosed)', async () => {
  const writes = [];
  const app = makeApp(poolWith([], async (sql, params) => {
    if (/INSERT INTO events/.test(sql)) writes.push(params);
    return { rows: [] };
  }));
  await post(app, { ...VALID, os: 'android' });
  assert.equal(writes.length, 1,
    'without this, "gate off" and "no traffic" stay indistinguishable');
  assert.deepEqual(JSON.parse(writes[0][4]), { os: 'android', upgrade: 0 });
});

// ─── the admin surface ──────────────────────────────────────────────────

test('check-activity is registered ahead of GET /:id', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/routes/topochain/admin/app-version-configs.js'), 'utf8');
  const activity = src.indexOf("'/api/v4/admin/app-version-configs/check-activity'");
  const byId = src.indexOf("router.get('/api/v4/admin/app-version-configs/:id'");
  assert.ok(activity > -1 && byId > -1);
  assert.ok(activity < byId, 'otherwise check-activity is parsed as an id');
});

test('check-activity windows to 7 days and groups by os + upgrade', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/routes/topochain/admin/app-version-configs.js'), 'utf8');
  const block = src.slice(src.indexOf('check-activity'), src.indexOf('SPEC 2753-2769'));
  assert.match(block, /event_type = 'app_version_checked'/);
  assert.match(block, /INTERVAL '7 days'/);
  assert.match(block, /GROUP BY 1, 2/);
});

test('the admin screen warns per-OS when no ACTIVE rule exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/features/admin/admin-topochain.js'), 'utf8');
  const fn = src.slice(src.indexOf('_renderAppVersionGate() {'),
    src.indexOf('async _loadAppVersionActivity('));
  // An inactive row is as good as no row for the gate, so the check must
  // test is_active — not merely the row's existence.
  assert.match(fn, /c\.os === os && c\.is_active/);
  assert.match(fn, /\['ios', 'android'\]/, 'both platforms are checked');
  assert.match(fn, /No active version rule/);
});

test('the build-number fields say what each one triggers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/features/admin/admin-topochain.js'), 'utf8');
  const form = src.slice(src.indexOf('admin-topo-av-f-min_build_number'),
    src.indexOf('admin-topo-av-f-is_active'));
  assert.match(form, /FORCED update/);
  assert.match(form, /SUGGESTED update/);
  // The footgun worth naming: a forced update with no URL strands the user.
  assert.match(form, /nowhere to go/);
});

test('the seed leaves one OS inactive so the warning is reviewable', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/db/migrate.js'), 'utf8');
  const block = src.slice(src.indexOf('INSERT INTO app_version_configs'));
  const rows = block.slice(0, block.indexOf('ON CONFLICT'));
  assert.match(rows, /'ios', 100, 110, '1\.4\.0', TRUE/, 'iOS stays active');
  assert.match(rows, /'android', 90, 95, '1\.4\.0', FALSE/,
    'Android is inactive so the "no active rule" banner renders in a preview');
});

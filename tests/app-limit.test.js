'use strict';

// The server-wide app limit as an admin setting (services/app-limit.js).
//
// MAX_APPS was an environment variable only, and the Kubernetes deploy's
// chart does not pass it through, so "Ask an admin to … raise the limit"
// asked for something no admin could do. The limit is now stored in
// platform_settings and edited in Admin → Limits. Pinned here:
//
//   1. The precedence: MAX_APPS <= 0 is an absolute off switch (evidence
//      runtimes rely on it over a cloned production setting), then the
//      admin's setting, then MAX_APPS.
//   2. The read is cached per pool, invalidated by a write, and fails safe
//      to MAX_APPS.
//   3. GET/PUT /api/admin/app-limit: validation, the 409 when the deploy
//      switched the cap off, and the audit columns.
//   4. Every reader resolves the cap through effective() — no route reads
//      config.maxApps for it any more.
//   5. The console card.
//
// Run with: node --test tests/app-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A stateful platform_settings + apps store, shared by the service tests
// and the mounted admin router (which reads getPool() once, at mount).
function makeStore({ setting = null, live = 12, failReads = false } = {}) {
  const state = {
    setting, live, failReads, queries: [],
    updatedBy: null,
  };
  return {
    state,
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (/FROM platform_settings s/.test(sql)) {
        if (state.failReads) throw new Error('db down');
        return {
          rows: state.setting == null ? [] : [{
            value: String(state.setting), updated_at: '2026-09-26T12:00:00.000Z',
            updated_by: state.updatedBy,
          }],
        };
      }
      if (/INSERT INTO platform_settings/.test(sql)) {
        state.setting = params[1];
        state.updatedBy = params[2] === 1 ? 'root' : null;
        return { rows: [] };
      }
      if (/DELETE FROM platform_settings WHERE key/.test(sql)) {
        state.setting = null;
        return { rows: [] };
      }
      if (/SELECT COUNT\(\*\)::int AS n FROM apps WHERE status <> 'error'/.test(sql)) {
        return { rows: [{ n: state.live }] };
      }
      return { rows: [] };
    },
  };
}

const appLimit = require('../src/services/app-limit');

// ─── 1. Precedence ──────────────────────────────────────────────────────

test('the admin setting wins over MAX_APPS; with none stored, MAX_APPS applies', async () => {
  assert.equal(await appLimit.effective(makeStore({ setting: 80 }), { maxApps: 50 }), 80);
  assert.equal(await appLimit.effective(makeStore({ setting: 20 }), { maxApps: 50 }), 20,
    'a setting below MAX_APPS is honoured too: it is a setting, not a raise-only floor');
  assert.equal(await appLimit.effective(makeStore(), { maxApps: 50 }), 50);
});

test('MAX_APPS <= 0 switches the cap off, the stored setting included, without reading it', async () => {
  // Evidence runtimes set MAX_APPS=0 over a database cloned from production;
  // a production setting must not put the cap back there.
  for (const maxApps of [0, -1, undefined, 'nonsense']) {
    const store = makeStore({ setting: 10 });
    assert.equal(await appLimit.effective(store, { maxApps }), 0, String(maxApps));
    assert.equal(store.state.queries.length, 0, 'no database read when the cap is off');
  }
});

test('a stored value that is not a usable limit is ignored', async () => {
  for (const bad of ['0', '-3', 'abc', '', '100001']) {
    assert.equal(await appLimit.effective(makeStore({ setting: bad }), { maxApps: 50 }), 50, bad);
  }
});

// ─── 2. Cache and failure ───────────────────────────────────────────────

test('the read is cached per pool and a write invalidates it', async () => {
  const store = makeStore({ setting: 80 });
  const config = { maxApps: 50 };
  assert.equal(await appLimit.effective(store, config), 80);
  store.state.setting = 90; // someone else's write, not through set()
  assert.equal(await appLimit.effective(store, config), 80, 'cached within the TTL');
  await appLimit.set(store, { value: 100, actorId: 1 });
  assert.equal(await appLimit.effective(store, config), 100, 'set() invalidates this pool');
  // A different pool never sees this one's cache.
  assert.equal(await appLimit.effective(makeStore({ setting: 7 }), config), 7);
  assert.equal(appLimit.CACHE_TTL_MS, 10 * 1000);
});

test('an unreadable setting falls back to MAX_APPS rather than dropping the cap', async () => {
  assert.equal(await appLimit.effective(makeStore({ setting: 80, failReads: true }), { maxApps: 50 }), 50);
});

test('validate accepts a whole number from 1 to the ceiling, or null to clear', () => {
  assert.equal(appLimit.validate(null), null);
  assert.equal(appLimit.validate(1), null);
  assert.equal(appLimit.validate(appLimit.MAX_SETTING), null);
  for (const bad of [0, -1, 1.5, '80', undefined, NaN, appLimit.MAX_SETTING + 1, {}]) {
    assert.equal(typeof appLimit.validate(bad), 'string', String(bad));
  }
});

test('set() upserts with the actor, and null deletes the row', async () => {
  const store = makeStore();
  await appLimit.set(store, { value: 75, actorId: 1 });
  const insert = store.state.queries.find((q) => /INSERT INTO platform_settings/.test(q.sql));
  assert.deepEqual(insert.params, ['max_apps', '75', 1]);
  assert.match(insert.sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(insert.sql, /updated_by = EXCLUDED\.updated_by/);
  await appLimit.set(store, { value: null, actorId: 1 });
  assert.equal(store.state.setting, null);
});

test('adminPayload says what is in force and where it comes from', async () => {
  const config = { maxApps: 50 };
  assert.deepEqual(
    await appLimit.adminPayload(makeStore({ live: 48 }), config),
    { limit: 50, source: 'default', defaultLimit: 50, setting: null, used: 48,
      max: appLimit.MAX_SETTING, warnPercent: 80 });
  const admin = await appLimit.adminPayload(makeStore({ setting: 120, live: 48 }), config);
  assert.equal(admin.limit, 120);
  assert.equal(admin.source, 'admin');
  assert.equal(admin.setting.value, 120);
  const off = await appLimit.adminPayload(makeStore({ setting: 120, live: 48 }), { maxApps: 0 });
  assert.equal(off.limit, 0);
  assert.equal(off.source, 'disabled');
  assert.equal(off.setting, null);
});

// ─── 3. The admin routes ────────────────────────────────────────────────

async function mount(store, user, config = { jwtSecret: 'test', maxApps: 50 }) {
  const poolMod = require('../src/db/pool');
  const prior = poolMod.getPool;
  poolMod.getPool = () => store;
  const { adminRoutes } = require('../src/routes/admin');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(adminRoutes(config));
  poolMod.getPool = prior;
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, body) => {
    const res = await fetch(`${base}/api/admin/app-limit`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => server.close() };
}

const FULL_ADMIN = { id: 1, username: 'root', isAdmin: true, canAdminWrite: true };
const VIEW_ADMIN = { id: 2, username: 'viewer', isAdmin: true, canAdminWrite: false, adminReadonly: true };

test('PUT stores the limit, GET reads it back, and null goes back to MAX_APPS', async () => {
  const store = makeStore({ live: 49 });
  const { call, close } = await mount(store, FULL_ADMIN);
  try {
    let res = await call('GET');
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 50);
    assert.equal(res.body.source, 'default');
    assert.equal(res.body.used, 49);

    res = await call('PUT', { limit: 100 });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 100);
    assert.equal(res.body.source, 'admin');
    assert.equal(res.body.setting.updatedBy, 'root', 'the audit trail names who set it');

    res = await call('PUT', { limit: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 50);
    assert.equal(res.body.source, 'default');
  } finally {
    close();
  }
});

test('PUT refuses a bad value, a missing field, and a deploy that switched the cap off', async () => {
  const store = makeStore();
  const { call, close } = await mount(store, FULL_ADMIN);
  try {
    for (const bad of [0, -5, 2.5, '100', appLimit.MAX_SETTING + 1]) {
      const res = await call('PUT', { limit: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body.error, /app limit/i);
    }
    const missing = await call('PUT', {});
    assert.equal(missing.status, 400);
    assert.ok(!store.state.queries.some((q) => /INSERT INTO platform_settings/.test(q.sql)),
      'nothing was written');
  } finally {
    close();
  }
  const off = await mount(makeStore(), FULL_ADMIN, { jwtSecret: 'test', maxApps: 0 });
  try {
    const res = await off.call('PUT', { limit: 100 });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /switched the app limit off/);
  } finally {
    off.close();
  }
});

test('a view-only admin can read the limit but not change it', async () => {
  const store = makeStore();
  const { call, close } = await mount(store, VIEW_ADMIN);
  try {
    assert.equal((await call('GET')).status, 200);
    const res = await call('PUT', { limit: 100 });
    assert.equal(res.status, 403);
    assert.equal(store.state.setting, null);
  } finally {
    close();
  }
  const src = read('src/routes/admin.js');
  assert.match(src, /router\.put\('\/api\/admin\/app-limit', requireAdminWrite,/);
});

// ─── 4. Every reader goes through effective() ───────────────────────────

test('no route reads config.maxApps for the cap; each asks the resolver', () => {
  for (const rel of ['src/routes/apps.js', 'src/routes/auth.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /config\.maxApps/, `${rel} reads the cap through services/app-limit.js`);
    assert.match(src, /appLimit\.effective\(pool, config\)/);
  }
  const apps = read('src/routes/apps.js');
  // Both write routes, and full admins still bypass without a read.
  assert.equal((apps.match(/const maxApps = req\.user\?\.canAdminWrite \? 0 : await appLimit\.effective\(pool, config\);/g) || []).length, 2);
  assert.equal((apps.match(/This server is at its app limit \(\$\{maxApps\}\)/g) || []).length, 2,
    'the refusal names the cap it enforced');
  // The alerts measure the same cap, and the staging fixture fills to it.
  assert.match(read('src/services/platform-limit-alerts.js'), /cap: \(config, pool\) => appLimit\.effective\(pool, config\)/);
  assert.match(read('src/db/migrate.js'), /require\('\.\.\/services\/app-limit'\)\.effective\(pool, config\)/);
});

// ─── 5. The console card ────────────────────────────────────────────────

test('the App limit card renders its ids and stays disabled until it has read the limit', () => {
  globalThis.window = globalThis.window || globalThis;
  const mod = loadTsx('frontend/src/features/admin/admin-limits.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => (key === 'btn' ? new Proxy({}, { get: () => 'btn' }) : String(key)) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const html = renderToHtml(createElement(mod.AppLimitCard, { canWrite: true }));
  assert.match(html, /id="admin-app-limit"/);
  assert.match(html, /id="admin-app-limit-usage"/);
  assert.match(html, />App limit</);
  assert.match(html, /How many live apps the whole server allows/);
  assert.match(html, /id="admin-app-limit-input"[^>]*disabled=""/, 'no edits before the read lands');
  assert.match(html, /id="admin-save-app-limit-btn"[^>]*disabled=""/);
  assert.doesNotMatch(html, /—/, 'no em dash in the copy');

  const viewOnly = renderToHtml(createElement(mod.AppLimitCard, { canWrite: false }));
  assert.doesNotMatch(viewOnly, /admin-save-app-limit-btn/, 'a view-only admin gets no Save');
  assert.match(viewOnly, /id="admin-app-limit-input"[^>]*disabled=""/);
});

test('the section is called Limits now that it holds more than spend', () => {
  assert.match(read('frontend/src/features/admin/admin-console.js'),
    /\{ key: 'limits', label: 'Limits', group: 'People' \}/);
});

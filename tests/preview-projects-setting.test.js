'use strict';

// Projects in previews as an admin setting, on by default
// (services/preview-projects-setting.js). It was a chart value, off by
// default, so turning it on took an infra commit. Pinned here:
//
//   1. The precedence: never in a preview, only on Kubernetes, the
//      operator's PREVIEW_PROJECTS_ENABLED=false absolute, then the admin's
//      setting, then on.
//   2. The read is cached per pool, invalidated by a write, and fails safe
//      to the default.
//   3. GET/PUT /api/admin/preview-projects: validation, permissions, the 409
//      when the deploy decides, and the audit columns.
//   4. The console card in Admin > Limits.
//
// Run with: node --test tests/preview-projects-setting.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const setting = require('../src/services/preview-projects-setting');

const CONFIG = { jwtSecret: 'test', appRuntime: 'kubernetes', previewProjectsEnabled: true, selfAppSlug: 'usernode-2d5619' };

// A stateful platform_settings store, shared by the service tests and the
// mounted admin router (which reads getPool() once, at mount).
function makeStore({ value = null, live = 2, failReads = false } = {}) {
  const state = { value, live, failReads, queries: [], updatedBy: null };
  return {
    state,
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (/FROM platform_settings s/.test(sql)) {
        if (state.failReads) throw new Error('db down');
        return { rows: state.value == null ? [] : [{ value: state.value, updated_at: '2026-10-28T14:00:00Z', updated_by: state.updatedBy }] };
      }
      if (/INSERT INTO platform_settings/.test(sql)) {
        state.value = params[1];
        state.updatedBy = params[2] === 1 ? 'root' : null;
        return { rows: [] };
      }
      if (/DELETE FROM platform_settings/.test(sql)) { state.value = null; return { rows: [] }; }
      if (/FROM preview_projects/.test(sql)) return { rows: [{ n: state.live }] };
      throw new Error(`unstubbed: ${sql.slice(0, 60)}`);
    },
  };
}

function inProduction(fn) {
  const saved = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = saved;
  });
}

// ─── 1. The precedence ──────────────────────────────────────────────────

test('on by default; the admin turns it off and on; the operator\'s off and the deploy win', () => inProduction(async () => {
  assert.equal(await setting.enabled(CONFIG, makeStore()), true, 'nothing stored: on');
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'off' })), false);
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'on' })), true);
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'garbled' })), true, 'an unreadable value is no setting');

  const off = makeStore({ value: 'on' });
  assert.equal(await setting.enabled({ ...CONFIG, previewProjectsEnabled: false }, off), false, 'the operator\'s switch is absolute');
  assert.equal(off.state.queries.length, 0, 'and reads nothing');
  assert.equal(await setting.enabled({ ...CONFIG, appRuntime: 'docker' }, makeStore({ value: 'on' })), false, 'Kubernetes only');
  process.env.USERNODE_ENV = 'staging';
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'on' })), false, 'never in a preview');
}));

test('the config reads the chart\'s value as an off switch: unset or anything but "false" leaves the admin to decide', () => {
  const read = (v) => {
    const saved = process.env.PREVIEW_PROJECTS_ENABLED;
    if (v === undefined) delete process.env.PREVIEW_PROJECTS_ENABLED; else process.env.PREVIEW_PROJECTS_ENABLED = v;
    try { return process.env.PREVIEW_PROJECTS_ENABLED !== 'false'; } finally {
      if (saved === undefined) delete process.env.PREVIEW_PROJECTS_ENABLED; else process.env.PREVIEW_PROJECTS_ENABLED = saved;
    }
  };
  assert.equal(read(undefined), true);
  assert.equal(read('true'), true);
  assert.equal(read('false'), false);
  const config = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'config.js'), 'utf8');
  assert.match(config, /previewProjectsEnabled: process\.env\.PREVIEW_PROJECTS_ENABLED !== 'false'/);
});

// ─── 2. The read ────────────────────────────────────────────────────────

test('the read is cached per pool, a write clears it, and a failed read falls back to on', () => inProduction(async () => {
  const store = makeStore({ value: 'off' });
  assert.equal(await setting.enabled(CONFIG, store), false);
  store.state.value = 'on';
  assert.equal(await setting.enabled(CONFIG, store), false, 'cached for a few seconds');
  setting.invalidate(store);
  assert.equal(await setting.enabled(CONFIG, store), true);
  await setting.set(store, { value: false, actorId: 1 });
  assert.equal(await setting.enabled(CONFIG, store), false, 'a write is seen at once on its own server');
  assert.equal(await setting.enabled(CONFIG, makeStore({ failReads: true })), true);
}));

test('validate takes true, false or null; set upserts with the actor, and null deletes the row', async () => {
  for (const ok of [true, false, null]) assert.equal(setting.validate(ok), null);
  for (const bad of ['on', 1, 0, undefined, {}]) assert.equal(typeof setting.validate(bad), 'string', String(bad));
  const store = makeStore();
  await setting.set(store, { value: true, actorId: 1 });
  const insert = store.state.queries.find((q) => /INSERT INTO platform_settings/.test(q.sql));
  assert.deepEqual(insert.params, ['preview_projects', 'on', 1]);
  assert.match(insert.sql, /ON CONFLICT \(key\) DO UPDATE/);
  await setting.set(store, { value: false, actorId: 1 });
  assert.equal(store.state.value, 'off');
  await setting.set(store, { value: null, actorId: 1 });
  assert.equal(store.state.value, null);
});

test('adminPayload says whether it is on and why, with how many projects previews have made', () => inProduction(async () => {
  const fresh = await setting.adminPayload(makeStore({ live: 2 }), CONFIG);
  assert.deepEqual({ ...fresh, perPreview: undefined, total: undefined },
    { enabled: true, source: 'default', setting: null, live: 2, perPreview: undefined, total: undefined });
  assert.ok(fresh.perPreview > 0 && fresh.total >= fresh.perPreview);
  const admin = await setting.adminPayload(makeStore({ value: 'off' }), CONFIG);
  assert.equal(admin.enabled, false);
  assert.equal(admin.source, 'admin');
  assert.equal(admin.setting.value, false);
  const off = await setting.adminPayload(makeStore({ value: 'on' }), { ...CONFIG, previewProjectsEnabled: false });
  assert.deepEqual([off.enabled, off.source, off.setting], [false, 'off', null]);
  const docker = await setting.adminPayload(makeStore(), { ...CONFIG, appRuntime: 'docker' });
  assert.equal(docker.source, 'unsupported');
}));

// ─── 3. The admin routes ────────────────────────────────────────────────

async function mount(store, user, config = CONFIG) {
  const poolMod = require('../src/db/pool');
  const prior = poolMod.getPool;
  poolMod.getPool = () => store;
  // admin.js takes getPool when it loads, so a mount after the first would
  // keep the first one's store: load it fresh for each.
  delete require.cache[require.resolve('../src/routes/admin')];
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
    const res = await fetch(`${base}/api/admin/preview-projects`, {
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

test('a full admin turns it off and on, and null goes back to the default', () => inProduction(async () => {
  const store = makeStore();
  const { call, close } = await mount(store, FULL_ADMIN);
  try {
    let res = await call('GET');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.source, 'default');

    res = await call('PUT', { enabled: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.source, 'admin');
    assert.equal(res.body.setting.updatedBy, 'root', 'the audit trail names who set it');

    res = await call('PUT', { enabled: null });
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.source, 'default');

    assert.equal((await call('PUT', {})).status, 400);
    assert.equal((await call('PUT', { enabled: 'off' })).status, 400);
  } finally {
    close();
  }
}));

test('a view-only admin reads it but cannot change it; the deploy\'s off switch leaves nothing to set', () => inProduction(async () => {
  const viewer = await mount(makeStore({ value: 'off' }), VIEW_ADMIN);
  try {
    assert.equal((await viewer.call('GET')).body.enabled, false);
    assert.equal((await viewer.call('PUT', { enabled: true })).status, 403);
  } finally {
    viewer.close();
  }
  const store = makeStore();
  const off = await mount(store, FULL_ADMIN, { ...CONFIG, previewProjectsEnabled: false });
  try {
    const res = await off.call('PUT', { enabled: true });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /PREVIEW_PROJECTS_ENABLED is false/);
    assert.equal(store.state.value, null, 'nothing was stored');
  } finally {
    off.close();
  }
}));

// ─── 4. The console card ────────────────────────────────────────────────

test('the Projects in previews card renders its ids and offers nothing until it has read the setting', () => {
  globalThis.window = globalThis.window || globalThis;
  const mod = loadTsx('frontend/src/features/admin/admin-limits.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => (key === 'btn' ? new Proxy({}, { get: () => 'btn' }) : String(key)) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const html = renderToHtml(createElement(mod.PreviewProjectsCard, { canWrite: true }));
  assert.match(html, /id="admin-preview-projects"/);
  assert.match(html, /id="admin-preview-projects-state"/);
  assert.match(html, />Projects in previews</);
  assert.match(html, /make projects inside the preview of a Homeroom change/);
  assert.doesNotMatch(html, /admin-preview-projects-toggle-btn/, 'no button before the read lands');
  assert.doesNotMatch(html, /—/, 'no em dash in the copy');
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'src', 'features', 'admin', 'admin-limits.tsx'), 'utf8');
  assert.match(source, /<GithubBudgetCard \/>\s*<PreviewProjectsCard canWrite=\{canWrite\} \/>/, 'it sits in Limits, after the limits and GitHub\'s budget');
});

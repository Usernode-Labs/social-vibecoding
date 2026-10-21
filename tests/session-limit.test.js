'use strict';

// The platform-wide session cap as an admin setting
// (services/session-limit.js).
//
// MAX_GLOBAL_SESSIONS was an environment variable only. On the Kubernetes
// deploy it lives in the infra repository's chart, so on 19 Oct 2026, at
// 133 of 140, raising it meant an infra commit and a rollout. The cap is now
// stored in platform_settings and edited in Admin → Limits, like the app
// limit (tests/app-limit.test.js). Pinned here:
//
//   1. The precedence: the admin's setting, then MAX_GLOBAL_SESSIONS.
//   2. The read is cached per pool, invalidated by a write, and fails safe
//      to MAX_GLOBAL_SESSIONS.
//   3. GET/PUT /api/admin/session-limit: validation, permissions and the
//      audit columns.
//   4. Every reader resolves the cap through effective(): the start, resume
//      and reopen gate, the proposal machine's Resume, the limit alert and
//      the status page.
//   5. The console card, with the cluster quota beside the field.
//
// Run with: node --test tests/session-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A stateful platform_settings + chat_sessions store, shared by the service
// tests and the mounted admin router (which reads getPool() once, at mount).
function makeStore({ setting = null, used = 131, failReads = false } = {}) {
  const state = { setting, used, failReads, queries: [], updatedBy: null };
  return {
    state,
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (/FROM platform_settings s/.test(sql)) {
        if (state.failReads) throw new Error('db down');
        return {
          rows: state.setting == null ? [] : [{
            value: String(state.setting), updated_at: '2026-10-19T12:00:00.000Z', updated_by: state.updatedBy,
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
      if (/FROM chat_sessions/.test(sql) && /status IN \('active', 'promoted'\)/.test(sql)) {
        return { rows: [{ cnt: state.used }] };
      }
      return { rows: [] };
    },
  };
}

const sessionLimit = require('../src/services/session-limit');

// ─── 1. Precedence ──────────────────────────────────────────────────────

test('the admin setting wins over MAX_GLOBAL_SESSIONS; with none stored, MAX_GLOBAL_SESSIONS applies', async () => {
  assert.equal(await sessionLimit.effective(makeStore({ setting: 180 }), { maxGlobalSessions: 140 }), 180);
  assert.equal(await sessionLimit.effective(makeStore({ setting: 60 }), { maxGlobalSessions: 140 }), 60,
    'a setting below the deploy value is honoured too: it is a setting, not a raise-only floor');
  assert.equal(await sessionLimit.effective(makeStore(), { maxGlobalSessions: 140 }), 140);
  // What the readers used when config carried no cap.
  assert.equal(await sessionLimit.effective(makeStore(), null), 100);
  assert.equal(await sessionLimit.effective(makeStore(), {}), 100);
});

test('a stored value that is not a usable limit is ignored', async () => {
  for (const bad of ['0', '-3', 'abc', '', String(sessionLimit.MAX_SETTING + 1)]) {
    assert.equal(await sessionLimit.effective(makeStore({ setting: bad }), { maxGlobalSessions: 140 }), 140, bad);
  }
});

// ─── 2. Cache and failure ───────────────────────────────────────────────

test('the read is cached per pool and a write invalidates it', async () => {
  const store = makeStore({ setting: 180 });
  const config = { maxGlobalSessions: 140 };
  assert.equal(await sessionLimit.effective(store, config), 180);
  store.state.setting = 200; // someone else's write, not through set()
  assert.equal(await sessionLimit.effective(store, config), 180, 'cached within the TTL');
  await sessionLimit.set(store, { value: 220, actorId: 1 });
  assert.equal(await sessionLimit.effective(store, config), 220, 'set() invalidates this pool');
  assert.equal(await sessionLimit.effective(makeStore({ setting: 7 }), config), 7, 'pools never share a cache');
  assert.equal(sessionLimit.CACHE_TTL_MS, 10 * 1000);
});

test('an unreadable setting falls back to MAX_GLOBAL_SESSIONS rather than dropping the cap', async () => {
  assert.equal(await sessionLimit.effective(makeStore({ setting: 180, failReads: true }), { maxGlobalSessions: 140 }), 140);
});

test('validate accepts a whole number from 1 to the ceiling, or null to clear', () => {
  assert.equal(sessionLimit.validate(null), null);
  assert.equal(sessionLimit.validate(1), null);
  assert.equal(sessionLimit.validate(sessionLimit.MAX_SETTING), null);
  for (const bad of [0, -1, 1.5, '180', undefined, NaN, sessionLimit.MAX_SETTING + 1, {}]) {
    assert.equal(typeof sessionLimit.validate(bad), 'string', String(bad));
  }
});

test('set() upserts with the actor, and null deletes the row', async () => {
  const store = makeStore();
  await sessionLimit.set(store, { value: 180, actorId: 1 });
  const insert = store.state.queries.find((q) => /INSERT INTO platform_settings/.test(q.sql));
  assert.deepEqual(insert.params, ['max_global_sessions', '180', 1]);
  assert.match(insert.sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(insert.sql, /updated_by = EXCLUDED\.updated_by/);
  await sessionLimit.set(store, { value: null, actorId: 1 });
  assert.equal(store.state.setting, null);
});

test('adminPayload says what is in force, where it comes from, and how many count against it', async () => {
  const config = { maxGlobalSessions: 140 };
  assert.deepEqual(
    await sessionLimit.adminPayload(makeStore({ used: 131 }), config),
    { limit: 140, source: 'default', defaultLimit: 140, setting: null, used: 131,
      max: sessionLimit.MAX_SETTING, warnPercent: 80, quota: null });
  const admin = await sessionLimit.adminPayload(makeStore({ setting: 180, used: 131 }), config);
  assert.equal(admin.limit, 180);
  assert.equal(admin.source, 'admin');
  assert.equal(admin.setting.value, 180);
});

test('the quota beside the field is the namespaces\' pods, CPU and memory requests, and nothing off Kubernetes', async () => {
  const kubernetes = require('../src/services/kubernetes');
  const prior = kubernetes.listNamespaceCapacity;
  kubernetes.listNamespaceCapacity = async () => [
    { namespace: 'social-apps', resources: {
      pods: { used: '249', hard: '320', percent: 77.8 },
      requestsCpu: { used: '24750m', hard: '32', percent: 77.3 },
      requestsMemory: { used: '31Gi', hard: '44Gi', percent: 70.5 },
      secrets: { used: '10', hard: '100', percent: 10 },
    } },
    { namespace: 'social-workers', quotaName: null, resources: null },
  ];
  try {
    assert.equal(await sessionLimit.readQuota({ appRuntime: 'docker' }), null);
    assert.deepEqual(await sessionLimit.readQuota({ appRuntime: 'kubernetes' }), [{
      namespace: 'social-apps',
      pods: { used: '249', hard: '320', percent: 77.8 },
      requestsCpu: { used: '24750m', hard: '32', percent: 77.3 },
      requestsMemory: { used: '31Gi', hard: '44Gi', percent: 70.5 },
    }]);
    kubernetes.listNamespaceCapacity = async () => { throw new Error('forbidden'); };
    assert.equal(await sessionLimit.readQuota({ appRuntime: 'kubernetes' }), null, 'a failed read draws no quota');
  } finally {
    kubernetes.listNamespaceCapacity = prior;
  }
});

// ─── 3. The admin routes ────────────────────────────────────────────────

async function mount(store, user, config = { jwtSecret: 'test', maxGlobalSessions: 140 }) {
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
    const res = await fetch(`${base}/api/admin/session-limit`, {
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

test('PUT stores the limit, GET reads it back, and null goes back to MAX_GLOBAL_SESSIONS', async () => {
  const store = makeStore({ used: 133 });
  const { call, close } = await mount(store, FULL_ADMIN);
  try {
    let res = await call('GET');
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 140);
    assert.equal(res.body.source, 'default');
    assert.equal(res.body.used, 133);

    res = await call('PUT', { limit: 180 });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 180);
    assert.equal(res.body.source, 'admin');
    assert.equal(res.body.setting.updatedBy, 'root', 'the audit trail names who set it');

    res = await call('PUT', { limit: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.limit, 140);
    assert.equal(res.body.source, 'default');
  } finally {
    close();
  }
});

test('PUT refuses a bad value and a missing field', async () => {
  const store = makeStore();
  const { call, close } = await mount(store, FULL_ADMIN);
  try {
    for (const bad of [0, -5, 2.5, '180', sessionLimit.MAX_SETTING + 1]) {
      const res = await call('PUT', { limit: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body.error, /session limit/i);
    }
    const missing = await call('PUT', {});
    assert.equal(missing.status, 400);
    assert.ok(!store.state.queries.some((q) => /INSERT INTO platform_settings/.test(q.sql)), 'nothing was written');
  } finally {
    close();
  }
});

test('a view-only admin can read the limit but not change it', async () => {
  const store = makeStore();
  const { call, close } = await mount(store, VIEW_ADMIN);
  try {
    assert.equal((await call('GET')).status, 200);
    const res = await call('PUT', { limit: 180 });
    assert.equal(res.status, 403);
    assert.equal(store.state.setting, null);
  } finally {
    close();
  }
  assert.match(read('src/routes/admin.js'), /router\.put\('\/api\/admin\/session-limit', requireAdminWrite,/);
});

// ─── 4. Every reader goes through effective() ───────────────────────────

test('the start, resume and reopen gate enforces the stored setting', async () => {
  const lifecycle = require('../src/services/session-lifecycle');
  const priorFree = lifecycle.freeGlobalSlot;
  lifecycle.freeGlobalSlot = async () => ({ freed: false });
  try {
    // 133 in use under MAX_GLOBAL_SESSIONS=130: full. Raised to 180 here: room.
    const config = { maxGlobalSessions: 130 };
    const full = makeStore({ used: 133 });
    assert.equal((await lifecycle.claimGlobalSlot({ pool: full, config, path: 'start' })).ok, false);
    const raised = makeStore({ used: 133, setting: 180 });
    assert.equal((await lifecycle.claimGlobalSlot({ pool: raised, config, path: 'start' })).ok, true);
  } finally {
    lifecycle.freeGlobalSlot = priorFree;
  }
});

test('no reader takes the cap from config.maxGlobalSessions; each asks the resolver', () => {
  const readers = {
    'src/services/session-lifecycle.js': /const cap = await require\('\.\/session-limit'\)\.effective\(pool, config\);/,
    'src/routes/sessions.js': /global: await require\('\.\.\/services\/session-limit'\)\.effective\(pool, config\),/,
    'src/services/platform-limit-alerts.js': /cap: \(config, pool\) => sessionLimit\.effective\(pool, config\),/,
    'src/services/status.js': /require\('\.\/session-limit'\)\.effective\(pool, config\)/,
  };
  for (const [rel, reads] of Object.entries(readers)) {
    const code = read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /config\.maxGlobalSessions/, `${rel} reads the cap through services/session-limit.js`);
    assert.match(code, reads, rel);
  }
});

test('the session limit alert says where the limit is raised, and opens there', () => {
  const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
  const full = buildNotificationCopy('platform_limit', { detail: 'sessions_full:140:140' });
  assert.match(full.body, /until the limit is raised in Admin → Limits/);
  const en = JSON.parse(read('frontend/locales/en/notifications.json'));
  assert.match(en['row.limit.sessions.full.body_other'].text, /raised in Admin → Limits/);
  assert.doesNotMatch(en['row.limit.sessions.full.body_other'].text, /MAX_GLOBAL_SESSIONS/);
  const tap = read('frontend/src/features/notifications/notifications.js');
  assert.match(tap, /if \(item\.kind === 'platform_limit'\) \{\n\s+Notifications\._dismissSheetForNav\(\);\n\s+const section = 'limits';/);
});

// ─── 5. The console card ────────────────────────────────────────────────

test('the Session limit card renders its ids, sits under the App limit, and waits for its read', () => {
  globalThis.window = globalThis.window || globalThis;
  const mod = loadTsx('frontend/src/features/admin/admin-limits.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => (key === 'btn' ? new Proxy({}, { get: () => 'btn' }) : String(key)) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const html = renderToHtml(createElement(mod.SessionLimitCard, { canWrite: true }));
  assert.match(html, /id="admin-session-limit"/);
  assert.match(html, /id="admin-session-limit-usage"/);
  assert.match(html, />Session limit</);
  assert.match(html, /How many coding sessions the whole platform runs at once/);
  assert.match(html, /id="admin-session-limit-input"[^>]*disabled=""/, 'no edits before the read lands');
  assert.match(html, /id="admin-save-session-limit-btn"[^>]*disabled=""/);
  assert.doesNotMatch(html, /—/, 'no em dash in the copy');

  const viewOnly = renderToHtml(createElement(mod.SessionLimitCard, { canWrite: false }));
  assert.doesNotMatch(viewOnly, /admin-save-session-limit-btn/, 'a view-only admin gets no Save');

  const src = read('frontend/src/features/admin/admin-limits.tsx');
  assert.match(src, /<AppLimitCard canWrite=\{canWrite\} \/>\n\n\s+<SessionLimitCard canWrite=\{canWrite\} \/>/);
  assert.match(src, /id="admin-session-limit-quota"/);
});

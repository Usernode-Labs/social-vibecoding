'use strict';

// Versions' off switch, an admin setting on by default
// (services/versions-setting.js, docs/plans/versions.md "The off switch").
// Pinned here:
//
//   1. The precedence: the operator's VERSIONS_ENABLED=false absolute, then
//      the admin's setting, then on.
//   2. The read is cached per pool, invalidated by a write, and fails safe
//      to the default.
//   3. GET/PUT /api/admin/versions: validation, permissions, the 409 when
//      the deploy decides, and the audit columns.
//
// Run with: node --test tests/versions-setting.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const setting = require('../src/services/versions-setting');

const CONFIG = { jwtSecret: 'test', selfAppSlug: 'usernode-2d5619' };

// A stateful platform_settings store, shared by the service tests and the
// mounted admin router (which reads getPool() once, at mount).
function makeStore({ value = null, failReads = false } = {}) {
  const state = { value, failReads, queries: [], updatedBy: null };
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
      throw new Error(`unstubbed: ${sql.slice(0, 60)}`);
    },
  };
}

function withEnv(value, fn) {
  const saved = process.env.VERSIONS_ENABLED;
  if (value === undefined) delete process.env.VERSIONS_ENABLED; else process.env.VERSIONS_ENABLED = value;
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env.VERSIONS_ENABLED; else process.env.VERSIONS_ENABLED = saved;
  });
}

// ─── 1. The precedence ──────────────────────────────────────────────────

test('on by default; the admin turns it off and on; the operator\'s off wins', () => withEnv(undefined, async () => {
  assert.equal(setting.KEY, 'versions');
  assert.equal(await setting.enabled(CONFIG, makeStore()), true, 'nothing stored: on');
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'off' })), false);
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'on' })), true);
  assert.equal(await setting.enabled(CONFIG, makeStore({ value: 'garbled' })), true, 'an unreadable value is no setting');

  const off = makeStore({ value: 'on' });
  await withEnv('false', async () => {
    assert.equal(await setting.enabled(CONFIG, off), false, 'the operator\'s switch is absolute');
    assert.equal(off.state.queries.length, 0, 'and reads nothing');
  });
  await withEnv('FALSE ', async () => {
    assert.equal(setting.deployBlock(CONFIG), 'off');
  });
  await withEnv('true', async () => {
    assert.equal(setting.deployBlock(CONFIG), null, 'anything but "false" leaves the admin to decide');
  });
  assert.equal(setting.deployBlock({ ...CONFIG, versionsEnabled: false }), 'off', 'a config that carries it');
  assert.equal(setting.deployBlock({ ...CONFIG, versionsEnabled: true }), null);
}));

// ─── 2. The read ────────────────────────────────────────────────────────

test('the read is cached per pool, a write clears it, and a failed read falls back to on', () => withEnv(undefined, async () => {
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
  assert.deepEqual(insert.params, ['versions', 'on', 1]);
  assert.match(insert.sql, /ON CONFLICT \(key\) DO UPDATE/);
  await setting.set(store, { value: false, actorId: 1 });
  assert.equal(store.state.value, 'off');
  await setting.set(store, { value: null, actorId: 1 });
  assert.equal(store.state.value, null);
});

test('adminPayload says whether it is on and why', () => withEnv(undefined, async () => {
  assert.deepEqual(await setting.adminPayload(makeStore(), CONFIG), { enabled: true, source: 'default', setting: null });
  const admin = await setting.adminPayload(makeStore({ value: 'off' }), CONFIG);
  assert.equal(admin.enabled, false);
  assert.equal(admin.source, 'admin');
  assert.equal(admin.setting.value, false);
  await withEnv('false', async () => {
    assert.deepEqual(await setting.adminPayload(makeStore({ value: 'on' }), CONFIG), { enabled: false, source: 'off', setting: null });
  });
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
    const res = await fetch(`${base}/api/admin/versions`, {
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

test('a full admin turns versions off and on, and null goes back to the default', () => withEnv(undefined, async () => {
  const store = makeStore();
  const { call, close } = await mount(store, FULL_ADMIN);
  try {
    let res = await call('GET');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: true, source: 'default', setting: null });

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

test('a view-only admin reads it but cannot change it; the operator\'s off switch leaves nothing to set', () => withEnv(undefined, async () => {
  const viewer = await mount(makeStore({ value: 'off' }), VIEW_ADMIN);
  try {
    assert.equal((await viewer.call('GET')).body.enabled, false);
    assert.equal((await viewer.call('PUT', { enabled: true })).status, 403);
  } finally {
    viewer.close();
  }
  await withEnv('false', async () => {
    const store = makeStore();
    const off = await mount(store, FULL_ADMIN);
    try {
      const res = await off.call('PUT', { enabled: true });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /VERSIONS_ENABLED is false/);
      assert.equal(store.state.value, null, 'nothing was stored');
    } finally {
      off.close();
    }
  });
}));

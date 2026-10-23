'use strict';

// #5303: PUT /api/apps/:slug/channels/:handle/mute. The viewer's own Mute
// of #general: signed in, an app they may see, #general only, a boolean.
//
// Run with: node --test tests/channel-mute-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');

const APPS = {
  'public-app': {
    id: 11, slug: 'public-app', name: 'Public App', created_by: 1, self_hosted: false,
    collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null, is_admin: false,
  },
  'private-app': {
    id: 12, slug: 'private-app', name: 'Secret Project', created_by: 1, self_hosted: false,
    collab_visibility: 'private', view_visibility: 'private', moderation_suspended_at: null, is_admin: false,
  },
};

function makePool() {
  const calls = [];
  return {
    calls,
    query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/FROM apps WHERE slug = \$1/.test(text)) {
        const app = APPS[params[0]];
        return Promise.resolve({ rows: app ? [{ ...app }] : [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

function loadRoutes(pool) {
  const prev = poolMod.getPool;
  poolMod.getPool = () => pool;
  const routePath = require.resolve('../src/routes/notifications');
  delete require.cache[routePath];
  const mod = require('../src/routes/notifications');
  poolMod.getPool = prev;
  delete require.cache[routePath];
  return mod;
}

async function withServer(pool, user, fn) {
  const mod = loadRoutes(pool);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use(mod.notificationsRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/apps`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function put(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const writes = (pool) => pool.calls.filter((c) => /channel_mutes/.test(c.sql));

test('a signed-in viewer mutes and unmutes #general of an app they can see', async () => {
  const pool = makePool();
  await withServer(pool, { id: 7, username: 'tester' }, async (base) => {
    const on = await put(`${base}/public-app/channels/general/mute`, { muted: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { handle: 'general', muted: true });
    const off = await put(`${base}/public-app/channels/general/mute`, { muted: false });
    assert.deepEqual(off.body, { handle: 'general', muted: false });
    const [insert, remove] = writes(pool);
    assert.match(insert.sql, /INSERT INTO channel_mutes/);
    assert.deepEqual(insert.params, [7, 11, 0]);
    assert.match(remove.sql, /DELETE FROM channel_mutes/);
  });
});

test('signed out is 401', async () => {
  const pool = makePool();
  await withServer(pool, null, async (base) => {
    const res = await put(`${base}/public-app/channels/general/mute`, { muted: true });
    assert.equal(res.status, 401);
    assert.equal(writes(pool).length, 0);
  });
});

test('an app the viewer cannot see, a missing one, and another handle are 404', async () => {
  const pool = makePool();
  await withServer(pool, { id: 7, username: 'tester' }, async (base) => {
    const hidden = await put(`${base}/private-app/channels/general/mute`, { muted: true });
    const missing = await put(`${base}/no-such-app/channels/general/mute`, { muted: true });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, missing.body, 'a hidden app answers as a missing one');
    const topic = await put(`${base}/public-app/channels/onboarding/mute`, { muted: true });
    assert.equal(topic.status, 404);
    assert.equal(writes(pool).length, 0);
  });
});

test('a muted that is not true or false is 422', async () => {
  const pool = makePool();
  await withServer(pool, { id: 7, username: 'tester' }, async (base) => {
    for (const body of [{}, { muted: 'yes' }, { muted: 1 }, { muted: null }]) {
      const res = await put(`${base}/public-app/channels/general/mute`, body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    assert.equal(writes(pool).length, 0);
  });
});

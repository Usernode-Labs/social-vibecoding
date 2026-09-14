'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const poolModule = require('../src/db/pool');

function loadRoutes(pool) {
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  const modulePath = require.resolve('../src/routes/notifications');
  delete require.cache[modulePath];
  const routes = require('../src/routes/notifications');
  poolModule.getPool = original;
  delete require.cache[modulePath];
  return routes;
}

function makePool() {
  const values = new Map();
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).startsWith('INSERT INTO mobile_push_preferences')) {
        const account = values.get(String(params[0])) || {};
        params[1].forEach((category, index) => { account[category] = params[2][index]; });
        values.set(String(params[0]), account);
        return { rows: [] };
      }
      if (String(sql).includes('FROM mobile_push_preferences')) {
        const account = values.get(String(params[0])) || {};
        return { rows: Object.entries(account).map(([category, enabled]) => ({
          category, enabled,
        })) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

async function start(pool, { authenticated = true } = {}) {
  const routes = loadRoutes(pool);
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(routes.notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('authenticated settings API returns defaults and persists partial account updates', async () => {
  const pool = makePool();
  const { server, baseUrl } = await start(pool);
  try {
    const initialResponse = await fetch(`${baseUrl}/api/me/mobile-push-preferences`);
    const initial = await initialResponse.json();
    assert.equal(initialResponse.status, 200);
    assert.match(initialResponse.headers.get('cache-control'), /no-store/);
    assert.equal(initial.preferences.length, 7);
    assert.equal(initial.preferences.find((row) => row.key === 'messages').enabled, true);
    assert.equal(initial.preferences.find((row) => row.key === 'direct_interactions').enabled, true);
    assert.equal(initial.preferences.find((row) => row.key === 'lightweight_activity').enabled, false);

    const updateResponse = await fetch(`${baseUrl}/api/me/mobile-push-preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: {
        direct_interactions: false,
        lightweight_activity: true,
      } }),
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.match(updateResponse.headers.get('cache-control'), /no-store/);
    assert.equal(updated.preferences.find((row) => row.key === 'direct_interactions').enabled, false);
    assert.equal(updated.preferences.find((row) => row.key === 'lightweight_activity').enabled, true);
    assert.deepEqual(
      pool.calls.find((call) => call.sql.startsWith('INSERT INTO mobile_push_preferences')).params[0],
      7,
      'the authenticated account id, never a request field, scopes the update'
    );
  } finally {
    server.close();
  }
});

test('settings API rejects unknown categories, malformed values, and unauthenticated reads', async () => {
  const pool = makePool();
  const authenticated = await start(pool);
  try {
    for (const preferences of [
      { future_category: true },
      { direct_interactions: 'false' },
    ]) {
      const response = await fetch(`${authenticated.baseUrl}/api/me/mobile-push-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences }),
      });
      const body = await response.json();
      assert.equal(response.status, 422);
      assert.equal(body.error, 'The given data was invalid.');
    }
    assert.equal(pool.calls.length, 0, 'invalid updates never reach PostgreSQL');
  } finally {
    authenticated.server.close();
  }

  const anonymous = await start(makePool(), { authenticated: false });
  try {
    const response = await fetch(`${anonymous.baseUrl}/api/me/mobile-push-preferences`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control'), /no-store/);
  } finally {
    anonymous.server.close();
  }
});

function testAlertPool({ preferences = [], deliveries = [{ id: 42 }], fail = false } = {}) {
  const calls = [];
  return { calls, connect: async () => ({
    release() { calls.push({ sql: 'release' }); },
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM mobile_push_preferences')) return { rows: preferences };
      if (sql.includes('INSERT INTO notifications')) {
        if (fail) throw new Error('database unavailable');
        return { rows: [{ id: 123 }] };
      }
      if (sql.includes('FROM mobile_push_deliveries')) return { rows: deliveries };
      return { rows: [] };
    },
  }) };
}

test('test alert queues only for the authenticated recipient and rate-limits repeated requests', async () => {
  const pool = testAlertPool();
  const { server, baseUrl } = await start(pool);
  try {
    const send = () => fetch(`${baseUrl}/api/me/test-alert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 999, kind: 'mention', delayMs: 0 }),
    });
    const response = await send();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), { queued: true, notificationId: 123, delayMs: 10000 });
    const insert = pool.calls.find((call) => call.sql.includes('INSERT INTO notifications'));
    assert.deepEqual(insert.params, [7]);
    assert.match(insert.sql, /'test_alert'/);
    assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
    await send();
    await send();
    assert.equal((await send()).status, 429);
    assert.equal(pool.calls.filter((call) => call.sql.includes('INSERT INTO notifications')).length, 3);
  } finally { server.close(); }
});

test('test alert reports setup failures and rolls back instead of claiming it was sent', async () => {
  for (const [options, reason] of [
    [{ preferences: [{ category: 'developer_sessions', enabled: false }] }, 'preference_disabled'],
    [{ deliveries: [] }, 'no_eligible_device'],
  ]) {
    const pool = testAlertPool(options);
    const { server, baseUrl } = await start(pool);
    try {
      const response = await fetch(`${baseUrl}/api/me/test-alert`, { method: 'POST' });
      assert.deepEqual(await response.json(), { queued: false, reason, delayMs: 10000 });
      assert.ok(pool.calls.some((call) => call.sql === 'ROLLBACK'));
      assert.ok(!pool.calls.some((call) => call.sql === 'COMMIT'));
    } finally { server.close(); }
  }
});

test('test alert rejects anonymous calls and rolls back database failures', async () => {
  for (const authenticated of [false, true]) {
    const pool = testAlertPool({ fail: true });
    const { server, baseUrl } = await start(pool, { authenticated });
    try {
      const response = await fetch(`${baseUrl}/api/me/test-alert`, { method: 'POST' });
      assert.equal(response.status, authenticated ? 500 : 401);
      if (authenticated) {
        assert.ok(pool.calls.some((call) => call.sql === 'ROLLBACK'));
        assert.equal(pool.calls.at(-1).sql, 'release');
      } else assert.equal(pool.calls.length, 0);
    } finally { server.close(); }
  }
});

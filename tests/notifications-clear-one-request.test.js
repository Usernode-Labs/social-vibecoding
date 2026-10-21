'use strict';

// One clear, one request (21 Oct 2026). A story card stands for several
// notifications, and clearing it sent one POST /api/notifications/read per
// member. Each answer carried the count after its own row only, so the
// slower one put "Unread (2)" back on the iPhone after the clear had said 1.
// The route now takes `{ ids }` and reads them in one statement; the client
// side is pinned in notifications-swipe-clear and notifications-one-count-fold.
//
// Run with: node --test tests/notifications-clear-one-request.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const poolModule = require('../src/db/pool');
const notifications = require('../src/services/notifications');

test('markRead({ ids }) reads them all in one statement, the user\'s own only', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 2, rows: [] }; } };
  assert.equal(await notifications.markRead(pool, 42, { ids: [3, 4] }), 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE notifications SET read_at = NOW\(\)\s+WHERE user_id = \$1 AND id = ANY\(\$2::int\[\]\) AND read_at IS NULL/);
  assert.deepEqual(calls[0].params, [42, [3, 4]]);
});

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

function makePool({ cleared }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*UPDATE notifications/.test(sql)) return { rowCount: cleared, rows: [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ c: 1, m: 0 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

async function withServer(pool, fn) {
  const wsPath = require.resolve('../src/services/ws');
  const saved = require.cache[wsPath];
  const pushes = [];
  require.cache[wsPath] = {
    id: wsPath, filename: wsPath, loaded: true,
    exports: { pushNotificationToUser: (userId, msg) => pushes.push({ userId, msg }) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(loadRoutes(pool).notificationsRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/notifications/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await fn(post, pushes);
  } finally {
    server.close();
    if (saved) require.cache[wsPath] = saved; else delete require.cache[wsPath];
  }
}

test('POST { ids } reads them in one statement, answers the count after all of them, fans out once', async () => {
  const pool = makePool({ cleared: 2 });
  await withServer(pool, async (post, pushes) => {
    const res = await post({ ids: [5, 6, 5] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { unread: 1, messageUnread: 0, cleared: 2 });
    const updates = pool.calls.filter((c) => /UPDATE notifications/.test(c.sql));
    assert.equal(updates.length, 1, 'one statement');
    assert.deepEqual(updates[0].params, [7, [5, 6]], 'each id once');
    assert.deepEqual(pushes, [{ userId: 7, msg: { type: 'notifications_changed' } }]);
  });
});

test('POST { ids } refuses anything but a list of notification ids', async () => {
  const many = Array.from({ length: 601 }, (_, i) => i + 1);
  for (const bad of [[], 'x', 5, [0], [-1], [1.5], ['3'], [2147483648], many]) {
    const pool = makePool({ cleared: 0 });
    await withServer(pool, async (post) => {
      const res = await post({ ids: bad });
      assert.equal(res.status, 400, `ids ${JSON.stringify(bad).slice(0, 40)}`);
      assert.equal(pool.calls.length, 0, 'nothing is read');
    });
  }
});

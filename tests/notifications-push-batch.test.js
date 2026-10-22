'use strict';

// A notification to many people is written
// `Promise.all(rows.map((row) => hydrateAndPush(pool, row)))`, and each row
// was its own query, all at once: up to 93 in the same second (a weekly
// digest), each holding a connection of the caller's pool (22 Oct 2026).
// Calls on the same pool in the same turn now share one read, and each still
// resolves once its row has been pushed.
//
// Run with: node --test tests/notifications-push-batch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notifications = require('../src/services/notifications');

function stubPool(listed) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
      const rows = ids.filter((id) => listed.has(id))
        .map((id) => ({ id, kind: 'pr_merged', user_id: listed.get(id), created_at: '2026-10-22T12:00:00.000Z' }));
      return { rows, rowCount: rows.length };
    },
  };
}

function capturePushes(t) {
  const wsPath = require.resolve('../src/services/ws');
  const saved = require.cache[wsPath];
  const pushes = [];
  require.cache[wsPath] = {
    id: wsPath, filename: wsPath, loaded: true,
    exports: { pushNotificationToUser: (userId, payload) => pushes.push({ userId, id: payload.notification.id }) },
  };
  t.after(() => { if (saved) require.cache[wsPath] = saved; else delete require.cache[wsPath]; });
  return pushes;
}

test('a notification to many people is one read, and each listed row is pushed to its own recipient', async (t) => {
  const pushes = capturePushes(t);
  // 13 is not one the bell lists (it reads as no row), so it is not pushed.
  const pool = stubPool(new Map([[11, 101], [12, 102], [14, 104]]));
  const rows = [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }];
  await Promise.all(rows.map((row) => notifications.hydrateAndPush(pool, row)));
  assert.equal(pool.calls.length, 1, 'one read for the whole batch');
  assert.match(pool.calls[0].sql, /WHERE n\.id = ANY\(\$1::int\[\]\) AND/);
  assert.deepEqual(pool.calls[0].params[0], [11, 12, 13, 14]);
  assert.ok(pool.calls[0].params[1].includes('voted_change_merged'), 'the bell\'s own rules ride the batch too');
  assert.deepEqual(pushes, [{ userId: 101, id: 11 }, { userId: 102, id: 12 }, { userId: 104, id: 14 }]);
});

test('each call resolves once its row has been pushed', async (t) => {
  const pushes = capturePushes(t);
  const pool = stubPool(new Map([[21, 201], [22, 202]]));
  const first = notifications.hydrateAndPush(pool, { id: 21 });
  const second = notifications.hydrateAndPush(pool, { id: 22 });
  assert.equal(pushes.length, 0, 'nothing is read before the caller has queued its rows');
  await first;
  assert.deepEqual(pushes.map((p) => p.id), [21, 22]);
  await second;
});

test('only calls on the same pool share a read; calls a turn apart read on their own', async (t) => {
  capturePushes(t);
  const a = stubPool(new Map([[31, 1]]));
  const b = stubPool(new Map([[32, 2]]));
  await Promise.all([notifications.hydrateAndPush(a, { id: 31 }), notifications.hydrateAndPush(b, { id: 32 })]);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  await notifications.hydrateAndPush(a, { id: 31 });
  assert.equal(a.calls.length, 2, 'a later call is a new batch');
});

test('a row without an id reads nothing, and a failed read is logged, never thrown', async (t) => {
  const pushes = capturePushes(t);
  const empty = stubPool(new Map());
  await notifications.hydrateAndPush(empty, null);
  await notifications.hydrateAndPush(empty, {});
  assert.equal(empty.calls.length, 0);
  const failing = { query: async () => { throw new Error('connection refused'); } };
  await Promise.all([notifications.hydrateAndPush(failing, { id: 41 }), notifications.hydrateAndPush(failing, { id: 42 })]);
  assert.deepEqual(pushes, []);
});

test('hydrateNotifications keys the batch by id and keeps the first row of each', async () => {
  const pool = {
    query: async () => ({ rows: [
      { id: '51', kind: 'pr_merged', user_id: 5, created_at: '2026-10-22T12:00:00.000Z' },
      { id: '51', kind: 'pr_merged', user_id: 6, created_at: '2026-10-22T12:00:00.000Z' },
    ] }),
  };
  const hydrated = await notifications.hydrateNotifications(pool, [51]);
  assert.deepEqual([...hydrated.keys()], [51]);
  assert.equal(hydrated.get(51).userId, 5);
  assert.equal((await notifications.hydrateNotifications(pool, [])).size, 0);
});

test('the main and workflow pools close an unused connection after 10 seconds', () => {
  const { POOL_IDLE_MS } = require('../src/db/connection-options');
  assert.equal(POOL_IDLE_MS, 10000);
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('src/db/pool.js'), /idleTimeoutMillis: POOL_IDLE_MS,/);
  assert.match(read('src/workflow/platform.ts'), /idleTimeoutMillis: legacy\('db\/connection-options'\)\.POOL_IDLE_MS,/);
});

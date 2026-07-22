const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original?.paths || [] };
  return original;
}

async function withServer(activity, run) {
  const poolPath = require.resolve('../src/db/pool');
  const notificationsPath = require.resolve('../src/services/notifications');
  const wsPath = require.resolve('../src/services/ws');
  const routePath = require.resolve('../src/routes/notifications');
  const originals = [
    [poolPath, stubModule(poolPath, { getPool: () => ({ query: async () => ({ rows: [] }) }) })],
    [notificationsPath, stubModule(notificationsPath, {
      listPendingInvites: async () => [{ kind: 'collab', appId: 7 }],
      WORK_NOTIFICATION_KINDS: ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'],
      readScopeForNotificationSection: (section) => ({
        work: 'social.notification-surface:1',
        bell: 'social.notification-surface:2',
      })[section] || null,
    })],
    [wsPath, stubModule(wsPath, { pushNotificationToUser: () => 1 })],
  ];
  delete require.cache[routePath];
  const { notificationsRoutes } = require('../src/routes/notifications');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 42 }; next(); });
  app.use(notificationsRoutes({ activityNotificationsReadPath: 'activity' }, activity));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[routePath];
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original;
      else delete require.cache[id];
    }
  }
}

test('Activity rollout flag moves feed, unread, and reads together', async () => {
  const readCalls = [];
  const activity = {
    feed: async (userId, args) => {
      assert.equal(userId, 42);
      assert.deepEqual(args, { limit: 25, before: null });
      return {
        notifications: [{ id: '9007199254740993', kind: 'mention', readAt: null }],
        hasMore: true,
        nextCursor: 'opaque-feed-cursor',
        readThroughInboxSequence: '845',
      };
    },
    unread: async () => ({ unreadCount: 1, readThroughInboxSequence: '845' }),
    setRead: async (userId, selector) => {
      readCalls.push({ userId, selector });
      return { changed: 1, unreadCount: 0 };
    },
  };

  await withServer(activity, async (baseUrl) => {
    let response = await fetch(`${baseUrl}/api/notifications?limit=25`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.notifications[0].id, '9007199254740993');
    assert.equal(page.unread, 1);
    assert.equal(page.readThroughInboxSequence, '845');
    assert.deepEqual(page.pendingInvites, [{ kind: 'collab', appId: 7 }]);

    response = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true, through_inbox_sequence: '845' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { unread: 0, cleared: 1 });
    assert.deepEqual(readCalls[0], {
      userId: 42,
      selector: { type: 'all', throughInboxSequence: '845' },
    });

    response = await fetch(`${baseUrl}/api/notifications/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'work', through_inbox_sequence: '845' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(readCalls[1], {
      userId: 42,
      selector: {
        type: 'scope',
        readScope: 'social.notification-surface:1',
        throughInboxSequence: '845',
      },
    });
  });
});

test('Activity-mode upstream failure is surfaced without legacy fallback', async () => {
  await withServer({
    feed: async () => { throw new Error('offline'); },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/notifications`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Activity service unavailable' });
  });
});

'use strict';

// #4769: saving (bookmarking) an individual notification.
//
// The route half of the feature: the toggle endpoints under
// /api/notifications/:id/save, the id validation they share with the GET
// above them, the ownership-enforcing save (only your own notification
// pins, and re-saving one that is already pinned still answers 200), and
// the savedNotifications block the first GET page folds in for the
// drawer's pinned Saved section.
//
// Harness shape mirrors tests/notifications-demo-mocks.test.js: stub
// getPool BEFORE requiring the route module (captured at mount time in
// notificationsRoutes), record every query through a swappable handler.
// No Origin/Sec-Fetch-Site headers are sent, so sameOriginBrowserOnly
// treats these fetches as non-browser clients (as it does for every
// route-test harness here).
//
// Run with: node --test tests/notification-bookmarks-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [], rowCount: 0 });
let queries = [];
const pool = {
  query: (...args) => poolQueryHandler(...args),
};

function reset() {
  queries = [];
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
}

const routePath = require.resolve('../src/routes/notifications');
const prevGetPool = poolMod.getPool;
poolMod.getPool = () => pool;
const { notificationsRoutes } = require(routePath);
poolMod.getPool = prevGetPool;

async function startServer({ anonymous = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!anonymous) req.user = { id: 5, username: 'alice' };
    next();
  });
  app.use(notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

// ── the toggle endpoints ────────────────────────────────────────────────

test('PUT saves and DELETE unsaves a notification', async () => {
  reset();
  // The INSERT…SELECT lands: notification 42 is the caller's own row.
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/INSERT INTO notification_bookmarks/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM notification_bookmarks/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const saved = await fetch(urlFor(server, '/api/notifications/42/save'), {
      method: 'PUT',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { saved: true });
    const insert = queries.find((q) => /INSERT INTO notification_bookmarks/.test(q.sql));
    assert.ok(insert, 'the save writes a bookmark row');
    assert.match(insert.sql, /SELECT \$1, n\.id FROM notifications n/,
      'the INSERT reaches through the notification table, so ownership is enforced in SQL');
    assert.match(insert.sql, /WHERE n\.id = \$2 AND n\.user_id = \$1/,
      'scoped to the caller\'s own notification');
    assert.match(insert.sql, /ON CONFLICT \(user_id, notification_id\)/,
      're-saving must not reorder the section');
    assert.deepEqual(insert.params, [5, 42]);

    queries = [];
    const unsaved = await fetch(urlFor(server, '/api/notifications/42/save'), {
      method: 'DELETE',
    });
    assert.equal(unsaved.status, 200);
    assert.deepEqual(await unsaved.json(), { saved: false, removed: 1 });
    const del = queries.find((q) => /DELETE FROM notification_bookmarks/.test(q.sql));
    assert.ok(del, 'the unsave deletes the row');
    assert.match(del.sql, /WHERE user_id = \$1 AND notification_id = \$2/,
      'and only the caller\'s own save');
    assert.deepEqual(del.params, [5, 42]);
  } finally {
    server.close();
  }
});

test('re-saving an already-saved notification still answers 200', async () => {
  reset();
  // ON CONFLICT fires with a deliberate no-op DO UPDATE, which reports the
  // row exists afterwards — rowCount 1, not DO NOTHING's zero. A second
  // tab (or a save racing a refetch) must not read as a failure.
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/INSERT INTO notification_bookmarks/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications/42/save'), {
      method: 'PUT',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { saved: true });
  } finally {
    server.close();
  }
});

test('another user\'s (or a missing) notification is a 404, not a save', async () => {
  reset();
  // The INSERT…SELECT matches nothing: the service's rowCount is 0.
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications/42/save'), {
      method: 'PUT',
    });
    assert.equal(res.status, 404);
    const insert = queries.find((q) => /INSERT INTO notification_bookmarks/.test(q.sql));
    assert.ok(insert, 'the ownership check happens IN the statement, not before it');
    assert.deepEqual(insert.params, [5, 42]);
  } finally {
    server.close();
  }
});

test('unsaving an id that was never saved answers 200 with removed: 0', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications/42/save'), {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { saved: false, removed: 0 });
  } finally {
    server.close();
  }
});

test('a malformed id is refused before any query', async () => {
  reset();
  const server = await startServer();
  try {
    for (const id of ['0', '12junk', '2147483648']) {
      const put = await fetch(urlFor(server, `/api/notifications/${id}/save`), {
        method: 'PUT',
      });
      assert.equal(put.status, 404, `PUT ${id}`);
      const del = await fetch(urlFor(server, `/api/notifications/${id}/save`), {
        method: 'DELETE',
      });
      assert.equal(del.status, 404, `DELETE ${id}`);
    }
    assert.equal(queries.length, 0, 'nothing reaches the database for an unparseable id');
  } finally {
    server.close();
  }
});

test('an anonymous caller gets 401 and writes nothing', async () => {
  reset();
  const server = await startServer({ anonymous: true });
  try {
    const res = await fetch(urlFor(server, '/api/notifications/42/save'), {
      method: 'PUT',
    });
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

// ── the GET payload's savedNotifications block ──────────────────────────

test('the first GET page carries savedNotifications for the drawer', async () => {
  reset();
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/JOIN notification_bookmarks nb/.test(sql)) {
      // The saved-rows SELECT: one saved notification for user 5.
      return {
        rows: [{
          id: 42, kind: 'mention', read_at: null, saved: true,
          saved_at: '2026-10-13T10:00:00.000Z',
          created_at: '2026-10-13T09:00:00.000Z', app_id: 5,
          app_slug: 'real-app', app_name: 'Real App',
          chat_message_id: 10, message_content: 'hi @you',
          thread_type: null, thread_ref: null, session_id: null,
          pr_title: null, pr_number: null, headless_issue_number: null,
          branch_name: null, source_username: 'alice', detail: null,
        }],
      };
    }
    if (/FROM notifications n/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)::int AS c FROM notifications/.test(sql)) {
      return { rows: [{ c: 0 }] };
    }
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications?limit=100'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.savedNotifications),
      'the payload carries the saved list alongside savedMessages');
    assert.deepEqual(
      body.savedNotifications.map((n) => [n.id, n.saved, n.savedAt]),
      [[42, true, '2026-10-13T10:00:00.000Z']],
      'each row is serialized like the feed\'s, flagging itself saved and carrying when it was pinned',
    );
    // The saved rows share the notification SELECT's shape — same columns,
    // same access clauses — rather than a second, weaker table scan.
    const savedQuery = queries.find((q) => /JOIN notification_bookmarks nb/.test(q.sql));
    assert.ok(savedQuery, 'one query builds the saved list');
    assert.match(savedQuery.sql, /FROM notifications n/,
      'the saved rows hydrate through the feed\'s own row SELECT');
    assert.match(savedQuery.sql, /WHERE n\.user_id = \$1/,
      'scoped to the caller\'s own notifications');
    assert.match(savedQuery.sql, /ORDER BY nb\.created_at DESC/,
      'the section is ordered by when things were SAVED');
  } finally {
    server.close();
  }
});
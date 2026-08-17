'use strict';

// #1280: saving (bookmarking) a group-chat message.
//
// The route half of the feature: the toggle endpoints, the gate that stops
// one public app's slug from unlocking every message id on the platform,
// the per-message `bookmarked` flag the chat history carries, and the
// `savedMessages` block the notifications payload folds in for the drawer's
// pinned section.
//
// Run with: node --test tests/message-bookmarks-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
const pool = { query: (...args) => poolQueryHandler(...args) };
poolMod.getPool = () => pool;

const appAccessId = require.resolve('../src/services/app-access');
let grantedApp = { id: 7, slug: 'demo' };
let lastAccessLevel = null;
require.cache[appAccessId] = {
  id: appAccessId,
  filename: appAccessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, slug, _user, level) => {
      lastAccessLevel = level;
      return slug === 'demo' ? grantedApp : null;
    },
    checkAppAccess: async () => true,
  },
};

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId,
  filename: wsId,
  loaded: true,
  paths: [],
  exports: {
    handleMessage: async () => ({ ok: true, message: {} }),
    getReactionsForMessages: async () => ({}),
  },
};

const { chatRoutes } = require('../src/routes/chat');
const bookmarks = require('../src/services/message-bookmarks');

let queries = [];

function reset() {
  grantedApp = { id: 7, slug: 'demo' };
  lastAccessLevel = null;
  queries = [];
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
}

async function startServer({ anonymous = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!anonymous) req.user = { id: 5, username: 'alice' };
    next();
  });
  app.use(chatRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

// ── the toggle endpoints ────────────────────────────────────────────────

test('PUT saves and DELETE unsaves, both gated on view access', async () => {
  reset();
  // The existence probe answers "yes, message 31 is in app 7"; the write
  // itself returns nothing.
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM chat_messages/.test(sql)) return { rows: [{ id: 31 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const server = await startServer();
  try {
    const saved = await fetch(urlFor(server, '/api/apps/demo/messages/31/bookmark'), {
      method: 'PUT',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { bookmarked: true });
    assert.equal(lastAccessLevel, 'view',
      'saving is view-gated (#621): a read-only viewer may save what they can read');
    const insert = queries.find((q) => /INSERT INTO message_bookmarks/.test(q.sql));
    assert.ok(insert, 'the save writes a bookmark row');
    assert.match(insert.sql, /ON CONFLICT \(user_id, message_id\) DO NOTHING/,
      're-saving must not reorder the section');
    assert.deepEqual(insert.params, [5, 31]);

    queries = [];
    const unsaved = await fetch(urlFor(server, '/api/apps/demo/messages/31/bookmark'), {
      method: 'DELETE',
    });
    assert.equal(unsaved.status, 200);
    assert.deepEqual(await unsaved.json(), { bookmarked: false, removed: 1 });
    const del = queries.find((q) => /DELETE FROM message_bookmarks/.test(q.sql));
    assert.ok(del, 'the unsave deletes the row');
    assert.deepEqual(del.params, [5, 31]);
  } finally {
    server.close();
  }
});

test('a message in another app is a 404, not a save', async () => {
  reset();
  // The app resolves, but message 31 does not belong to it — which is the
  // whole reason the route probes for the pair rather than trusting the id.
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/messages/31/bookmark'), {
      method: 'PUT',
    });
    assert.equal(res.status, 404);
    assert.ok(!queries.some((q) => /INSERT INTO message_bookmarks/.test(q.sql)),
      'nothing is written for a message the app does not own');
    const probe = queries.find((q) => /FROM chat_messages/.test(q.sql));
    assert.deepEqual(probe.params, [31, 7], 'the probe is scoped to the resolved app id');
  } finally {
    server.close();
  }
});

test('an app the viewer cannot see is a 404', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/secret/messages/31/bookmark'), {
      method: 'PUT',
    });
    assert.equal(res.status, 404);
    assert.equal(queries.length, 0, 'a denied app never reaches the message probe');
  } finally {
    server.close();
  }
});

test('a malformed message id is refused before the app lookup', async () => {
  reset();
  const server = await startServer();
  try {
    for (const id of ['0', '12junk', '2147483648']) {
      const res = await fetch(urlFor(server, `/api/apps/demo/messages/${id}/bookmark`), {
        method: 'PUT',
      });
      assert.equal(res.status, 404, id);
    }
    assert.equal(lastAccessLevel, null, 'no app lookup happens for an unparseable id');
  } finally {
    server.close();
  }
});

test('an anonymous caller gets 401 and writes nothing', async () => {
  reset();
  const server = await startServer({ anonymous: true });
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/messages/31/bookmark'), {
      method: 'PUT',
    });
    assert.equal(res.status, 401);
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

// ── the chat-history hydrate ────────────────────────────────────────────

test('loaded history carries a per-message bookmarked flag', async () => {
  reset();
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM chat_messages m/.test(sql)) {
      return {
        rows: [
          { id: 31, user_id: 5, username: 'alice', content: 'one' },
          { id: 32, user_id: 6, username: 'bob', content: 'two' },
        ],
      };
    }
    if (/FROM message_bookmarks/.test(sql)) return { rows: [{ message_id: 32 }] };
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/messages'));
    assert.equal(res.status, 200);
    const { messages } = await res.json();
    // The route selects newest-first and reverses, so the response is
    // oldest-first — the flag rides whichever row it belongs to.
    assert.deepEqual(messages.map((m) => [m.id, m.bookmarked]), [[32, true], [31, false]]);
  } finally {
    server.close();
  }
});

test('a failing bookmark hydrate does not break loading the chat', async () => {
  reset();
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM chat_messages m/.test(sql)) {
      return { rows: [{ id: 31, user_id: 5, username: 'alice', content: 'one' }] };
    }
    if (/FROM message_bookmarks/.test(sql)) throw new Error('bookmark table on fire');
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/messages'));
    assert.equal(res.status, 200, 'the history still loads');
    const { messages } = await res.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].bookmarked, undefined, 'the flag is simply absent');
  } finally {
    server.close();
  }
});

// ── the service ─────────────────────────────────────────────────────────

test('listForUser drops messages whose app the viewer can no longer see', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [{
          message_id: 31,
          saved_at: '2026-08-17T10:00:00.000Z',
          content: 'the deploy runbook',
          thread_type: 'issue',
          thread_ref: 12,
          message_created_at: '2026-08-17T09:00:00.000Z',
          app_id: 7,
          app_slug: 'demo',
          app_name: 'Demo',
          author: 'bob',
        }],
      };
    },
  };
  const rows = await bookmarks.listForUser(fakePool, 5, { isAdmin: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /view_visibility = 'public'/,
    'view access is re-checked on READ, not only when saving');
  assert.match(calls[0].sql, /app_collaborators/,
    'a view-private app stays visible to its member collaborators');
  assert.deepEqual(calls[0].params, [5, false, bookmarks.MAX_SAVED]);
  assert.deepEqual(rows, [{
    messageId: 31,
    appId: 7,
    appSlug: 'demo',
    appName: 'Demo',
    author: 'bob',
    content: 'the deploy runbook',
    threadType: 'issue',
    threadRef: 12,
    savedAt: '2026-08-17T10:00:00.000Z',
    messageCreatedAt: '2026-08-17T09:00:00.000Z',
  }]);
});

test('listForUser is ordered by when things were SAVED', async () => {
  let sql = '';
  const fakePool = { query: async (q) => { sql = q; return { rows: [] }; } };
  await bookmarks.listForUser(fakePool, 5);
  assert.match(sql, /ORDER BY b\.created_at DESC/,
    'the section is a save-ordered list, so the message time cannot order it');
});

test('savedMessageIdsFor answers with a Set and skips the query when it can', async () => {
  let called = 0;
  const fakePool = {
    query: async () => { called += 1; return { rows: [{ message_id: 32 }] }; },
  };
  assert.deepEqual(await bookmarks.savedMessageIdsFor(fakePool, null, [1]), new Set());
  assert.deepEqual(await bookmarks.savedMessageIdsFor(fakePool, 5, []), new Set());
  assert.equal(called, 0, 'no user or no ids means no round-trip');
  assert.deepEqual(await bookmarks.savedMessageIdsFor(fakePool, 5, [31, 32]), new Set([32]));
  assert.equal(called, 1);
});

test('listForUserSafe swallows a failure so the drawer still opens', async () => {
  const fakePool = { query: async () => { throw new Error('down'); } };
  assert.deepEqual(await bookmarks.listForUserSafe(fakePool, 5), []);
});

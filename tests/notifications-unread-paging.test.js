'use strict';

// #5527: the bell said 46 unread and the Unread list showed 1.
//
// Two halves are pinned here. The ROUTE: `?unread=1` passes `unreadOnly`,
// ignores `kind`, and answers a follow-up page with rows and a cursor only —
// no account-wide aggregates, because the first page already sent them. The
// CONTROLLER, run from the shipped notifications.js in a vm: `loadMoreUnread`
// walks that cursor until the loaded unread rows reach the bell's number,
// leaves the shared feed cursor alone, and publishes `unreadCanLoadMore` for
// the sheet's footer.
//
// The sheet's markup is read off the source, in the style of
// tests/notifications-messages-tab.test.js.
//
// Run with: node --test tests/notifications-unread-paging.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_SRC = read('frontend/src/features/notifications/notifications-sheet.tsx');

// ── the route ───────────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [], rowCount: 0 });
let queries = [];
const pool = { query: (...args) => poolQueryHandler(...args) };

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

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 5, username: 'alice' }; next(); });
  app.use(notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const urlFor = (server, p) => `http://127.0.0.1:${server.address().port}${p}`;

test('?unread=1 pages unread rows only, with no first-page aggregates', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/notifications?unread=1&limit=10'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['hasMore', 'nextBefore', 'notifications'],
      'a follow-up page: rows and a cursor, nothing account-wide');
    assert.equal(queries.length, 1, 'only the feed query runs');
    const { sql, params } = queries[0];
    assert.match(sql, /n\.read_at IS NULL/, 'the page filters to unread rows');
    assert.match(sql, /DECIDED_ASK_SETTLED_SQL|decided/, 'and carries the badge\'s settled-ask filter');
    assert.equal(params[0], 5, 'scoped to the caller');
  } finally {
    server.close();
  }
});

test('?unread=1 ignores ?kind=conversation instead of combining filters', async () => {
  reset();
  const server = await startServer();
  try {
    await fetch(urlFor(server, '/api/notifications?unread=1&kind=conversation'));
    const { params } = queries[0];
    // listForUser: [userId, MERGED_HIDDEN_KINDS, limit]. A `kind` filter would
    // add the conversation-kind array as another parameter.
    assert.equal(params.length, 3, 'no kind array is passed');
    assert.ok(Array.isArray(params[1]), 'the one array is the merged-hidden kinds');
  } finally {
    server.close();
  }
});

// ── the controller ──────────────────────────────────────────────────────

const { agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
const CONTROLLER_SRC = FE_SRC.replace(/^import \{ agoStamp \}.*$/m, '');
const MIN = 60 * 1000;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * MIN).toISOString();

function load({ respond } = {}) {
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async (url) => {
      calls.push(['fetch', String(url)]);
      return respond
        ? respond(String(url), calls)
        : { ok: true, json: async () => ({ notifications: [], hasMore: false, nextBefore: null }) };
    },
    PlatformUI: { isTouch: () => false, toast: () => {} },
    GroupChat: { reconcileDotsFromNotifications: () => {} },
    App: { user: { id: 1 } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CONTROLLER_SRC, sandbox);
  const N = sandbox.Notifications;
  N._store = createStore({ screenList: null, sessionUnreadIds: [] });
  return { N, calls };
}

const unreadRow = (id, minutesAgo) => ({
  id, kind: 'mention', createdAt: at(minutesAgo), readAt: null,
});

test('loadMoreUnread walks its own cursor until the loaded rows match the bell', async () => {
  // 1 unread row in hand, the bell says 46, the server has 20 more per page.
  let nextId = 100;
  const { N, calls } = load({
    respond: async () => {
      const rows = Array.from({ length: 20 }, () => unreadRow(nextId++, 500));
      const last = rows[rows.length - 1];
      return {
        ok: true,
        json: async () => ({
          notifications: rows,
          hasMore: true,
          nextBefore: { createdAt: last.createdAt, id: last.id },
        }),
      };
    },
  });
  N.items = [unreadRow(1, 10)];
  N.unread = 46;
  N.hasMore = true;
  N.nextBefore = { createdAt: at(100), id: 90 };
  N.unreadHasMore = true;
  N.unreadNextBefore = { createdAt: at(100), id: 90 };
  const sharedCursor = { createdAt: N.nextBefore.createdAt, id: 90 };
  N._renderList();

  await N.loadMoreUnread();

  // 1 + 20 + 20 + 20 = 61 >= 46 after three pages: it stops there.
  assert.equal(calls.length, 3, 'stops as soon as the loaded rows reach the badge');
  for (const [kind, url] of calls) {
    assert.equal(kind, 'fetch');
    assert.match(url, /unread=1/, 'asks for unread rows only');
    assert.match(url, /before=/, 'and pages on a cursor');
  }
  assert.equal(N.items.filter((n) => !n.readAt).length >= 46, true);
  assert.deepEqual(N.hasMore, true, 'the shared feed pager is untouched');
  assert.deepEqual(N.nextBefore, sharedCursor,
    'the shared cursor does not move');
  assert.equal(N._badgeTotal(), 46, 'and the badge number is not rewritten');
  assert.equal(N._store.get().unreadCanLoadMore, false,
    'nothing more to offer once the bell is matched');
});

test('loadMoreUnread stops after five pages and offers the rest by hand', async () => {
  let nextId = 500;
  const { N, calls } = load({
    respond: async () => {
      const rows = Array.from({ length: 100 }, () => unreadRow(nextId++, 900));
      const last = rows[rows.length - 1];
      return {
        ok: true,
        json: async () => ({
          notifications: rows,
          hasMore: true,
          nextBefore: { createdAt: last.createdAt, id: last.id },
        }),
      };
    },
  });
  N.items = [];
  N.unread = 2000;
  N.hasMore = true;
  N.nextBefore = { createdAt: at(100), id: 90 };
  N.unreadHasMore = true;
  N.unreadNextBefore = { createdAt: at(100), id: 90 };

  await N.loadMoreUnread();

  assert.equal(calls.length, 5, 'at most five pages in one go');
  assert.equal(N.unreadHasMore, true, 'more remains on the server');
  assert.equal(N._store.get().unreadCanLoadMore, true,
    'so the foot offers "See more unread notifications"');
});

test('a page that lands after a newer refresh is thrown away', async () => {
  const { N, calls } = load({
    respond: async () => {
      // A fresh refresh() replaced the feed while this page was in flight.
      N._refreshGeneration += 1;
      N.items = [];
      N.unread = 0;
      return {
        ok: true,
        json: async () => ({
          notifications: [unreadRow(777, 800)],
          hasMore: false,
          nextBefore: null,
        }),
      };
    },
  });
  N.items = [unreadRow(1, 10)];
  N.unread = 5;
  N.unreadHasMore = true;
  N.unreadNextBefore = { createdAt: at(100), id: 90 };

  await N.loadMoreUnread();

  assert.equal(calls.length, 1);
  assert.deepEqual(N.items, [], 'the stale page did not land in the refreshed feed');
});

test('nothing is fetched when the first page already holds the badge', async () => {
  const { N, calls } = load();
  N.items = [unreadRow(1, 10), unreadRow(2, 20)];
  N.unread = 2;
  N.unreadHasMore = true;
  N.unreadNextBefore = { createdAt: at(100), id: 90 };

  await N.loadMoreUnread();

  assert.equal(calls.length, 0, 'the bell and the list already agree');
});

test('a collapsed unread run is counted in full, the way the badge counts it', () => {
  const { N } = load();
  N.items = [
    { id: 3, kind: 'conversation_message', conversationId: 7, createdAt: at(2), readAt: null },
    { id: 2, kind: 'conversation_message', conversationId: 7, createdAt: at(3), readAt: null },
    { id: 1, kind: 'conversation_message', conversationId: 7, createdAt: at(4), readAt: null },
  ];
  N.unread = 3;
  N.unreadHasMore = false;
  N._renderList();

  const unread = N._store.get().screenList.filter((view) => view.unread);
  assert.equal(unread.length, 1, 'three messages, one row');
  assert.equal(unread[0].count, 3);
  assert.equal(N._store.get().unreadCanLoadMore, false,
    'the run adds up to the badge, so there is nothing to fetch');
});

// ── the sheet ───────────────────────────────────────────────────────────

test('the sheet fills the Unread list itself, once per opening', () => {
  const effect = SHEET_SRC.slice(
    SHEET_SRC.indexOf('const unreadFillTried = useRef(false);'),
    SHEET_SRC.indexOf('const all = snap.screenList'),
  );
  assert.ok(effect, 'the catch-up effect exists');
  assert.match(effect, /if \(!open\) \{ unreadFillTried\.current = false; return; \}/,
    'a new opening may try again');
  assert.match(effect, /tab !== 'unread'/);
  assert.match(effect, /!snap\.unreadCanLoadMore \|\| snap\.loadingUnread/);
  assert.match(effect, /controller\(\)\?\.loadMoreUnread\(\)/);
  assert.match(effect, /unreadFillTried\.current\) return;/,
    'the ref stops the five-page cap turning into a loop');
});

test('the foot of the Unread list offers the next batch, above "See older"', () => {
  const foot = SHEET_SRC.slice(SHEET_SRC.indexOf('{/* #5527: FIRST'));
  assert.ok(foot, 'the button exists');
  assert.match(foot, /tab === 'unread' && !olderShown && snap\.unreadCanLoadMore/,
    'shown on the collapsed Unread view only');
  assert.match(foot, /disabled=\{snap\.loadingUnread\}/);
  assert.match(foot, /controller\(\)\?\.loadMoreUnread\(\)/);
  assert.match(foot, /notifications:sheet\.older\.loading/);
  assert.match(foot, /notifications:sheet\.older\.unread/);
  // It sits above the existing "See older notifications" branch, which the
  // fragment still renders below it.
  assert.ok(foot.indexOf('notifications-see-older-messages') > 0,
    '"See older notifications" still renders after it');
  assert.equal(message('notifications:sheet.older.unread'), 'See more unread notifications');
});

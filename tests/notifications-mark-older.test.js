'use strict';

// "Mark everything older than a week as read" on the bell's Unread tab
// (#5929, item 13).
//
// A 99+ backlog had two ways out: clear rows one by one, or Mark all read
// and lose this week's news with the old. The route's mark-all now takes a
// window, `{ all: true, older_than_days: N }`, that keeps the clear to the
// rows created more than N whole days ago; the controller posts a week's
// worth of it (markOlderRead); and the Unread tab offers it as quiet words
// at the foot of its list while an unread row that old is listed. Pinned:
//
//   1. The SERVICE: markRead({ all, olderThanDays }) is its own static
//      statement, windowed on created_at and scoped to the user, and the
//      unscoped mark-all is unchanged.
//   2. The ROUTE: the window rides with `all` alone; junk, a window
//      without `all`, or a window beside another scope is refused (400)
//      rather than dropped, because a dropped window is a clear of
//      everything.
//   3. The CONTROLLER: markOlderRead posts { all: true, older_than_days: 7 },
//      flips only the unread items older than the window locally, and on
//      failure changes nothing and toasts, like markAllRead.
//   4. The SHEET: the control renders only on collapsed Unread with an
//      unread row older than a week listed, as the catalog's words, quiet
//      like a group's Mark read, and it reaches the controller.
//
// Frontend logic is extracted from the shipped source (so tests can't
// drift from what runs) and exercised against stubs; the sheet renders
// through the same harness as tests/notifications-held-unread.test.js.
//
// Run with: node --test tests/notifications-mark-older.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SRC = read(SHEET_PATH);
const CATALOG = JSON.parse(read('frontend/locales/en/notifications.json'));

const notifications = require('../src/services/notifications');

const DAY = 24 * 60 * 60 * 1000;

// ── 1. the service ──────────────────────────────────────────────────────

function stubPool(rowCount) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve({ rowCount, rows: [] });
    },
  };
}

test('markRead({ all, olderThanDays }) clears only the user\'s unread rows older than the window', async () => {
  const pool = stubPool(5);
  const cleared = await notifications.markRead(pool, 42, { all: true, olderThanDays: 7 });
  assert.equal(cleared, 5);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /UPDATE notifications SET read_at = NOW\(\)/);
  assert.match(sql, /user_id = \$1/);
  assert.match(sql, /read_at IS NULL/);
  assert.match(sql, /created_at < NOW\(\) - make_interval\(days => \$2\)/, 'the window is a whole-days interval');
  assert.doesNotMatch(sql, /ANY\(/, 'no kind scope');
  assert.deepEqual(params, [42, 7]);
});

test('markRead({ all }) without a window is the unscoped clear it always was', async () => {
  const pool = stubPool(7);
  const cleared = await notifications.markRead(pool, 42, { all: true });
  assert.equal(cleared, 7);
  const { sql, params } = pool.calls[0];
  assert.doesNotMatch(sql, /make_interval|created_at/);
  assert.deepEqual(params, [42]);
});

test('markRead refuses a junk window or one beside a kind scope instead of widening the clear', async () => {
  for (const olderThanDays of [0, -1, 1.5, '7', NaN]) {
    const pool = stubPool(9);
    await assert.rejects(
      notifications.markRead(pool, 42, { all: true, olderThanDays }),
      TypeError,
      `${String(olderThanDays)} is refused`
    );
    assert.equal(pool.calls.length, 0, 'nothing ran');
  }
  const pool = stubPool(9);
  await assert.rejects(
    notifications.markRead(pool, 42, { all: true, olderThanDays: 7, kinds: ['mention'] }),
    TypeError
  );
  await assert.rejects(
    notifications.markRead(pool, 42, { all: true, olderThanDays: 7, excludeKinds: ['mention'] }),
    TypeError
  );
  assert.equal(pool.calls.length, 0);
});

// ── 2. the route ────────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
let queries = [];
const pool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  },
};

const routePath = require.resolve('../src/routes/notifications');
const prevGetPool = poolMod.getPool;
poolMod.getPool = () => pool;
const { notificationsRoutes } = require(routePath);
poolMod.getPool = prevGetPool;

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 5, username: 'alice' };
    next();
  });
  app.use(notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function postRead(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const isUpdate = (q) => /UPDATE notifications SET read_at = NOW\(\)/.test(q.sql);

test('POST /api/notifications/read { all, older_than_days } windows the mark-all for the signed-in user', async () => {
  queries = [];
  const server = await startServer();
  try {
    const { status, body } = await postRead(server, { all: true, older_than_days: 7 });
    assert.equal(status, 200);
    assert.equal(body.cleared, 0);
    assert.equal(typeof body.unread, 'number');
    const update = queries.find(isUpdate);
    assert.ok(update, 'the clear ran');
    assert.match(update.sql, /created_at < NOW\(\) - make_interval\(days => \$2\)/);
    assert.match(update.sql, /user_id = \$1 AND read_at IS NULL/);
    assert.deepEqual(update.params, [5, 7], 'the caller\'s id and the window, nothing else');
  } finally {
    server.close();
  }
});

test('POST /api/notifications/read refuses a junk window rather than clearing everything', async () => {
  const server = await startServer();
  try {
    for (const older of [0, 366, -3, 2.5, '7', true, [7], { days: 7 }]) {
      queries = [];
      const { status, body } = await postRead(server, { all: true, older_than_days: older });
      assert.equal(status, 400, `${JSON.stringify(older)} is refused`);
      assert.equal(body.error, 'Invalid older_than_days');
      assert.equal(queries.filter(isUpdate).length, 0, 'and nothing was cleared');
    }
  } finally {
    server.close();
  }
});

test('POST /api/notifications/read refuses a window without `all` or beside another scope', async () => {
  const server = await startServer();
  try {
    for (const body of [
      { older_than_days: 7 },
      { all: false, older_than_days: 7 },
      { id: 3, older_than_days: 7 },
      { all: true, ids: [1, 2], older_than_days: 7 },
      { all: true, app_id: 3, older_than_days: 7 },
      { all: true, conversation_id: 3, older_than_days: 7 },
      { all: true, session_id: 3, older_than_days: 7 },
      { all: true, chat_message_id: 3, older_than_days: 7 },
      { all: true, kinds: ['mention'], older_than_days: 7 },
      { all: true, exclude_kinds: ['mention'], older_than_days: 7 },
    ]) {
      queries = [];
      const { status } = await postRead(server, body);
      assert.equal(status, 400, `${JSON.stringify(body)} is refused`);
      assert.equal(queries.filter(isUpdate).length, 0, 'and nothing was cleared');
    }
  } finally {
    server.close();
  }
});

test('POST /api/notifications/read { all } alone is still the unwindowed clear', async () => {
  queries = [];
  const server = await startServer();
  try {
    const { status } = await postRead(server, { all: true });
    assert.equal(status, 200);
    const update = queries.find(isUpdate);
    assert.ok(update);
    assert.doesNotMatch(update.sql, /make_interval/);
    assert.deepEqual(update.params, [5]);
  } finally {
    server.close();
  }
});

// ── 3. the controller ───────────────────────────────────────────────────

// Pull a 2-space-indented object method out of the source so we can
// rebuild it as a standalone callable closing over injected stubs (the same
// extraction tests/notifications-mark-app-read.test.js uses).
function buildMarkOlderRead() {
  const re = /async markOlderRead\(([^)]*)\)\s*\{([\s\S]*?)\n  \},/;
  const m = FE_SRC.match(re);
  assert.ok(m, 'markOlderRead() definition found in notifications.js');
  const run = new Function(
    'days',
    't', 'Notifications', 'fetch', 'window', 'console',
    `return (async () => {${m[2]}})();`
  );
  assert.equal(m[1].trim(), 'days = 7', 'a week is the default window');
  return (days, ...args) => run(days, englishPlatformI18n().t, ...args);
}

function olderFixture() {
  const rendered = { badge: 0, list: 0 };
  const now = Date.now();
  const N = {
    unread: 4,
    items: [
      // This week's: stays unread.
      { id: 1, kind: 'mention', readAt: null, createdAt: new Date(now - 2 * DAY).toISOString() },
      // Six days and change: still inside the week, stays unread.
      { id: 2, kind: 'reply', readAt: null, createdAt: new Date(now - 6.9 * DAY).toISOString() },
      // Older than a week: cleared.
      { id: 3, kind: 'pr_proposed', readAt: null, createdAt: new Date(now - 8 * DAY).toISOString() },
      // Much older, a session kind: cleared too (the bell's to clear).
      { id: 4, kind: 'session_done', readAt: null, createdAt: '2024-05-21T14:05:00Z' },
      // Already read and old: its timestamp is kept.
      { id: 5, kind: 'kudos', readAt: '2026-01-01T00:00:00Z', createdAt: '2025-12-20T00:00:00Z' },
    ],
    _reconcileCompletionTitle() {},
    _renderBadge() { rendered.badge++; },
    _renderList() { rendered.list++; },
  };
  const toasts = [];
  let dotReconciles = 0;
  const windowStub = {
    PlatformUI: { toast(msg) { toasts.push(msg); } },
    GroupChat: { reconcileDotsFromNotifications() { dotReconciles++; } },
  };
  const errors = [];
  const consoleStub = { warn() {}, error(...a) { errors.push(a); }, log() {} };
  return { N, rendered, toasts, windowStub, consoleStub, errors, dots: () => dotReconciles };
}

test('markOlderRead posts { all: true, older_than_days: 7 } and flips only the unread items older than a week', async () => {
  const f = olderFixture();
  const calls = [];
  const fetchStub = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 2, messageUnread: 0, cleared: 2 }) });
  };
  const markOlderRead = buildMarkOlderRead();
  const took = await markOlderRead(undefined, f.N, fetchStub, f.windowStub, f.consoleStub);
  assert.equal(took, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/notifications/read');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { all: true, older_than_days: 7 });

  assert.equal(f.N.unread, 2, 'server-reported unread adopted');
  assert.equal(f.N.items[0].readAt, null, 'this week\'s row stays unread');
  assert.equal(f.N.items[1].readAt, null, 'a row inside the week stays unread');
  assert.ok(f.N.items[2].readAt, 'the eight-day-old row is read');
  assert.ok(f.N.items[3].readAt, 'the row from an earlier year is read');
  assert.equal(f.N.items[4].readAt, '2026-01-01T00:00:00Z', 'already-read timestamps preserved');
  assert.ok(f.rendered.badge >= 1 && f.rendered.list >= 1, 'badge and list re-rendered');
  assert.equal(f.dots(), 1, 'in-chat unread dots reconciled without waiting for WS');
  assert.deepEqual(f.toasts, []);
  assert.equal(f.errors.length, 0);
});

test('markOlderRead sends nothing when no loaded unread row is that old', async () => {
  const f = olderFixture();
  f.N.items = f.N.items.filter((n) => n.id === 1 || n.id === 2 || n.id === 5);
  let fetched = 0;
  const markOlderRead = buildMarkOlderRead();
  const took = await markOlderRead(undefined, f.N, () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); }, f.windowStub, f.consoleStub);
  assert.equal(took, false);
  assert.equal(fetched, 0);
});

test('markOlderRead falls back to a week when handed a window the route would refuse', async () => {
  const f = olderFixture();
  const calls = [];
  const markOlderRead = buildMarkOlderRead();
  await markOlderRead('30', f.N, (url, opts) => {
    calls.push(opts);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 0, cleared: 2 }) });
  }, f.windowStub, f.consoleStub);
  assert.deepEqual(JSON.parse(calls[0].body), { all: true, older_than_days: 7 });
});

function assertUntouched(f) {
  assert.equal(f.N.unread, 4, 'badge count kept');
  for (const n of f.N.items.slice(0, 4)) assert.equal(n.readAt, null, `item ${n.id} kept unread`);
  assert.equal(f.N.items[4].readAt, '2026-01-01T00:00:00Z');
  assert.equal(f.dots(), 0, 'chat dots not cleared');
  assert.deepEqual(f.toasts, [message('notifications:toast.markAllFailed')]);
  assert.equal(f.errors.length, 0, 'no console.error on an expected failure');
}

test('markOlderRead: a server error keeps the unread state and shows the mark-all toast', async () => {
  const f = olderFixture();
  const markOlderRead = buildMarkOlderRead();
  const took = await markOlderRead(undefined, f.N,
    () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    f.windowStub, f.consoleStub);
  assert.equal(took, false);
  assertUntouched(f);
});

test('markOlderRead: a rejected fetch (offline) keeps the unread state and shows the mark-all toast', async () => {
  const f = olderFixture();
  const markOlderRead = buildMarkOlderRead();
  const took = await markOlderRead(undefined, f.N,
    () => Promise.reject(new TypeError('Failed to fetch')),
    f.windowStub, f.consoleStub);
  assert.equal(took, false);
  assertUntouched(f);
});

// ── 4. the sheet ────────────────────────────────────────────────────────

const { createStore } = loadTsx('frontend/src/lib/plain-store.js');

const view = (id, overrides = {}) => ({
  id,
  unread: true,
  unreadCls: '',
  time: '4m ago',
  timeTitle: 'Wednesday',
  mb: false,
  metaFlex: false,
  wrap: false,
  icon: '⚠️',
  label: 'Nearing the app limit',
  segments: [{ t: 'strong', v: '40 of 50 apps in use.' }],
  createdAtMs: Date.now() - 4 * 60 * 1000,
  who: '',
  appLine: 'Admin',
  appId: 3,
  ...overrides,
});

function renderSheet({ list }) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch: false, loadingMore: false,
    screenCanLoadMore: false, messagesCanLoadMore: false, loadingOlderMessages: false,
  });
  const notificationsSheetStore = createStore({ open: true, adopted: false });
  const mod = loadTsx(SHEET_PATH, {
    stubs: {
      './notifications-store.js': { notificationsStore },
      './notifications-sheet-store.js': { notificationsSheetStore },
    },
  });
  return renderToHtml(createElement(mod.NotificationsSheetView));
}

const MARK_OLDER = /<button[^>]*id="notifications-mark-older"[^>]*>/;

test('the Unread tab offers to mark the old rows read only while an unread row older than a week is listed', () => {
  const old = view(10, { createdAtMs: Date.now() - 8 * DAY, time: '8d ago' });
  const fresh = view(11, { createdAtMs: Date.now() - 2 * DAY, time: '2d ago' });
  const oldRead = view(12, { unread: false, createdAtMs: Date.now() - 20 * DAY, time: '20d ago' });
  const edge = view(13, { createdAtMs: Date.now() - 6.9 * DAY, time: '6d ago' });

  const withOld = renderSheet({ list: [fresh, old] });
  const tag = withOld.match(MARK_OLDER);
  assert.ok(tag, 'the control renders with an eight-day-old unread row listed');
  assert.match(tag[0], /data-notif-mark-older=""/);
  assert.match(tag[0], /type="button"/);
  assert.equal(
    withOld.slice(withOld.indexOf(tag[0]) + tag[0].length, withOld.indexOf('</button>', withOld.indexOf(tag[0]))),
    message('notifications:sheet.markOlder'),
    'its words are the catalog\'s'
  );
  assert.equal(message('notifications:sheet.markOlder'), 'Mark everything older than a week as read');
  // Under the groups: after the last group's rows, not in the title row.
  assert.ok(withOld.indexOf('id="notifications-mark-older"') > withOld.lastIndexOf('data-notif-id='),
    'it sits at the foot of the list, after every row');

  assert.doesNotMatch(renderSheet({ list: [fresh, edge] }), MARK_OLDER,
    'nothing a week old listed: no offer');
  assert.doesNotMatch(renderSheet({ list: [fresh, oldRead] }), MARK_OLDER,
    'an old row already read is not what it clears, so no offer');
  assert.doesNotMatch(renderSheet({ list: [] }), MARK_OLDER, 'an empty tab offers nothing');
});

test('the control is quiet words like a group\'s Mark read, never a second filled pill', () => {
  const html = renderSheet({ list: [view(10, { createdAtMs: Date.now() - 8 * DAY })] });
  const tag = html.match(MARK_OLDER)[0];
  const classes = tag.match(/class="([^"]*)"/)[1].split(/\s+/);
  assert.ok(classes.includes('bg-transparent'));
  assert.ok(classes.includes('text-zinc-500'));
  assert.ok(classes.includes('enabled:hover:bg-zinc-100'), 'a busy control does not light up');
  assert.equal(classes.filter((c) => /^(dark:)?bg-zinc-/.test(c)).length, 0, 'no resting fill, light or dark');
  assert.ok(!classes.includes('font-semibold'));
  for (const kept of ['un-touch-target', 'disabled:opacity-40', 'focus-visible:ring-2', 'focus-visible:ring-violet-500']) {
    assert.ok(classes.includes(kept), `it keeps ${kept}`);
  }
  // Still exactly two tabs and the one Mark all read pill above it.
  assert.match(html, /id="notifications-tab-unread"[^>]*aria-selected="true"/);
  assert.equal((html.match(/id="notifications-screen-mark-all"/g) || []).length, 1);
  assert.equal((html.match(/role="tab"/g) || []).length, 2, 'no third tab');
});

test('pressing it lets the old rows go and asks the controller for a week\'s clear', () => {
  const body = SHEET_SRC.slice(SHEET_SRC.indexOf('function MarkOlderRead('), SHEET_SRC.indexOf('export function groupUnreadByApp('));
  assert.match(body, /event\.stopPropagation\(\);/, 'the click does not reach the outside-click dismiss');
  assert.match(body, /onRead\(\);\s*Promise\.resolve\(controller\(\)\?\.markOlderRead\(OLDER_WINDOW_DAYS\)\)/);
  assert.match(SHEET_SRC, /const OLDER_WINDOW_DAYS = 7;/);
  const sheet = SHEET_SRC.slice(SHEET_SRC.indexOf('export function NotificationsSheetView('));
  assert.match(sheet, /const olderUnread = unreadNow\.filter\(\(view\) => olderThanWeek\(view\)\);/,
    'the offer follows what is unread now, not what is held');
  assert.match(sheet, /\{!searching && groupedUnread && olderUnread\.length \? \(\s*<MarkOlderRead\s*onRead=\{\(\) => held\.release\(olderUnread\.flatMap\(\(view\) => view\.groupIds \|\| \[view\.id\]\)\)\}/,
    'collapsed Unread only, and the rows are released before the clear so they leave the tab');
  const { olderThanWeek } = loadTsx(SHEET_PATH);
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.equal(olderThanWeek({ unread: true, createdAtMs: now - 7 * DAY - 1 }, now), true);
  assert.equal(olderThanWeek({ unread: true, createdAtMs: now - 7 * DAY + 1 }, now), false);
  assert.equal(olderThanWeek({ unread: false, createdAtMs: now - 30 * DAY }, now), false);
  assert.equal(olderThanWeek({ unread: true, createdAtMs: 0 }, now), false, 'no timestamp, no window');
});

test('the catalog holds the entry, and the failure toast is Mark all read\'s', () => {
  assert.equal(CATALOG['sheet.markOlder'].text, 'Mark everything older than a week as read');
  assert.ok(CATALOG['sheet.markOlder'].description.length > 20, 'it says where it appears');
  assert.ok(SHEET_SRC.includes("'notifications:sheet.markOlder'"), 'requested by a whole literal');
  const body = FE_SRC.match(/async markOlderRead\([^)]*\)\s*\{([\s\S]*?)\n  \},/)[1];
  assert.ok(body.includes("t('notifications:toast.markAllFailed')"), 'the same toast as Mark all read');
});

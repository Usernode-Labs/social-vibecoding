// "Mark read" per app on the notifications sheet's Unread tab (#5406).
//
// A busy app can post many updates at once, and clearing them one by one is
// the only thing the sheet offered. The Unread tab now groups its rows under
// one heading per app, and each heading carries a "Mark read" pill that
// clears that app's every unread notification while every other app's stay
// where they are.
//
// The server side already existed: POST /api/notifications/read's
// `{ app_id }` branch (markReadForApp, the per-group path of the old #84
// grouping) is reused unchanged, so no client ever called it — until now.
// These tests pin the three new pieces:
//
//   1. The controller's markAppRead(appId): posts { app_id }, flips only
//      that app's unread items locally, adopts the server's unread figure,
//      re-renders, reconciles chat dots — and on failure changes nothing
//      and toasts, exactly like markAllRead's rule.
//   2. rowView carries `appId` (null on conversation rows), so the sheet
//      can group without re-reading the raw feed.
//   3. The sheet groups on Unread and reads the four catalog entries.
//
// Frontend logic is extracted from the shipped source (so tests can't
// drift from what runs) and exercised against stubs.
//
// Run with: node --test tests/notifications-mark-app-read.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');
const fs = require('node:fs');
const path = require('node:path');

const FE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const SHEET_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications-sheet.tsx'),
  'utf8'
);
const CATALOG = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'locales', 'en', 'notifications.json'),
  'utf8'
));

// ── 1. the controller ───────────────────────────────────────────────────

// Pull a 2-space-indented object method out of the source so we can
// rebuild it as a standalone callable closing over injected stubs (the same
// extraction tests/notifications-mark-all.test.js uses — markAppRead takes
// an appId, so its parameter list is rebuilt with the body).
function buildMarkAppRead(name) {
  const re = new RegExp('async ' + name + '\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  // The method reads its toast through the module's `t`; here that is the
  // English runtime's.
  const run = new Function(
    ...m[1].split(',').map((p) => p.trim()).filter(Boolean),
    't', 'Notifications', 'fetch', 'window', 'console',
    `return (async () => {${m[2]}})();`
  );
  return (appId, ...args) => run(appId, englishPlatformI18n().t, ...args);
}

function appFixture() {
  const rendered = { badge: 0, list: 0 };
  const N = {
    unread: 4,
    items: [
      // Two unread rows from app 3 — the group the button is on.
      { id: 1, kind: 'pr_proposed', appId: 3, readAt: null },
      { id: 2, kind: 'kudos', appId: 3, readAt: null },
      // Unread from another app: must stay unread.
      { id: 3, kind: 'check_failed', appId: 7, readAt: null },
      // Unread app-less (a conversation): must stay unread.
      { id: 4, kind: 'conversation_message', appId: null, readAt: null },
      // Already read from app 3: timestamp preserved.
      { id: 5, kind: 'pr_merged', appId: 3, readAt: '2026-01-01T00:00:00Z' },
    ],
    _reconcileCompletionTitle() {},
    _renderBadge() { rendered.badge++; },
    _renderList() { rendered.list++; },
  };
  return { N, rendered };
}

test('markAppRead posts { app_id } and flips only that app\'s unread items', async () => {
  const { N, rendered } = appFixture();
  const fetchCalls = [];
  const fetchStub = (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 2, cleared: 9 }) });
  };

  let dotReconciles = 0;
  const windowStub = {
    GroupChat: { reconcileDotsFromNotifications() { dotReconciles++; } },
  };

  const markAppRead = buildMarkAppRead('markAppRead');
  const ok = await markAppRead(3, N, fetchStub, windowStub, console);

  assert.equal(ok, true);
  assert.equal(fetchCalls.length, 1, 'the request is sent');
  assert.equal(fetchCalls[0].url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), { app_id: 3 });

  assert.equal(N.unread, 2, 'server-reported unread adopted');
  assert.ok(N.items[0].readAt, 'the app\'s first row cleared');
  assert.ok(N.items[1].readAt, 'the app\'s second row cleared');
  assert.equal(N.items[2].readAt, null, 'another app\'s row stays unread');
  assert.equal(N.items[3].readAt, null, 'an app-less row stays unread');
  assert.equal(N.items[4].readAt, '2026-01-01T00:00:00Z', 'already-read timestamp preserved');
  assert.ok(rendered.badge >= 1 && rendered.list >= 1, 'badge and list re-rendered');
  assert.equal(dotReconciles, 1, 'in-chat unread dots reconciled without waiting for WS');
});

test('markAppRead clears the staging demo app (appId 0 counts as an app)', async () => {
  const N = {
    unread: 1,
    items: [{ id: 1, kind: 'check_failed', appId: 0, readAt: null }],
    _reconcileCompletionTitle() {},
    _renderBadge() {},
    _renderList() {},
  };
  const calls = [];
  const markAppRead = buildMarkAppRead('markAppRead');
  const ok = await markAppRead(
    0,
    N,
    (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 0, cleared: 1 }) });
    },
    {}, console
  );
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { app_id: 0 },
    'the demo mock\'s appId 0 is a real group, not "no app"');
  assert.ok(N.items[0].readAt);
});

test('markAppRead sends nothing when no unread item belongs to the app', async () => {
  const { N } = appFixture();
  N.items.forEach((n) => { n.readAt = n.readAt || '2026-01-02T00:00:00Z'; });
  let fetched = 0;
  const markAppRead = buildMarkAppRead('markAppRead');
  await markAppRead(
    3, N, () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); }, {}, console
  );
  assert.equal(fetched, 0, 'another tab or a refresh got there first: no request');
  assert.equal(N.unread, 4, 'nothing changed');
});

test('markAppRead ignores a null appId', async () => {
  const { N } = appFixture();
  let fetched = 0;
  const markAppRead = buildMarkAppRead('markAppRead');
  await markAppRead(
    null, N, () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); }, {}, console
  );
  assert.equal(fetched, 0);
});

function failureFixture() {
  const f = appFixture();
  const toasts = [];
  const windowStub = {
    PlatformUI: { toast(msg) { toasts.push(msg); } },
    GroupChat: { reconcileDotsFromNotifications() {} },
  };
  const consoleStub = { warn() {}, error(...a) { f.errors.push(a); }, log() {} };
  f.toasts = toasts;
  f.windowStub = windowStub;
  f.consoleStub = consoleStub;
  f.errors = [];
  return f;
}

function assertUntouched(f) {
  assert.equal(f.N.unread, 4, 'badge count kept');
  assert.equal(f.N.items[0].readAt, null, 'unread item kept unread');
  assert.equal(f.N.items[1].readAt, null, 'unread item kept unread');
  assert.equal(f.N.items[2].readAt, null);
  assert.equal(f.N.items[3].readAt, null);
  assert.equal(f.N.items[4].readAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(f.toasts, ['Couldn’t mark these notifications as read. Try again.']);
  assert.equal(f.errors.length, 0, 'no console.error on an expected failure');
}

test('markAppRead: a server error keeps the unread state and shows a toast', async () => {
  const f = failureFixture();
  const markAppRead = buildMarkAppRead('markAppRead');
  await markAppRead(
    3, f.N, () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    f.windowStub, f.consoleStub
  );
  assertUntouched(f);
});

test('markAppRead: a rejected fetch (offline) keeps the unread state and shows a toast', async () => {
  const f = failureFixture();
  const markAppRead = buildMarkAppRead('markAppRead');
  await markAppRead(
    3, f.N, () => Promise.reject(new TypeError('Failed to fetch')),
    f.windowStub, f.consoleStub
  );
  assertUntouched(f);
});

// ── 2. rowView carries the app id ───────────────────────────────────────

let screenViews = null;
function loadController() {
  if (screenViews) return screenViews;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  screenViews = globalThis.window.Notifications._screenViews;
  assert.equal(typeof screenViews, 'function', 'the controller publishes _screenViews');
  return screenViews;
}

test('rowView carries appId for an app row and null for a conversation row', () => {
  const views = loadController()([
    {
      id: 1, kind: 'kudos', appId: 3, appSlug: 'notes', appName: 'Notes',
      readAt: null, createdAt: new Date().toISOString(),
    },
    {
      id: 2, kind: 'conversation_message', appId: null, appName: null,
      conversationId: 9, conversationTitle: 'Standup',
      readAt: null, createdAt: new Date().toISOString(),
    },
  ]);
  assert.equal(views[0].appId, 3);
  assert.equal(views[0].appLine, 'Notes');
  assert.equal(views[1].appId, null, 'conversation rows belong to no app');
  assert.ok(Array.isArray(views[1].segments));
});

// ── 3. the sheet groups on Unread ───────────────────────────────────────

test('sheet groups unread rows by app and renders the per-app Mark read button', () => {
  assert.match(SHEET_SRC, /data-notif-app-group=/, 'each group carries its key');
  assert.match(SHEET_SRC, /data-notif-app-read=/, 'each app group carries its Mark read button');
  assert.match(SHEET_SRC, /markAppRead\(/, 'the button reaches the controller');
  assert.match(SHEET_SRC, /appId != null \? 'a:' \+ view\.appId : 'other'/,
    'app rows bucket by id, app-less rows under "other"');
  // The four catalog entries, by whole literal.
  for (const id of [
    'notifications:sheet.markAppRead',
    'notifications:sheet.markAppReadLabel',
    'notifications:sheet.group.other',
    'notifications:toast.markAppFailed',
  ]) {
    assert.ok(SHEET_SRC.includes(`'${id}'`) || FE_SRC.includes(`'${id}'`),
      `${id} is requested by a whole literal`);
  }
  assert.match(SHEET_SRC, /groupedUnread = tab === 'unread' && !olderShown/,
    'grouping applies only to collapsed Unread, not Messages, All or the older reveal');
});

test('the catalog holds the four new entries', () => {
  assert.equal(CATALOG['sheet.markAppRead'].text, 'Mark read');
  assert.equal(CATALOG['sheet.markAppReadLabel'].text, 'Mark all from {{app}} as read');
  assert.equal(CATALOG['sheet.group.other'].text, 'Other');
  assert.equal(
    CATALOG['toast.markAppFailed'].text,
    'Couldn’t mark these notifications as read. Try again.'
  );
  for (const id of ['sheet.markAppRead', 'sheet.markAppReadLabel', 'sheet.group.other', 'toast.markAppFailed']) {
    assert.ok(CATALOG[id].description, `${id} carries a description`);
  }
});
// "Mark all read" regression tests (#449).
//
// The drawer's mark-all control used to clear the server rows and the
// clicking tab's own list, but it was the ONLY clearing path that never
// fanned out `notifications_changed` — so an open group chat kept its
// per-message unread dots and the user's other tabs/devices kept their
// badge until a full reload, making the button look broken. These tests
// pin down the three pieces of the fix:
//
//   1. services markRead() returns the cleared-row count (like every
//      scoped helper) so the route can decide whether to fan out.
//   2. The route's single-id / mark-all fall-through branch pushes
//      `notifications_changed` when something actually cleared.
//   3. The frontend markAllRead() reconciles in-chat unread dots right
//      away (not just via the WS round-trip).
//
// Frontend logic is extracted from the shipped source (so tests can't
// drift from what runs) and exercised against stubs.
//
// Run with: node --test tests/notifications-mark-all.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notifications');

const FE_SRC = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'notifications.js'),
  'utf8'
);

// ── 1. service returns cleared counts ───────────────────────────────────

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

test('markRead({all:true}) clears all unread rows for the user and returns the count', async () => {
  const pool = stubPool(7);
  const cleared = await notifications.markRead(pool, 42, { all: true });
  assert.equal(cleared, 7);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /UPDATE notifications SET read_at = NOW\(\)/);
  assert.match(sql, /user_id = \$1/);
  assert.match(sql, /read_at IS NULL/);
  assert.deepEqual(params, [42]);
});

test('markRead({id}) clears the one row and returns the count', async () => {
  const pool = stubPool(1);
  const cleared = await notifications.markRead(pool, 42, { id: 9 });
  assert.equal(cleared, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /id = \$1 AND user_id = \$2/);
  assert.deepEqual(params, [9, 42]);
});

test('markRead() with neither id nor all is a no-op returning 0', async () => {
  const pool = stubPool(99);
  const cleared = await notifications.markRead(pool, 42, {});
  assert.equal(cleared, 0);
  assert.equal(pool.calls.length, 0);
});

// Kind scoping on the SERVICE. It was built for the split drawers (the
// header cog's mark-all cleared only the session kinds, the bell's cleared
// everything except them) and both callers are gone — #1610 dropped the last
// one when the bell took over the session kinds. The capability stays and
// stays pinned: `kinds` / `excludeKinds` are how any future scoped clear is
// expressed, and an unpinned SQL builder is how one silently starts clearing
// the wrong rows.

test('markRead({all, kinds}) scopes the clear to the listed kinds', async () => {
  const pool = stubPool(3);
  const kinds = ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'];
  const cleared = await notifications.markRead(pool, 42, { all: true, kinds });
  assert.equal(cleared, 3);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /read_at IS NULL AND kind = ANY\(\$2\)/);
  assert.deepEqual(params, [42, kinds]);
});

test('markRead({all, excludeKinds}) clears everything except the listed kinds', async () => {
  const pool = stubPool(4);
  const kinds = ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'];
  const cleared = await notifications.markRead(pool, 42, { all: true, excludeKinds: kinds });
  assert.equal(cleared, 4);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /read_at IS NULL AND NOT \(kind = ANY\(\$2\)\)/);
  assert.deepEqual(params, [42, kinds]);
});

test('markRead({all}) with empty kind arrays falls back to the unscoped clear', async () => {
  const pool = stubPool(7);
  const cleared = await notifications.markRead(pool, 42, { all: true, kinds: [], excludeKinds: [] });
  assert.equal(cleared, 7);
  const { sql, params } = pool.calls[0];
  assert.doesNotMatch(sql, /ANY/);
  assert.deepEqual(params, [42]);
});

// ── 2. route fans out notifications_changed on the mark-all branch ──────

test('route fall-through branch pushes notifications_changed when rows cleared', () => {
  // Isolate the code between the markRead call and the response — the
  // single-id / mark-all fall-through branch of POST /api/notifications/read.
  const m = ROUTE_SRC.match(
    /const cleared = await notifications\.markRead\([\s\S]*?res\.json\(\{ unread, cleared \}\)/
  );
  assert.ok(m, 'fall-through branch captures cleared and returns it');
  assert.match(m[0], /if \(cleared > 0\)/, 'fan-out is gated on rows actually clearing');
  assert.match(
    m[0],
    /pushNotificationToUser\(req\.user\.id, \{ type: 'notifications_changed' \}\)/,
    'mark-all fans out notifications_changed like every other clearing branch'
  );
});

// ── 3. frontend markAllRead reconciles in-chat unread dots ──────────────

// Pull a 2-space-indented object method's body out of the source so we can
// rebuild it as a standalone callable closing over injected stubs.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

// #1610: mark-all clears EVERYTHING the bell counts. It used to send
// `exclude_kinds: [...SESSION_NOTIF_KINDS]` and skip those items locally,
// because the session kinds had a second surface with a mark-all of its own.
// That surface is gone and its count is part of the bell's number, so an
// exclusion here would leave a count nothing in the drawer could dismiss.
// Both stubs stay wired because the extracted body is built with them in
// scope; nothing should reach for either any more.
const SESSION_KINDS = new Set(['session_done', 'auto_solve_done', 'stale_pr', 'check_failed']);
const isSessionNotifStub = (n) => !!n && SESSION_KINDS.has(n.kind);

function buildMarkAllRead(body) {
  return new Function(
    'Notifications', 'fetch', 'window', 'console',
    'SESSION_NOTIF_KINDS', 'isSessionNotif',
    `return (async () => {${body}})();`
  );
}

test('markAllRead marks every item read, re-renders, and reconciles chat dots', async () => {
  const body = methodBody('async markAllRead');

  const rendered = { badge: 0, list: 0 };
  const N = {
    unread: 4,
    items: [
      { id: 1, kind: 'mention', readAt: null },
      { id: 2, kind: 'reply', readAt: null },
      { id: 3, kind: 'kudos', readAt: '2026-01-01T00:00:00Z' },
      // Session-related. It is the bell's now, so mark-all clears it too.
      { id: 4, kind: 'session_done', readAt: null },
    ],
    _reconcileCompletionTitle() {},
    _renderBadge() { rendered.badge++; },
    _renderList() { rendered.list++; },
  };

  const fetchCalls = [];
  const fetchStub = (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 0, cleared: 3 }) });
  };

  let dotReconciles = 0;
  const windowStub = {
    GroupChat: { reconcileDotsFromNotifications() { dotReconciles++; } },
  };

  const markAllRead = buildMarkAllRead(body);
  await markAllRead(N, fetchStub, windowStub, console, SESSION_KINDS, isSessionNotifStub);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), { all: true },
    'no exclude_kinds: the session kinds are the bell\'s to clear now');

  assert.equal(N.unread, 0, 'server-reported unread adopted');
  assert.ok(N.items.every((n) => n.readAt), 'every item is marked read locally');
  assert.ok(N.items[3].readAt, 'the session-related item included (#1610)');
  assert.equal(N.items[2].readAt, '2026-01-01T00:00:00Z', 'already-read timestamps preserved');
  assert.ok(rendered.badge >= 1 && rendered.list >= 1, 'badge and list re-rendered');
  assert.equal(dotReconciles, 1, 'in-chat unread dots reconciled without waiting for WS');
});

test('markAllRead early-returns when nothing is unread at all', async () => {
  const body = methodBody('async markAllRead');
  const N = { unread: 0, items: [{ id: 4, kind: 'session_done', readAt: '2026-01-01T00:00:00Z' }] };
  let fetched = 0;
  const markAllRead = buildMarkAllRead(body);
  await markAllRead(
    N,
    () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); },
    {}, console, SESSION_KINDS, isSessionNotifStub
  );
  assert.equal(fetched, 0);
});

test('a lone unread session notification is enough to send mark-all', async () => {
  // The regression guard for #1610. Under the old exclusion this case
  // early-returned: the only unread item was session-related, so the bell
  // counted itself empty, and the number on #improve-btn had nothing anywhere
  // that could clear it.
  const body = methodBody('async markAllRead');
  const N = {
    unread: 1,
    items: [{ id: 4, kind: 'session_done', readAt: null }],
    _reconcileCompletionTitle() {},
    _renderBadge() {},
    _renderList() {},
  };
  const calls = [];
  const markAllRead = buildMarkAllRead(body);
  await markAllRead(
    N,
    (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 0, cleared: 1 }) });
    },
    {}, console, SESSION_KINDS, isSessionNotifStub
  );
  assert.equal(calls.length, 1, 'the request is sent');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { all: true });
  assert.ok(N.items[0].readAt, 'and the completion is cleared locally');
});

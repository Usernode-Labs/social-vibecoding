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
  path.join(__dirname, '..', 'public', 'js', 'notifications.js'),
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

// Kind scoping for the split drawers (header cog vs bell): the cog's
// mark-all clears only the session-related kinds; the bell's clears
// everything EXCEPT them.

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

test('route emits a generic invalidation when any selected authority changes rows', () => {
  assert.match(ROUTE_SRC, /if \(cleared > 0\) pushChanged\(req\.user\.id\)/);
  assert.match(
    ROUTE_SRC,
    /pushNotificationToUser\(userId, \{ type: 'notifications_changed' \}\)/
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

// The session-related kinds live in the header cog's drawer now, so the
// bell's mark-all must (a) send the stable bell section plus the Activity
// watermark and (b) leave work-drawer items unread locally.
const SESSION_KINDS = new Set(['session_done', 'auto_solve_done', 'stale_pr', 'check_failed']);
const isSessionNotifStub = (n) => !!n && SESSION_KINDS.has(n.kind);

function buildMarkAllRead(body) {
  return new Function(
    'Notifications', 'fetch', 'window', 'console',
    'SESSION_NOTIF_KINDS', 'isSessionNotif',
    `return (async () => {${body}})();`
  );
}

test('markAllRead marks bell items read, re-renders, and reconciles chat dots', async () => {
  const body = methodBody('async markAllRead');

  const rendered = { badge: 0, list: 0 };
  const N = {
    unread: 4,
    readThroughInboxSequence: '42',
    items: [
      { id: 1, kind: 'mention', readAt: null },
      { id: 2, kind: 'reply', readAt: null },
      { id: 3, kind: 'kudos', readAt: '2026-01-01T00:00:00Z' },
      // Session-related: belongs to the cog drawer — must survive unread.
      { id: 4, kind: 'session_done', readAt: null },
    ],
    _bellUnread() {
      const sessionUnread = N.items.filter((n) => isSessionNotifStub(n) && !n.readAt).length;
      return Math.max(0, N.unread - sessionUnread);
    },
    _reconcileCompletionTitle() {},
    _renderBadge() { rendered.badge++; },
    _renderList() { rendered.list++; },
  };

  const fetchCalls = [];
  const fetchStub = (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 1, cleared: 2 }) });
  };

  let dotReconciles = 0;
  const windowStub = {
    GroupChat: { reconcileDotsFromNotifications() { dotReconciles++; } },
  };

  const markAllRead = buildMarkAllRead(body);
  await markAllRead(N, fetchStub, windowStub, console, SESSION_KINDS, isSessionNotifStub);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
    section: 'bell',
    through_inbox_sequence: '42',
  });

  assert.equal(N.unread, 1, 'server-reported unread (the surviving session notif) adopted');
  assert.ok(N.items.filter((n) => !isSessionNotifStub(n)).every((n) => n.readAt),
    'every bell item is marked read locally');
  assert.equal(N.items[3].readAt, null, 'the session-related item stays unread for the cog drawer');
  assert.equal(N.items[2].readAt, '2026-01-01T00:00:00Z', 'already-read timestamps preserved');
  assert.ok(rendered.badge >= 1 && rendered.list >= 1, 'badge and list re-rendered');
  assert.equal(dotReconciles, 1, 'in-chat unread dots reconciled without waiting for WS');
});

test('markAllRead early-returns when the bell itself has nothing unread', async () => {
  const body = methodBody('async markAllRead');
  // One unread notification exists, but it's session-related (cog-drawer
  // territory) — the bell's button must not clear it.
  const N = {
    unread: 1,
    items: [{ id: 4, kind: 'session_done', readAt: null }],
    _bellUnread() {
      const sessionUnread = N.items.filter((n) => isSessionNotifStub(n) && !n.readAt).length;
      return Math.max(0, N.unread - sessionUnread);
    },
  };
  let fetched = 0;
  const markAllRead = buildMarkAllRead(body);
  await markAllRead(
    N,
    () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); },
    {}, console, SESSION_KINDS, isSessionNotifStub
  );
  assert.equal(fetched, 0);
});

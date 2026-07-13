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

test('markAllRead marks items read, re-renders, and reconciles chat dots', async () => {
  const body = methodBody('async markAllRead');

  const rendered = { badge: 0, list: 0 };
  const N = {
    unread: 3,
    items: [
      { id: 1, kind: 'mention', readAt: null },
      { id: 2, kind: 'reply', readAt: null },
      { id: 3, kind: 'kudos', readAt: '2026-01-01T00:00:00Z' },
    ],
    _reconcileCompletionTitle() {},
    _renderBadge() { rendered.badge++; },
    _renderList() { rendered.list++; },
  };

  const fetchCalls = [];
  const fetchStub = (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ unread: 0, cleared: 2 }) });
  };

  let dotReconciles = 0;
  const windowStub = {
    GroupChat: { reconcileDotsFromNotifications() { dotReconciles++; } },
  };

  const markAllRead = new Function(
    'Notifications', 'fetch', 'window', 'console',
    `return (async () => {${body}})();`
  );
  await markAllRead(N, fetchStub, windowStub, console);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), { all: true });

  assert.equal(N.unread, 0);
  assert.ok(N.items.every((n) => n.readAt), 'every item is marked read locally');
  assert.equal(N.items[2].readAt, '2026-01-01T00:00:00Z', 'already-read timestamps preserved');
  assert.ok(rendered.badge >= 1 && rendered.list >= 1, 'badge and list re-rendered');
  assert.equal(dotReconciles, 1, 'in-chat unread dots reconciled without waiting for WS');
});

test('markAllRead early-returns when nothing is unread', async () => {
  const body = methodBody('async markAllRead');
  const N = { unread: 0, items: [] };
  let fetched = 0;
  const markAllRead = new Function(
    'Notifications', 'fetch', 'window', 'console',
    `return (async () => {${body}})();`
  );
  await markAllRead(N, () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); }, {}, console);
  assert.equal(fetched, 0);
});

'use strict';

// A message notification is a NOTIFICATION, and the bell is where it is
// counted.
//
// #1431 gave unread Messages a number of their own on a header chat bubble;
// #1443 kept the number and moved it onto the Messages ROW of the app chip's
// menu, subtracting `conversation_message` from the bell so one event could
// not light two badges. This reverses which side of that split survives.
//
// The rule it was defending is unchanged and still holds — one event, one
// badge. What changed is the answer to WHICH badge. The menu behind the chip
// is where you say where you are going; an unread count is a report that
// something happened to you, and the surface for that is the bell, whose
// sheet has rendered `conversation_*` rows with their own per-kind copy since
// #488. So the row lost its tag, the bell got its count back, and the number
// that was genuinely better about the retired one — that it is
// per-conversation — still exists on the conversation rows inside Messages,
// where it reads as a count rather than as an alert.
//
// Frontend logic is extracted from the shipped source (so these can't drift
// from what runs) and exercised against stubs, in the style of
// tests/notifications-mark-all.test.js.
//
// Run with: node --test tests/message-notifications-in-the-bell.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const STORE_SRC = read('frontend/src/features/messages/store.ts');
const SHEET_SRC = read('frontend/src/features/app-context/app-context-sheet.tsx');
const HTML = read('public/index.html');

// Pull a 2-space-indented object method's body out of the source so we can
// rebuild it as a standalone callable closing over injected stubs. Same
// helper, same reason, as tests/notifications-mark-all.test.js.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

// ── 1. the count is back on the bell ────────────────────────────────────

test('the bell splits out session notifications and nothing else', () => {
  // The body is a single `return`, so it is the function body as extracted.
  const bellUnread = new Function('Notifications', methodBody('_bellUnread'));

  // Nine unread on the account: four of them messages, two of them the
  // session kinds #improve-btn carries. Only the session pair is subtracted.
  const count = bellUnread({
    unread: 9,
    _sessionUnread: () => 2,
  });
  assert.equal(count, 7, 'message notifications are counted on the bell again');

  // The subtraction reads the loaded items page while `unread` is the
  // server's account-wide total, so it can overshoot on an account with more
  // unread than one page holds. An undercount beats a negative badge.
  assert.equal(bellUnread({ unread: 1, _sessionUnread: () => 4 }), 0);
});

test('nothing in notifications.js counts or paints a messages badge', () => {
  assert.doesNotMatch(FE_SRC, /_messageUnread/,
    'the conversation_message subtraction is gone, not merely unused');
  assert.doesNotMatch(FE_SRC, /__usernodeMessagesUnread/,
    'the window seam the retired badge was published on is gone');
  assert.doesNotMatch(FE_SRC, /drawer-messages-badge/,
    '_renderBadge paints the bell only');
});

// ── 2. …and off the row behind the app chip ─────────────────────────────

test('the Messages row in the chip menu is a plain destination', () => {
  assert.match(HTML, /id="switcher-row-messages" href="#messages"/,
    'the row itself stays: Messages has its own page');
  assert.doesNotMatch(HTML, /drawer-messages-badge/,
    'the unread tag is gone from the shell, not shipped hidden');
  assert.doesNotMatch(SHEET_SRC, /id="drawer-messages-badge"/);

  // The per-conversation counts that made the retired badge defensible still
  // exist — inside Messages, on the conversation rows, where they read as
  // counts rather than as an alert.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /conversation\.unreadCount > 0 \?/,
    'the Messages screen still shows a per-conversation unread count');
});

// ── 3. reading a conversation clears it from the bell, in this tab ──────

// The bell owning the count is what makes this load-bearing: the server
// clears a conversation's notification rows inside POST
// /api/conversations/:id/read, but nothing told THIS document, so the badge
// would have gone on counting messages the viewer had just sat and read.
function buildMarkConversationRead() {
  return new Function('Notifications', 'conversationId', methodBody('markConversationRead'));
}

function stubNotifications(items, unread) {
  const calls = { badge: 0, list: 0 };
  return {
    items,
    unread,
    calls,
    _renderBadge() { calls.badge += 1; },
    _renderList() { calls.list += 1; },
  };
}

test('markConversationRead clears that conversation and walks the total down', () => {
  const markConversationRead = buildMarkConversationRead();
  const items = [
    { id: 1, kind: 'conversation_message', conversationId: 5, readAt: null },
    { id: 2, kind: 'conversation_mention', conversationId: 5, readAt: null },
    // Already read: it must not be counted twice against `unread`.
    { id: 3, kind: 'conversation_message', conversationId: 5, readAt: '2026-08-01T00:00:00Z' },
    // Another conversation, and a notification with no conversation at all.
    { id: 4, kind: 'conversation_message', conversationId: 6, readAt: null },
    { id: 5, kind: 'kudos', appId: 3, conversationId: null, readAt: null },
  ];
  const N = stubNotifications(items, 4);

  markConversationRead(N, 5);

  assert.equal(items[0].readAt !== null, true);
  assert.equal(items[1].readAt !== null, true);
  assert.equal(items[2].readAt, '2026-08-01T00:00:00Z', 'an already-read row is untouched');
  assert.equal(items[3].readAt, null, 'another conversation keeps its unread row');
  assert.equal(items[4].readAt, null, 'a non-conversation notification is untouched');
  assert.equal(N.unread, 2, 'the total falls by exactly what cleared');
  assert.equal(N.calls.badge, 1);
  assert.equal(N.calls.list, 1);
});

test('markConversationRead is inert when there is nothing to clear', () => {
  const markConversationRead = buildMarkConversationRead();
  const items = [{ id: 1, kind: 'conversation_message', conversationId: 5, readAt: '2026-08-01T00:00:00Z' }];
  const N = stubNotifications(items, 3);

  markConversationRead(N, 5);
  assert.equal(N.unread, 3, 'a conversation with nothing unread does not move the total');
  assert.equal(N.calls.badge, 0, 'and does not repaint');

  // Never below zero: `unread` is the server's total and the items array is
  // one loaded page of it, so the two can disagree.
  const short = stubNotifications(
    [{ id: 2, kind: 'conversation_message', conversationId: 7, readAt: null },
      { id: 3, kind: 'conversation_message', conversationId: 7, readAt: null }],
    1,
  );
  markConversationRead(short, 7);
  assert.equal(short.unread, 0);

  // A junk id reaches the loop with nothing to match; guard before it does.
  const guarded = stubNotifications([{ id: 4, conversationId: 7, readAt: null }], 1);
  for (const bad of [0, -1, 1.5, NaN, null, undefined, 'seven']) {
    markConversationRead(guarded, bad);
  }
  assert.equal(guarded.unread, 1);
  assert.equal(guarded.calls.badge, 0);
});

// ── 4. the Messages store is what calls it ──────────────────────────────

test('the Messages store tells the bell on a local read, and on its own cross-tab read', () => {
  assert.match(STORE_SRC, /window\.Notifications\?\.markConversationRead\?\.\(conversationId\)/,
    'the seam is window.Notifications: notifications.js must stay import-free');

  const markRead = STORE_SRC.slice(
    STORE_SRC.indexOf('export async function markRead('),
    STORE_SRC.indexOf('function eventConversationId('),
  );
  const publishAt = markRead.indexOf('publish({ conversations: items })');
  const notifyAt = markRead.indexOf('notifyConversationRead(conversationId)');
  assert.ok(publishAt > -1 && notifyAt > publishAt,
    'the bell is reconciled on the local read, without waiting for the round-trip');

  const readEvent = STORE_SRC.slice(
    STORE_SRC.indexOf("case 'conversation_read':"),
    STORE_SRC.indexOf("case 'conversation_membership_changed':"),
  );
  assert.match(readEvent, /=== currentUser\(\)\.id/,
    'the event fans out to every member, so only the reader\'s own tabs clear');
  assert.match(readEvent, /notifyConversationRead\(conversationId\)/);

  assert.doesNotMatch(STORE_SRC, /drawer-messages-badge/,
    'syncDrawerBadge and its listener are gone with the element they wrote to');
});

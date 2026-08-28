'use strict';

// Making a message findable in the bell, once the bell is where messages live.
//
// The move landed (#1446) and the notification was there — at the bottom of a
// flat chronological feed that also carries every session completion,
// proposal nudge and kudos row, four rows deep because a message notification
// is created per member PER MESSAGE. Two things follow from that, and this
// file pins both:
//
//   1. A run of consecutive same-conversation rows collapses into ONE row
//      carrying a count. This is the per-conversation quality the retired
//      Messages tag had and the bell gave up; it comes back here rather than
//      as a second badge somewhere else.
//   2. The sheet grows a Messages tab — one place to catch up on
//      conversations whatever the rest of the feed is doing — and that tab
//      carries the way out to the full #messages screen, the same
//      destination the app chip's Messages row opens.
//
// Frontend logic is extracted from the shipped source (so these cannot drift
// from what runs) and exercised against stubs, in the style of
// tests/notifications-mark-all.test.js.
//
// Run with: node --test tests/notifications-messages-tab.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');
const SHEET_SRC = read('frontend/src/features/notifications/notifications-sheet.tsx');
const HTML = read('public/index.html');
const dapp = JSON.parse(read('dapp.json'));

// Rebuild a top-level function from the shipped source, so the collapsing
// rule under test is the one that ships.
function topLevelFn(name, args) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = FE_SRC.match(re);
  assert.ok(m, `${name}() found in notifications.js`);
  return new Function(...args, m[2]);
}

const collapse = topLevelFn('collapseConversationRuns', ['items']);

const msg = (id, conversationId, readAt = null) => ({
  id, kind: 'conversation_message', conversationId, readAt,
});

// ── 1. the collapsing rule ──────────────────────────────────────────────

test('a run of consecutive same-conversation rows becomes one counted run', () => {
  const runs = collapse([
    msg(4, 7), msg(3, 7), msg(2, 7), msg(1, 7),
  ]);
  assert.equal(runs.length, 1, 'four messages, one row');
  assert.equal(runs[0].count, 4);
  assert.equal(runs[0].item.id, 4, 'the run is represented by its NEWEST member');
});

test('a lone notification is a run of one, and app rows never merge', () => {
  const runs = collapse([
    msg(9, 7),
    { id: 8, kind: 'session_done', appId: 3, conversationId: null, readAt: null },
    { id: 7, kind: 'kudos', appId: 3, conversationId: null, readAt: null },
  ]);
  assert.equal(runs.length, 3, 'nothing collapses');
  assert.deepEqual(runs.map((r) => r.count), [1, 1, 1]);
  // Two app notifications for the SAME app sit next to each other above and
  // stay separate: a null conversation id must never match another null one,
  // or every app row in the feed would fold into its neighbour.
  assert.equal(runs[1].item.id, 8);
  assert.equal(runs[2].item.id, 7);
});

test('only CONSECUTIVE rows merge, so nothing is re-dated or reordered', () => {
  const runs = collapse([
    msg(5, 7),
    { id: 4, kind: 'session_done', appId: 3, conversationId: null, readAt: null },
    msg(3, 7),
    msg(2, 7),
  ]);
  assert.equal(runs.length, 3, 'the interrupted burst stays two separate rows');
  assert.deepEqual(runs.map((r) => r.count), [1, 1, 2]);
  // The feed is newest-first and each run sits where its newest member sat,
  // so the session row keeps its chronological place between the two bursts.
  assert.deepEqual(runs.map((r) => r.item.id), [5, 4, 3]);
});

test('two conversations back to back stay two rows', () => {
  const runs = collapse([msg(4, 7), msg(3, 7), msg(2, 8), msg(1, 8)]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.count), [2, 2]);
  assert.deepEqual(runs.map((r) => r.conversationId), [7, 8]);
});

test('read and unread never share a run', () => {
  const runs = collapse([msg(4, 7), msg(3, 7), msg(2, 7, '2026-08-01T00:00:00Z')]);
  assert.equal(runs.length, 2, 'the read one is its own row');
  assert.deepEqual(runs.map((r) => r.count), [2, 1]);
  assert.equal(runs[0].read, false);
  assert.equal(runs[1].read, true);
  // This is what lets the Unread tab filter whole ROWS: a run is entirely
  // unread or entirely read, so filtering can never hide an unread message
  // inside a row it counted as read.
  const merged = collapse([msg(9, 7), msg(8, 7, '2026-08-01T00:00:00Z')]);
  assert.ok(merged.every((r) => typeof r.read === 'boolean'));
  assert.equal(merged.length, 2);
});

test('the count rides only on a genuine collapse', () => {
  const views = FE_SRC.slice(FE_SRC.indexOf('function screenViews('),
    FE_SRC.indexOf('// One notification row, as data.'));
  assert.match(views, /run\.count > 1\s*\?/,
    'a single notification keeps the view it always had, with no count field');
});

// ── 2. the Messages tab ─────────────────────────────────────────────────

test('the sheet filters a Messages tab off the row flag, not off kind', () => {
  assert.match(SHEET_SRC, /const messages = all\.filter\(\(view\) => view\.conversation\)/);
  assert.match(SHEET_SRC, /tab === 'unread' \? unread : tab === 'messages' \? messages : all/);
  // The flag is set where CONVERSATION_NOTIF_KINDS already lives, so the tab
  // cannot drift from the set the routing and the row copy agree on.
  assert.match(FE_SRC, /conversation: true,/);
  assert.match(HTML, /id="notifications-tab-messages"/,
    'the tab ships in the static markup, so it is there before any data loads');
});

test('the tab count sums collapsed rows, so it agrees with the bell', () => {
  assert.match(
    SHEET_SRC,
    /unread\.reduce\(\(sum, view\) => sum \+ \(view\.count \|\| 1\), 0\)/,
    'a collapsed row stands for `count` notifications; counting rows would say 1 where the '
    + 'badge says 4',
  );
  assert.match(SHEET_SRC, /\{unreadCount \? `Unread \(\$\{unreadCount\}\)` : 'Unread'\}/);
});

test('the Messages tab carries the way out to the full Messages screen', () => {
  const button = SHEET_SRC.slice(
    SHEET_SRC.indexOf("id=\"notifications-all-messages\""),
    SHEET_SRC.indexOf('<NotificationsPinnedSections />'),
  );
  assert.ok(button, 'the button is rendered on the messages tab');
  // Same destination as the app chip's Messages row, reached the same way a
  // notification row reaches a conversation.
  assert.match(button, /if \(bridge\?\.open\) bridge\.open\(\);/,
    'the React bridge re-renders even when #messages is already the hash');
  assert.match(button, /else window\.location\.hash = '#messages';/,
    'and the hash fallback works before the island publishes its controller');
  // On touch the sheet is a modal kit sheet: it has to be gone before the
  // screen it navigates to arrives.
  assert.match(button, /NotificationsSheet\.close\(\)/);
  const closeAt = button.indexOf('NotificationsSheet.close()');
  const navAt = button.indexOf('bridge.open()');
  assert.ok(closeAt > -1 && navAt > closeAt, 'dismissed before it routes');
  // It replaces Saved + Invites on that tab rather than stacking under them:
  // between them those two can hold ~384px, most of a phone's first screen.
  assert.match(SHEET_SRC, /tab === 'messages' \? \(/);
});

test('a URL reaches the tab, because a declared check cannot click', () => {
  assert.match(FE_SRC, /shot !== 'notifications' && shot !== 'notifications-messages'/,
    'the deep link opens the sheet');
  assert.match(SHEET_SRC, /if \(shot === 'notifications-messages'\) setTab\('messages'\)/,
    'and selects the tab');
  // In an effect, never in the initial state: the SSG pass renders this island
  // in Node, and a render-time read of location would mismatch on hydration —
  // which console.errors, which fails proposal checks.
  const effect = SHEET_SRC.slice(SHEET_SRC.indexOf("const [tab, setTab]"),
    SHEET_SRC.indexOf('const all = snap.screenList'));
  assert.match(effect, /useIsomorphicLayoutEffect/);
  // The prerendered tab is UNREAD, which is also where the sheet opens: the
  // bell is tapped because it has a count, and the count is the unread. What
  // this line is really pinning is that the initial tab is a CONSTANT — the
  // SSG pass and the client's first render must agree on it, whatever it is,
  // or hydration mismatches and console.errors.
  assert.match(effect, /useState<Tab>\('unread'\)/, 'the prerendered tab is Unread');
  assert.doesNotMatch(HTML, /id="notifications-all-messages"/,
    'so the button is absent from the static markup, and is not an ADDED_IDS entry');
});

test('declared checks cover the tab, the way out and a collapsed row', () => {
  const has = (fragment) => dapp.tests.some(
    (t) => (t.expectSelector || '').includes(fragment),
  );
  assert.ok(has('#notifications-tab-messages'), 'the tab is checked');
  assert.ok(has('#notifications-all-messages'), 'the way out is checked');
  assert.ok(has('[aria-label="2 notifications"]'), 'a collapsed count is checked');
  // Every route that needs the tab active reaches it by URL.
  for (const t of dapp.tests) {
    if ((t.expectSelector || '').includes('#notifications-all-messages')) {
      assert.match(t.path, /shot=notifications-messages/,
        'the check opens the tab it asserts on');
    }
  }
});

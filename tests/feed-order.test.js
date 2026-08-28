// The Feed's ORDER: strictly most-recent-activity-first, across every kind of
// card at once.
//
// This file used to pin the opposite contract. #388 gave the retired List view
// a grouped order — proposals above issues, and inside the proposal group a
// merge-pipeline pin rank (merging > resolving > conflict-failed > normal) so
// a PR about to merge could not sink under proposals with newer chatter.
//
// THE UI OVERHAUL replaced that view with the Feed, whose whole job is the
// other question: what has been happening here lately. Grouping is the wrong
// answer to it — an issue commented on a minute ago sat below every open
// proposal, however stale — and pinning a pipeline state inside a
// chronological stream is a lie about when something happened. The
// prioritised view still exists; it is the Kanban board, which keeps the pin
// rank (inlined in _bucketDevItems) and is tested by dev-kanban-buckets.
//
// So the assertions below are inverted on purpose: recency wins, every time,
// and completed work is in the stream rather than parked beneath it.
//
// app-view.js is a plain browser script (`const AppView = {…}`). We load it
// into a vm context, stub the globals it reaches, and assert on the order of
// the items \_feedItems() returns.
//
// Run with: node --test tests/feed-order.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'feed' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  // \_feedItems reads these; default to empty so each test sets only what it needs.
  AppView._ghIssues = [];
  AppView._govProposals = [];
  AppView._envIssueNumbers = new Set();
  AppView._proposalsCtx = { majority: 1 };
  return AppView;
}

// Distinct, non-equal activity timestamps so recency ordering is unambiguous.
// Higher hour = more recent.
const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;
const prop = (over) => ({
  id: over.id, pr_number: over.id * 10, pr_title: `PR ${over.id}`,
  username: 'me', user_id: 1, status: 'promoted',
  created_at: at(1), promoted_at: at(1), last_message_at: at(1),
  ...over,
});

// _feedItems() runs inside the vm context, so its result array is a
// different realm's Array (prototype mismatch trips deepStrictEqual). Map to
// a plain host-realm array of ids for comparison.
//
// The app's general DISCUSSION rides in this stream too — it is activity like
// anything else, and the Activity view is the only place it is drawn as a row
// (the kanban gets a card instead; see AppView._discussionCardModel). It is
// dropped here so every test below keeps asserting exactly the ordering it was
// written to assert; where the discussion itself sorts has its own test at the
// foot of this file.
const idsOf = (items) => Array.from(
  items.filter((it) => it.kind !== 'discussion'), (it) => it.id);

test('a pipeline state does NOT outrank recency any more', () => {
  const AppView = makeAppView();
  // Authored exactly as the #388 test authored them: the pipeline-state rows
  // are the OLDEST and the plain rows the NEWEST. Under the old grouping the
  // pinned rows came first regardless; in the Feed the clock decides.
  AppView._proposals = [
    prop({ id: 'normal-new', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
    prop({ id: 'failed', merge_conflict_state: 'failed', behind_main: 1, created_at: at(3), promoted_at: at(3), last_message_at: at(3) }),
    prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    prop({ id: 'resolving', resolving: true, created_at: at(2), promoted_at: at(2), last_message_at: at(2) }),
    prop({ id: 'normal-old', created_at: at(4), promoted_at: at(4), last_message_at: at(4) }),
  ];
  assert.deepEqual(
    idsOf(AppView._feedItems()),
    ['normal-new', 'normal-old', 'failed', 'resolving', 'merging']
  );
});

test('a new comment lifts a card, which is the whole point of a feed', () => {
  const AppView = makeAppView();
  // `last_message_at` is half of every item's sort key, so a card that only
  // got a COMMENT rises exactly as a newly created one would. That is the
  // "cards with comments" half of what the Feed is for.
  AppView._proposals = [
    prop({ id: 'old-but-commented', created_at: at(1), promoted_at: at(1), last_message_at: at(10) }),
    prop({ id: 'newer-and-quiet', created_at: at(5), promoted_at: at(5), last_message_at: at(5) }),
  ];
  assert.deepEqual(
    idsOf(AppView._feedItems()),
    ['old-but-commented', 'newer-and-quiet']
  );
});

test('issues, proposals and governance interleave by time, not by kind', () => {
  const AppView = makeAppView();
  AppView._proposals = [
    prop({ id: 'prop', created_at: at(5), promoted_at: at(5), last_message_at: at(5) }),
  ];
  AppView._govProposals = [
    { id: 'gov', created_at: at(3), last_message_at: at(3) },
  ];
  AppView._ghIssues = [
    { number: 555, updatedAt: at(9), lastMessageAt: at(9) },
    { number: 111, updatedAt: at(1), lastMessageAt: at(1) },
  ];
  // Under the retired grouping the two proposals sorted above BOTH issues,
  // however new the issues were. Now the newest issue leads.
  assert.deepEqual(idsOf(AppView._feedItems()), [555, 'prop', 'gov', 111]);
});

test('completed work is in the stream, not parked beneath it', () => {
  const AppView = makeAppView();
  // The retired List view rendered merged proposals and closed issues in a
  // separate "Completed" block below everything — which is precisely where
  // you would not look for "what just finished".
  AppView._merged = [
    { id: 'merged-recent', row_type: 'pr', created_at: at(8), merged_at: at(8), last_message_at: at(8) },
    { id: 'closed-old', row_type: 'close_issue', created_at: at(2), closed_at: at(2), last_message_at: at(2) },
  ];
  AppView._proposals = [
    prop({ id: 'open', created_at: at(5), promoted_at: at(5), last_message_at: at(5) }),
  ];
  const items = AppView._feedItems();
  assert.deepEqual(idsOf(items), ['merged-recent', 'open', 'closed-old']);
  assert.equal(items[0].kind, 'merged', 'completed rows carry their own kind');
});

test('a shared session sorts on when it was shared, not below everything', () => {
  const AppView = makeAppView();
  // Under the grouping this key was NEGATED — a trick to flip the descending
  // sort into oldest-first within the issues tier. With no tiers left a
  // negative key sorts below every real timestamp, i.e. every shared session
  // would sink to the bottom forever. Sharing IS the activity here.
  AppView._sharedSessions = [
    { id: 'shared-new', shared_at: at(9), last_message_at: at(9) },
    { id: 'shared-old', shared_at: at(2), last_message_at: at(2) },
  ];
  AppView._proposals = [
    prop({ id: 'mid', created_at: at(5), promoted_at: at(5), last_message_at: at(5) }),
  ];
  assert.deepEqual(idsOf(AppView._feedItems()), ['shared-new', 'mid', 'shared-old']);
});

test('the retired pin-rank helper is gone, not just unused', () => {
  // Leaving it behind would invite a future edit to "restore" the pinning it
  // encodes, which the Feed's contract has to refuse. The Kanban board keeps
  // its own inlined copy — see _bucketDevItems.
  const AppView = makeAppView();
  assert.equal(typeof AppView._proposalPinRank, 'undefined');
  assert.equal(typeof AppView._headlessRank, 'undefined');
});

// ── The general discussion's place in the stream ─────────────────────────

test('the discussion sorts on its latest message, like every other row', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'notes' };
  AppView._proposals = [
    prop({ id: 'newer', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
    prop({ id: 'older', created_at: at(3), promoted_at: at(3), last_message_at: at(3) }),
  ];
  AppView._discussionSummary = {
    slug: 'notes', username: 'grace', content: 'are we shipping?', createdAt: at(6),
  };
  const kinds = Array.from(AppView._feedItems(), (it) => it.kind);
  assert.deepEqual(kinds, ['proposal', 'discussion', 'proposal'],
    'a conversation last spoken in at 06:00 sits between 09:00 and 03:00');
});

test('a discussion nobody has posted in is not in the stream at all', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'notes' };
  AppView._proposals = [prop({ id: 'p', created_at: at(3), promoted_at: at(3), last_message_at: at(3) })];
  // No summary at all — the fetch has not landed, or there is nothing to fetch.
  AppView._discussionSummary = null;
  assert.deepEqual(Array.from(AppView._feedItems(), (it) => it.kind), ['proposal'],
    'a conversation that has not happened is not activity; the kanban card is '
    + 'the door that does not depend on there being any');
});

test("a previous app's summary cannot put a row on this app's board", () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'notes' };
  AppView._proposals = [prop({ id: 'p', created_at: at(3), promoted_at: at(3), last_message_at: at(3) })];
  // Mid-hop: the cache still holds the app you just left.
  AppView._discussionSummary = { slug: 'other-app', username: 'x', content: 'hi', createdAt: at(9) };
  assert.deepEqual(Array.from(AppView._feedItems(), (it) => it.kind), ['proposal'],
    'a summary for another app reads as absent, so nothing of it leaks across');
});

// ── The page cap, and the one row exempt from it ─────────────────────────

test('the discussion renders even when the page is full of newer work', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'notes' };
  AppView._devDataReady = true;
  AppView._mergedCtx = { majority: 1 };
  // 25 proposals, every one newer than the last thing said in the chat, so a
  // capped page of 20 would cut the discussion off entirely — which is exactly
  // the apps that have the most going on.
  AppView._proposals = Array.from({ length: 25 }, (_, i) => prop({
    id: `p${i}`, created_at: at(5), promoted_at: at(5), last_message_at: at(5),
  }));
  AppView._discussionSummary = {
    slug: 'notes', username: 'grace', content: 'still here', createdAt: at(1),
  };
  const view = AppView._feedView();
  const keys = Array.from(view.entries, (e) => e.key);
  assert.ok(keys.includes('discussion'), 'the discussion is on the page');
  assert.equal(keys[keys.length - 1], 'discussion',
    'and last, because it IS older than everything shown');
  assert.equal(keys.length, 21, 'the cap still bounds the work rows at 20');
  // Field by field: the footer is built inside the vm realm, and
  // deepStrictEqual compares prototypes (see the note on idsOf above).
  assert.equal(view.footer.kind, 'showMore');
  assert.equal(view.footer.n, 5,
    '"Show more" counts the work rows only — the discussion is never behind '
    + 'the pager, so it must not inflate what the button promises');
});

test('the discussion sits at its own place inside the page, not pinned to it', () => {
  const AppView = makeAppView();
  AppView.appData = { slug: 'notes' };
  AppView._devDataReady = true;
  AppView._mergedCtx = { majority: 1 };
  AppView._proposals = [
    prop({ id: 'newer', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
    prop({ id: 'older', created_at: at(3), promoted_at: at(3), last_message_at: at(3) }),
  ];
  AppView._discussionSummary = {
    slug: 'notes', username: 'grace', content: 'middle', createdAt: at(6),
  };
  assert.deepEqual(
    Array.from(AppView._feedView().entries, (e) => e.key),
    ['proposal:newer', 'discussion', 'proposal:older'],
    'lifting it out of the cap must not lift it out of the ORDER');
});

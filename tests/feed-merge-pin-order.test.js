// #388: a PR in the merge pipeline ("Merging…") or resolving conflicts
// ("Resolving conflicts…" / "⚠ Conflict resolution failed") should pin to
// the top of the dev-view proposal stack so it's obvious it's the next one
// to merge — instead of sinking under proposals with newer chatter.
//
// AppView.\_feedItems() owns the feed order. It tags each item with a group
// (proposals/gov above issues) and a per-group secondary rank, then stable-
// sorts by (group, rank, recency-desc). For proposals the rank is the
// merge-pipeline pin rank from \_proposalPinRank: merging(0) > resolving(1) >
// conflict-failed(2) > normal(3); within a tier most-recent-activity wins.
//
// app-view.js is a plain browser script (`const AppView = {…}`). We load it
// into a vm context, stub the globals it reaches, and assert on the order of
// the items \_feedItems() returns.
//
// Run with: node --test tests/feed-merge-pin-order.test.js

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
const idsOf = (items) => Array.from(items, (it) => it.id);

test('_proposalPinRank: maps each state to the badge-matching tier', () => {
  const AppView = makeAppView();
  assert.equal(AppView._proposalPinRank({ status: 'merging' }), 0, 'merging → 0');
  assert.equal(AppView._proposalPinRank({ status: 'promoted', resolving: true }), 1, 'resolving → 1');
  assert.equal(AppView._proposalPinRank({ status: 'promoted', merge_conflict_state: 'failed' }), 2, 'failed → 2');
  // #47: failing / error checks pin at tier 3, just below conflict-failed.
  assert.equal(AppView._proposalPinRank({ status: 'promoted', check_state: 'failing' }), 3, 'checks failing → 3');
  assert.equal(AppView._proposalPinRank({ status: 'promoted', check_state: 'error' }), 3, 'checks error → 3');
  assert.equal(AppView._proposalPinRank({ status: 'promoted' }), 4, 'plain promoted → 4');
  // Precedence: merging outranks a stale resolving/failed snapshot on the same row.
  assert.equal(AppView._proposalPinRank({ status: 'merging', resolving: true, merge_conflict_state: 'failed' }), 0);
  assert.equal(AppView._proposalPinRank({ status: 'promoted', resolving: true, merge_conflict_state: 'failed' }), 1);
  assert.equal(AppView._proposalPinRank(null), 4, 'null guard → normal tier');
});

test('feed: merging → resolving → failed → normal, regardless of recency', () => {
  const AppView = makeAppView();
  // Author the pipeline-state rows as the OLDEST (would sort last on recency
  // alone) and the normal rows as the NEWEST, so only the pin can reorder them.
  AppView._proposals = [
    prop({ id: 'normal-new', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
    prop({ id: 'failed', merge_conflict_state: 'failed', behind_main: 1, created_at: at(3), promoted_at: at(3), last_message_at: at(3) }),
    prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    prop({ id: 'resolving', resolving: true, created_at: at(2), promoted_at: at(2), last_message_at: at(2) }),
    prop({ id: 'normal-old', created_at: at(4), promoted_at: at(4), last_message_at: at(4) }),
  ];
  assert.deepEqual(
    idsOf(AppView._feedItems()),
    ['merging', 'resolving', 'failed', 'normal-new', 'normal-old']
  );
});

test('feed: within a pinned tier, most-recent-activity wins (stable)', () => {
  const AppView = makeAppView();
  AppView._proposals = [
    prop({ id: 'merging-old', status: 'merging', created_at: at(2), promoted_at: at(2), last_message_at: at(2) }),
    prop({ id: 'merging-new', status: 'merging', created_at: at(8), promoted_at: at(8), last_message_at: at(8) }),
    prop({ id: 'normal', created_at: at(5), promoted_at: at(5), last_message_at: at(5) }),
  ];
  assert.deepEqual(
    idsOf(AppView._feedItems()),
    ['merging-new', 'merging-old', 'normal']
  );
});

test("feed: 'behind' and a bare 'conflict' snapshot are NOT pinned", () => {
  const AppView = makeAppView();
  AppView._proposals = [
    prop({ id: 'behind', merge_conflict_state: 'behind', behind_main: 3, created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    prop({ id: 'conflict', merge_conflict_state: 'conflict', behind_main: 2, created_at: at(2), promoted_at: at(2), last_message_at: at(2) }),
    prop({ id: 'normal-new', created_at: at(7), promoted_at: at(7), last_message_at: at(7) }),
    prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
  ];
  // Only 'merging' pins; the rest stay in the normal tier ordered by recency.
  assert.deepEqual(
    idsOf(AppView._feedItems()),
    ['merging', 'normal-new', 'conflict', 'behind']
  );
});

test('feed: governance proposals sit in the normal tier, below pinned PRs', () => {
  const AppView = makeAppView();
  AppView._proposals = [
    prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    prop({ id: 'normal', created_at: at(3), promoted_at: at(3), last_message_at: at(3) }),
  ];
  AppView._govProposals = [
    { id: 'gov', created_at: at(9), last_message_at: at(9) }, // newest of all
  ];
  const ids = idsOf(AppView._feedItems());
  assert.equal(ids[0], 'merging', 'merging PR pins above everything in the group');
  // gov (rank 3, newest) sorts above the normal PR (rank 3, older) by recency,
  // but both stay below the pinned merging PR.
  assert.deepEqual(ids, ['merging', 'gov', 'normal']);
});

test('feed: all proposals (pinned included) still sort above GitHub issues', () => {
  const AppView = makeAppView();
  AppView._proposals = [
    prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
  ];
  AppView._ghIssues = [
    { number: 555, updatedAt: at(11), lastMessageAt: at(11) }, // newest thing overall
  ];
  const items = AppView._feedItems();
  assert.equal(items[0].kind, 'proposal', 'proposal group renders first');
  assert.equal(items[items.length - 1].kind, 'issue', 'issues stay last despite newer activity');
});

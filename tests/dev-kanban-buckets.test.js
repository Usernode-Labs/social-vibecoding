// Kanban view-mode: AppView._bucketDevItems() sorts the cached dev data
// into the four lifecycle columns shown on the board:
//
//   issues     — open GitHub issues with NO proposal yet (headless none/
//                failed/absent) and not linked to an open promoted proposal
//   inProgress — open issues whose headless proposal is generating/ready
//   inReview   — promoted PR proposals + governance proposals
//   done       — merged proposals
//
// The helper is pure (data in → buckets out, no DOM, no AppView state), so
// we load app-view.js into a vm context the same way feed-merge-pin-order
// does and call it directly with synthetic rows.
//
// Run with: node --test tests/dev-kanban-buckets.test.js

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
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
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
  return sandbox.__AppView;
}

// Distinct, non-equal activity timestamps so recency ordering is unambiguous.
const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;

const issue = (over) => ({
  number: over.number, title: `Issue ${over.number}`,
  updatedAt: at(1), lastMessageAt: at(1), headless: null,
  ...over,
});
const prop = (over) => ({
  id: over.id, pr_number: over.id * 10, pr_title: `PR ${over.id}`,
  username: 'me', user_id: 1, status: 'promoted', linked_issues: [],
  created_at: at(1), promoted_at: at(1), last_message_at: at(1),
  ...over,
});

// Buckets returned from the vm realm hold that realm's objects — compare by
// stable scalar keys mapped into the host realm.
const numbersOf = (items) => Array.from(items, (i) => i.number);
const idsOf = (items) => Array.from(items, (i) => i.id);
const reviewOf = (items) => Array.from(items, (x) => `${x.kind}:${x.item.id}`);

test('headless none/failed/absent → Issues; generating/ready → In progress', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 1, headless: null }),
      issue({ number: 2, headless: { status: 'failed' } }),
      issue({ number: 3, headless: { status: 'generating' } }),
      issue({ number: 4, headless: { status: 'ready' } }),
    ],
    proposals: [],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues).sort(), [1, 2]);
  assert.deepEqual(numbersOf(b.inProgress).sort(), [3, 4]);
});

test('issues linked to an open promoted proposal are excluded from both issue columns', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 10, headless: null }),
      issue({ number: 11, headless: { status: 'ready' } }),
      issue({ number: 12, headless: null }),
    ],
    // Proposal addresses issues 10 (plain) and 11 (ready) — both must drop
    // out of the issue columns since they render as the proposal card.
    proposals: [prop({ id: 100, linked_issues: [10, 11] })],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [12], 'only the unlinked plain issue remains');
  assert.deepEqual(numbersOf(b.inProgress), [], 'linked ready issue is removed');
  assert.deepEqual(reviewOf(b.inReview), ['proposal:100']);
});

test('In review holds promoted proposals + governance proposals', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [prop({ id: 1 }), prop({ id: 2 })],
    gov: [{ id: 9, kind: 'rename', created_at: at(1), last_message_at: at(1) }],
    merged: [],
  });
  const tags = reviewOf(b.inReview).sort();
  assert.deepEqual(tags, ['gov:9', 'proposal:1', 'proposal:2']);
});

test('In review: pinned pipeline states sort above normal, gov in the normal tier', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [
      prop({ id: 'normal', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
      prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    ],
    gov: [{ id: 'gov', kind: 'rename', created_at: at(8), last_message_at: at(8) }],
    merged: [],
  });
  // merging pins first; then the normal tier (rank 3) by recency: the
  // newest normal proposal (at 9) then the gov proposal (at 8).
  assert.deepEqual(reviewOf(b.inReview), ['proposal:merging', 'proposal:normal', 'gov:gov']);
});

test('Done holds merged rows, most-recent-activity first', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [],
    gov: [],
    merged: [
      { id: 1, created_at: at(2), last_message_at: at(2) },
      { id: 2, created_at: at(7), last_message_at: at(7) },
      { id: 3, created_at: at(5), last_message_at: at(5) },
    ],
  });
  assert.deepEqual(idsOf(b.done), [2, 3, 1]);
});

test('issue columns sort newest-activity first', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 1, updatedAt: at(2), lastMessageAt: at(2) }),
      issue({ number: 2, updatedAt: at(6), lastMessageAt: at(6) }),
      issue({ number: 3, updatedAt: at(4), lastMessageAt: at(4) }),
    ],
    proposals: [],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [2, 3, 1]);
});

test('empty / missing inputs yield four empty columns', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({});
  // The result is a vm-realm object, so compare each column's length in the
  // host realm rather than deep-equalling the whole object across realms.
  assert.equal(b.issues.length, 0);
  assert.equal(b.inProgress.length, 0);
  assert.equal(b.inReview.length, 0);
  assert.equal(b.done.length, 0);
});

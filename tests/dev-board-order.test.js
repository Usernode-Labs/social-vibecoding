// #613/#617: AppView._applyManualOrder() is the pure overlay that re-sorts
// one already-bucketed kanban column against a saved manual order. Cards
// ABSENT from the stored order come first, in their derived order (they
// arrived after the order was saved, so they surface at the top — #617); ranked
// cards follow in stored order; stale stored refs are skipped; an empty
// order is a no-op. Also covers _cardOrderKey (card → identity string) which
// the saved overlay and the server share. The inverse parser went with the
// drag gesture — nothing in the UI writes an order any more.
//
// The helpers are pure (no DOM, no AppView state), so we load app-view.js
// into a vm context exactly like tests/dev-kanban-buckets.test.js.
//
// Run with: node --test tests/dev-board-order.test.js

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

// Issue cards are bare rows keyed by `number`; review entries are
// { kind, item } keyed by item.id.
const issue = (number) => ({ number, title: `Issue ${number}` });
const review = (kind, id) => ({ kind, item: { id, pr_title: `${kind} ${id}` } });

// Results returned from the vm realm hold that realm's objects — marshal to
// host-realm scalars with Array.from (host builtin) before asserting, exactly
// like dev-kanban-buckets.test.js's numbersOf/reviewOf helpers.
const numbersOf = (items) => Array.from(items, (i) => i.number);
const reviewKeysOf = (items) => Array.from(items, (x) => `${x.kind}:${x.item.id}`);

test('empty order returns the cards unchanged (today\'s board)', () => {
  const AppView = makeAppView();
  const cards = [issue(1), issue(2), issue(3)];
  const out = AppView._applyManualOrder(cards, [], (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [1, 2, 3]);
});

test('stored order reorders matched cards, unmatched lead in derived order', () => {
  const AppView = makeAppView();
  // Derived order 1,2,3,4; saved order ranks 3 then 1. Unranked 2 and 4
  // arrived after the order was saved, so they surface first (#617).
  const cards = [issue(1), issue(2), issue(3), issue(4)];
  const order = [{ type: 'issue', ref: 3 }, { type: 'issue', ref: 1 }];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [2, 4, 3, 1]);
});

test('stale stored refs (card no longer in column) are skipped', () => {
  const AppView = makeAppView();
  const cards = [issue(1), issue(2)];
  // 99 has left the column (e.g. it gained a proposal); order still lists it.
  const order = [{ type: 'issue', ref: 99 }, { type: 'issue', ref: 2 }];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [1, 2]);
});

test('review column keys distinguish proposal vs gov by kind', () => {
  const AppView = makeAppView();
  const cards = [review('proposal', 10), review('gov', 20), review('proposal', 30)];
  const order = [{ type: 'gov', ref: 20 }, { type: 'proposal', ref: 30 }];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('review', c));
  assert.deepEqual(reviewKeysOf(out), ['proposal:10', 'gov:20', 'proposal:30']);
});

test('#617: a new card absent from a non-empty saved order renders at the top', () => {
  const AppView = makeAppView();
  // The column was fully snapshotted as 1,3,2 by a saved order; issues 5 and 4
  // were filed afterwards (derived order puts 5 before 4, newest first).
  const cards = [issue(5), issue(4), issue(3), issue(2), issue(1)];
  const order = [
    { type: 'issue', ref: 1 }, { type: 'issue', ref: 3 }, { type: 'issue', ref: 2 },
  ];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('issues', c));
  // New arrivals lead, keeping their derived relative order; the manual
  // arrangement follows intact.
  assert.deepEqual(numbersOf(out), [5, 4, 1, 3, 2]);
});

test('_cardOrderKey shapes match the stored (type, ref) pairs', () => {
  const AppView = makeAppView();
  assert.equal(AppView._cardOrderKey('issues', issue(7)), 'issue:7');
  assert.equal(AppView._cardOrderKey('review', review('proposal', 5)), 'proposal:5');
  assert.equal(AppView._cardOrderKey('review', review('gov', 8)), 'gov:8');
  // A card missing its identity yields null (it simply stays unranked).
  assert.equal(AppView._cardOrderKey('issues', { title: 'no number' }), null);
});

test('a single-card column is a no-op even with a saved order', () => {
  const AppView = makeAppView();
  const cards = [issue(1)];
  const out = AppView._applyManualOrder(cards, [{ type: 'issue', ref: 1 }],
    (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [1]);
});

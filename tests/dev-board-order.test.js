// #613: AppView._applyManualOrder() is the pure overlay that re-sorts one
// already-bucketed kanban column against a saved manual order. Cards whose
// identity appears in the stored order come first (in that order); the rest
// keep their derived order (stable); stale stored refs are skipped; an empty
// order is a no-op. Also covers _cardOrderKey (card → identity string) which
// the drag handler and the server share, and _orderKeyToRef (the inverse the
// commit path uses).
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

test('stored order reorders matched cards, unmatched follow in derived order', () => {
  const AppView = makeAppView();
  // Derived order 1,2,3,4; saved order pins 3 then 1 to the top.
  const cards = [issue(1), issue(2), issue(3), issue(4)];
  const order = [{ type: 'issue', ref: 3 }, { type: 'issue', ref: 1 }];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [3, 1, 2, 4]);
});

test('stale stored refs (card no longer in column) are skipped', () => {
  const AppView = makeAppView();
  const cards = [issue(1), issue(2)];
  // 99 has left the column (e.g. it gained a proposal); order still lists it.
  const order = [{ type: 'issue', ref: 99 }, { type: 'issue', ref: 2 }];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [2, 1]);
});

test('review column keys distinguish proposal vs gov by kind', () => {
  const AppView = makeAppView();
  const cards = [review('proposal', 10), review('gov', 20), review('proposal', 30)];
  const order = [{ type: 'gov', ref: 20 }, { type: 'proposal', ref: 30 }];
  const out = AppView._applyManualOrder(cards, order, (c) => AppView._cardOrderKey('review', c));
  assert.deepEqual(reviewKeysOf(out), ['gov:20', 'proposal:30', 'proposal:10']);
});

test('_cardOrderKey shapes match the stored (type, ref) pairs', () => {
  const AppView = makeAppView();
  assert.equal(AppView._cardOrderKey('issues', issue(7)), 'issue:7');
  assert.equal(AppView._cardOrderKey('review', review('proposal', 5)), 'proposal:5');
  assert.equal(AppView._cardOrderKey('review', review('gov', 8)), 'gov:8');
  // A card missing its identity yields null (rendered un-draggable).
  assert.equal(AppView._cardOrderKey('issues', { title: 'no number' }), null);
});

test('_orderKeyToRef inverts _cardOrderKey for the commit path', () => {
  const AppView = makeAppView();
  const a = AppView._orderKeyToRef('issue:7');
  assert.equal(a.type, 'issue');
  assert.equal(a.ref, 7);
  const b = AppView._orderKeyToRef('proposal:45');
  assert.equal(b.type, 'proposal');
  assert.equal(b.ref, 45);
  assert.equal(AppView._orderKeyToRef('garbage'), null);
});

test('a single-card column is a no-op even with a saved order', () => {
  const AppView = makeAppView();
  const cards = [issue(1)];
  const out = AppView._applyManualOrder(cards, [{ type: 'issue', ref: 1 }],
    (c) => AppView._cardOrderKey('issues', c));
  assert.deepEqual(numbersOf(out), [1]);
});

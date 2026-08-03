// Home-screen card drag. The home grid holds ONE section now ("Your
// apps" — every other app moved to the #apps browse screen), which
// retires the cross-section add / remove drops issue #746 introduced:
// there is no second section to drag into or out of, so every drop is a
// reorder and removal is the card menu's "Remove from Your apps" (or the
// browse screen's ✓ badge).
//
// These tests pin the pure drop classification (canDropCard /
// classifyCardDrop / buildYoursOrder) and the _onKitCardDrop →
// _persistYoursDrop pipeline: optimistic Home._apps updates, the
// order-PUT-only wire traffic, and the failure revert. The
// favorite-POST-before-order-PUT sequencing (#618 hidden rows) is still
// covered — the legacy pointer path's remove-by-drag passes 'remove'
// straight to _persistYoursDrop.
//
// home.js is a plain browser script (`const Home = {…}`); we load it
// into a vm context with stubbed globals and call the helpers
// directly — same harness as home-your-apps-partition.test.js.
//
// Run with: node --test tests/home-drag-add.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home.js'),
  'utf8'
);

// Returns { Home, fetchCalls, toasts, setFetch } — fetchCalls records
// every request the sandbox issues ({ url, method, body }), toasts the
// PlatformUI.toast messages. setFetch swaps the response behaviour.
function makeHome() {
  const fetchCalls = [];
  const toasts = [];
  let fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    PlatformUI: { toast: (msg) => { toasts.push(String(msg)); } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => {
        let t = '';
        return {
          set textContent(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({
        url,
        method: opts.method || 'GET',
        body: opts.body ? JSON.parse(opts.body) : null,
      });
      return fetchImpl(url, opts);
    },
    alert: () => {},
    confirm: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return {
    Home: sandbox.__Home,
    fetchCalls,
    toasts,
    setFetch: (fn) => { fetchImpl = fn; },
  };
}

// Everything downstream of _onKitCardDrop resolves through microtasks
// (the fetch stub is immediate) — one macrotask turn flushes it all.
const flush = () => new Promise((r) => setImmediate(r));

const app = (over) => ({
  slug: 'some-app',
  name: 'Some App',
  is_collaborator: false,
  is_favorited: false,
  your_apps_hidden: false,
  favorite_order: null,
  ...over,
});

// ── canDropCard ───────────────────────────────────────────────────

test('canDropCard: every in-grid slot is a legal reorder target now', () => {
  const { Home } = makeHome();
  // One section = nothing meaningless to veto, for either flag value.
  assert.equal(Home.canDropCard(true, 0, 3), true, 'reorder to head');
  assert.equal(Home.canDropCard(true, 2, 3), true, 'reorder within');
  assert.equal(Home.canDropCard(true, 3, 3), true, 'trailing slot');
  assert.equal(Home.canDropCard(false, 4, 3), true, 'no cross-section veto left');
  assert.equal(Home.canDropCard(false, 0, 0), true, 'empty section');
});

// ── classifyCardDrop ──────────────────────────────────────────────

test('classifyCardDrop: within-section moves are reorders', () => {
  const { Home } = makeHome();
  const d = Home.classifyCardDrop(1, 2, 3);
  assert.equal(d.kind, 'reorder');
  assert.equal(d.index, 2);
  const end = Home.classifyCardDrop(0, 2, 3);
  assert.equal(end.kind, 'reorder');
  assert.equal(end.index, 2);
});

test('classifyCardDrop: never classifies an add or a remove any more', () => {
  const { Home } = makeHome();
  // The exact drops that used to mean "add from All Apps" / "remove by
  // dragging out" — All Apps is gone, so all of them are reorders.
  for (const [from, to, count] of [[4, 0, 3], [5, 1, 3], [3, 3, 3], [1, 3, 3], [2, 6, 3]]) {
    assert.equal(Home.classifyCardDrop(from, to, count).kind, 'reorder',
      `drop ${from}→${to} of ${count}`);
  }
});

test('classifyCardDrop: clamps a drop past the last card to the end', () => {
  const { Home } = makeHome();
  assert.equal(Home.classifyCardDrop(0, 9, 3).index, 2, 'appends, never out of range');
  assert.equal(Home.classifyCardDrop(1, 3, 3).index, 2);
  // Degenerate inputs must still produce a usable index.
  assert.equal(Home.classifyCardDrop(0, 0, 0).index, 0, 'empty section');
  assert.equal(Home.classifyCardDrop(0, 2, null).index, 2, 'no count known');
});

// ── buildYoursOrder ───────────────────────────────────────────────

test('buildYoursOrder: inserts an absent slug at the index (add)', () => {
  const { Home } = makeHome();
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b'], 'c', 0)], ['c', 'a', 'b']);
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b'], 'c', 1)], ['a', 'c', 'b']);
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b'], 'c', 2)], ['a', 'b', 'c']);
});

test('buildYoursOrder: moves a present slug to the index (reorder)', () => {
  const { Home } = makeHome();
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b', 'c'], 'c', 0)], ['c', 'a', 'b']);
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b', 'c'], 'a', 2)], ['b', 'c', 'a']);
});

test('buildYoursOrder: clamps out-of-range indices and tolerates empty input', () => {
  const { Home } = makeHome();
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b'], 'c', 99)], ['a', 'b', 'c']);
  assert.deepEqual([...Home.buildYoursOrder(['a', 'b'], 'c', -1)], ['c', 'a', 'b']);
  assert.deepEqual([...Home.buildYoursOrder([], 'c', 0)], ['c']);
  assert.deepEqual([...Home.buildYoursOrder(undefined, 'c', 0)], ['c']);
});

// ── _persistYoursDrop ─────────────────────────────────────────────

test('_persistYoursDrop add: favorite POST lands BEFORE the order PUT (#618 hidden rows)', async () => {
  const { Home, fetchCalls } = makeHome();
  await Home._persistYoursDrop('add', app({ slug: 'x' }), ['x', 'y']);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, '/api/apps/x/favorite');
  assert.equal(fetchCalls[0].method, 'POST');
  assert.deepEqual(fetchCalls[0].body, { favorited: true });
  assert.equal(fetchCalls[1].url, '/api/favorites/order');
  assert.equal(fetchCalls[1].method, 'PUT');
  assert.deepEqual(fetchCalls[1].body, { order: ['x', 'y'] });
});

test('_persistYoursDrop reorder: order PUT only, no favorite POST', async () => {
  const { Home, fetchCalls } = makeHome();
  await Home._persistYoursDrop('reorder', app({ slug: 'x' }), ['y', 'x']);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/favorites/order');
  assert.deepEqual(fetchCalls[0].body, { order: ['y', 'x'] });
});

test('_persistYoursDrop remove: favorite POST false, no PUT, confirmation toast', async () => {
  const { Home, fetchCalls, toasts } = makeHome();
  await Home._persistYoursDrop('remove', app({ slug: 'x' }), null);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/apps/x/favorite');
  assert.deepEqual(fetchCalls[0].body, { favorited: false });
  assert.deepEqual(toasts, ['Removed from Your apps']);
});

test('_persistYoursDrop failure: error toast + reload to server truth', async () => {
  const { Home, toasts, setFetch } = makeHome();
  setFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
  let reloaded = 0;
  Home.load = async () => { reloaded += 1; };
  await Home._persistYoursDrop('add', app({ slug: 'x' }), ['x']);
  assert.equal(reloaded, 1, 'Home.load() reverts the optimistic state');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /boom/);
});

// ── _onKitCardDrop (integration over the pieces above) ───────────

test('_onKitCardDrop never adds: no favorite POST for any drop', async () => {
  const { Home, fetchCalls } = makeHome();
  const mine = app({ slug: 'mine', is_collaborator: true });
  const also = app({ slug: 'also', is_collaborator: true });
  Home._apps = [mine, also];
  // The drop that used to mean "add from All Apps" (from past the
  // boundary) is now just a reorder: membership is never touched.
  Home._onKitCardDrop(1, 0, { dataset: { slug: 'also' } }, 2);
  assert.equal(also.is_favorited, false, 'membership flags untouched');
  assert.equal(also.favorite_order, 0);
  assert.equal(mine.favorite_order, 1, 'never-dragged member gets an explicit slot too');
  assert.equal(Home._rerenderPending, true, 're-render deferred to onSettle');
  await flush();
  assert.deepEqual(fetchCalls.map((c) => c.method), ['PUT'], 'order PUT only');
  assert.deepEqual(fetchCalls[0].body, { order: ['also', 'mine'] });
});

test('_onKitCardDrop never removes: dragging to the far end keeps the app', async () => {
  const { Home, fetchCalls } = makeHome();
  const mine = app({ slug: 'mine', is_collaborator: true, favorite_order: 0 });
  const other = app({ slug: 'other', is_collaborator: true, favorite_order: 1 });
  Home._apps = [mine, other];
  // Used to be "dragged out = remove". Removal is the card menu's job
  // now, so this is a reorder to the end and nothing is un-favorited.
  Home._onKitCardDrop(0, 5, { dataset: { slug: 'mine' } }, 2);
  assert.equal(mine.is_favorited, false, 'no favorite flag written');
  assert.equal(mine.your_apps_hidden, false, 'never hidden by a drag');
  assert.equal(mine.favorite_order, 1, 'clamped to the end of the section');
  await flush();
  assert.deepEqual(fetchCalls.map((c) => c.method), ['PUT']);
  assert.deepEqual(fetchCalls[0].body, { order: ['other', 'mine'] });
});

test('_onKitCardDrop reorder: reorders locally and PUTs the new order only', async () => {
  const { Home, fetchCalls } = makeHome();
  const a = app({ slug: 'a', is_favorited: true, favorite_order: 0 });
  const b = app({ slug: 'b', is_favorited: true, favorite_order: 1 });
  const c = app({ slug: 'c', is_favorited: true, favorite_order: 2 });
  Home._apps = [a, b, c];
  Home._onKitCardDrop(2, 0, { dataset: { slug: 'c' } }, 3);
  assert.deepEqual([c.favorite_order, a.favorite_order, b.favorite_order], [0, 1, 2]);
  await flush();
  assert.equal(fetchCalls.length, 1, 'no favorite POST on a pure reorder');
  assert.deepEqual(fetchCalls[0].body, { order: ['c', 'a', 'b'] });
});

test('_onKitCardDrop: unknown slug is a safe no-op', async () => {
  const { Home, fetchCalls } = makeHome();
  Home._apps = [app({ slug: 'a', is_favorited: true })];
  Home._rerenderPending = false;
  Home._onKitCardDrop(1, 0, { dataset: { slug: 'ghost' } }, 1);
  assert.equal(Home._rerenderPending, false);
  await flush();
  assert.equal(fetchCalls.length, 0);
});

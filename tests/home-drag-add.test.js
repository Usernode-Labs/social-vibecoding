// Issue #746: drag apps from "All Apps" into "Your apps" (and back
// out) on the home screen. The kit drag now matches every app card in
// the sectioned view; these tests pin the pure drop classification
// (canDropCard / classifyCardDrop / buildYoursOrder) and the
// _onKitCardDrop → _persistYoursDrop pipeline: optimistic Home._apps
// updates, the favorite-POST-before-order-PUT sequencing (#618 hidden
// rows), and the failure revert.
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

test('canDropCard: yours cards may drop anywhere (reorder or remove)', () => {
  const { Home } = makeHome();
  assert.equal(Home.canDropCard(true, 0, 3), true, 'reorder to head');
  assert.equal(Home.canDropCard(true, 2, 3), true, 'reorder within');
  assert.equal(Home.canDropCard(true, 3, 3), true, 'past the boundary = removal');
  assert.equal(Home.canDropCard(true, 7, 3), true, 'deep in All Apps = removal');
});

test('canDropCard: All Apps cards may only enter the yours range', () => {
  const { Home } = makeHome();
  assert.equal(Home.canDropCard(false, 0, 3), true, 'add at head');
  assert.equal(Home.canDropCard(false, 3, 3), true, 'boundary = append to yours');
  assert.equal(Home.canDropCard(false, 4, 3), false, 'All Apps is not reorderable');
  assert.equal(Home.canDropCard(false, 1, 0), false, 'empty yours: only slot 0');
  assert.equal(Home.canDropCard(false, 0, 0), true, 'empty yours: first favorite');
});

// ── classifyCardDrop ──────────────────────────────────────────────

test('classifyCardDrop: within-yours moves are reorders', () => {
  const { Home } = makeHome();
  const d = Home.classifyCardDrop(1, 2, 3);
  assert.equal(d.kind, 'reorder');
  assert.equal(d.index, 2);
  // to === yoursCount-1 via the section-boundary gap is still a
  // reorder-to-end (the kit's gap>from adjustment already ran).
  const end = Home.classifyCardDrop(0, 2, 3);
  assert.equal(end.kind, 'reorder');
  assert.equal(end.index, 2);
});

test('classifyCardDrop: All Apps card into the yours range is an add', () => {
  const { Home } = makeHome();
  const head = Home.classifyCardDrop(4, 0, 3);
  assert.equal(head.kind, 'add');
  assert.equal(head.index, 0);
  const mid = Home.classifyCardDrop(5, 1, 3);
  assert.equal(mid.kind, 'add');
  assert.equal(mid.index, 1);
  const append = Home.classifyCardDrop(3, 3, 3);
  assert.equal(append.kind, 'add');
  assert.equal(append.index, 3, 'boundary drop appends to the end of yours');
});

test('classifyCardDrop: empty yours — the only add lands at index 0', () => {
  const { Home } = makeHome();
  const d = Home.classifyCardDrop(2, 0, 0);
  assert.equal(d.kind, 'add');
  assert.equal(d.index, 0);
});

test('classifyCardDrop: yours card dropped past the boundary is a remove', () => {
  const { Home } = makeHome();
  const d = Home.classifyCardDrop(1, 3, 3);
  assert.equal(d.kind, 'remove');
  assert.equal(d.index, null);
  assert.equal(Home.classifyCardDrop(2, 6, 3).kind, 'remove');
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

test('_onKitCardDrop add: optimistic flags + contiguous local order + persisted order', async () => {
  const { Home, fetchCalls } = makeHome();
  const mine = app({ slug: 'mine', is_collaborator: true });
  const other = app({ slug: 'other' });
  Home._apps = [mine, other];
  // Matched-card indices: [mine(yours)][other(rest)] — drop other at 0.
  Home._onKitCardDrop(1, 0, { dataset: { slug: 'other' } }, 1);
  assert.equal(other.is_favorited, true);
  assert.equal(other.favorite_order, 0);
  assert.equal(mine.favorite_order, 1, 'never-dragged member gets an explicit slot too');
  assert.equal(Home._rerenderPending, true, 're-render deferred to onSettle');
  await flush();
  assert.deepEqual(fetchCalls.map((c) => c.method), ['POST', 'PUT']);
  assert.deepEqual(fetchCalls[1].body, { order: ['other', 'mine'] });
});

test('_onKitCardDrop add: un-hides a hidden member app (#618)', async () => {
  const { Home, fetchCalls } = makeHome();
  const hidden = app({ slug: 'hidden', is_collaborator: true, your_apps_hidden: true });
  Home._apps = [hidden];
  Home._onKitCardDrop(0, 0, { dataset: { slug: 'hidden' } }, 0);
  assert.equal(hidden.is_favorited, true);
  assert.equal(hidden.your_apps_hidden, false);
  assert.equal(hidden.favorite_order, 0);
  await flush();
  assert.deepEqual(fetchCalls[0].body, { favorited: true });
});

test('_onKitCardDrop remove: member app flips to hidden, favorite cleared', async () => {
  const { Home, fetchCalls } = makeHome();
  const mine = app({ slug: 'mine', is_collaborator: true, favorite_order: 0 });
  const other = app({ slug: 'other' });
  Home._apps = [mine, other];
  Home._onKitCardDrop(0, 1, { dataset: { slug: 'mine' } }, 1);
  assert.equal(mine.is_favorited, false);
  assert.equal(mine.your_apps_hidden, true, 'member removal is a display opt-out, not a delete');
  assert.equal(mine.favorite_order, null);
  assert.equal(Home._rerenderPending, true);
  await flush();
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(fetchCalls[0].body, { favorited: false });
});

test('_onKitCardDrop remove: plain favorite just unfavorites', async () => {
  const { Home, fetchCalls } = makeHome();
  const fav = app({ slug: 'fav', is_favorited: true, favorite_order: 0 });
  Home._apps = [fav];
  Home._onKitCardDrop(0, 1, { dataset: { slug: 'fav' } }, 1);
  assert.equal(fav.is_favorited, false);
  assert.equal(fav.your_apps_hidden, false, 'non-member never gets a hidden flag');
  await flush();
  assert.deepEqual(fetchCalls[0].body, { favorited: false });
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

// The Shortcuts heading's Sort menu (#3750): Home.sortShortcuts orders the
// viewer's tiles A–Z / Z–A and persists BOTH the arrangement (PUT
// /api/home-layout) and the fallback flow order (PUT /api/favorites/order).
// Contract pinned here:
//   - 'az' / 'za' pack the sorted slugs into a clean reading-order grid,
//     cache it, repaint, then issue BOTH writes — Z–A is sort-then-REVERSE,
//     so the whole order (tie-break included) flips the way a person would
//     expect a reversed shelf to read;
//   - 'manual' (and anything else) issues no fetch and repaints nothing:
//     the stored arrangement already wins in currentLayout, so it is the
//     resting state, not a mode;
//   - the staging demo payload (?demo=1) repaints but writes nothing, the
//     read-only contract _persistLayout already enforces for drags;
//   - the favorites body respects the route's 200-slug cap.
//
// Same harness as tests/home-card-menu.test.js: home.js in a vm context,
// stub globals, the real grid store, fetch recorded per URL.
//
// Run with: node --test tests/home-shortcuts-sort.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');

// deepEqual across a vm realm fails on Array.prototype identity (the layout
// test's own note); map through String so the values compare as plain ones.
const slugsOf = (layout) => Array.from(layout, (it) => String(it.slug));

function makeHomeEnv() {
  const sandbox = {
    console,
    App: { user: { id: 42 } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => ({ style: {}, dataset: {} }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    alert: () => {},
    confirm: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL,
    URLSearchParams,
    location: { search: '', origin: 'https://sv.test' },
    addEventListener: () => {},
    removeEventListener: () => {},
    PlatformUI: {
      menu: async () => null,
      toast: () => {},
    },
    detectInstallHost: () => 'none',
    HomePanels: { render: () => {}, ensureLoaded: () => Promise.resolve() },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, sandbox };
}

const mine = (slug, name, over = {}) => ({
  slug,
  name,
  is_favorited: true,
  is_collaborator: false,
  created_by: 999,
  created_at: '2026-06-01T00:00:00Z',
  ...over,
});

function recorder(sandbox) {
  const calls = [];
  sandbox.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({}) };
  };
  return calls;
}

test('sort az reorders the grid and persists layout + favorites order', () => {
  const { Home, sandbox } = makeHomeEnv();
  const calls = recorder(sandbox);
  Home._layouts = {};
  Home._apps = [
    mine('todo-list', 'Todo List'),
    mine('appraise', 'Appraise'),
    mine('live-translation', 'LIVE TRANSLATION'),
    mine('game-corner', 'Game Corner'),
  ];
  Home.sortShortcuts('az');
  // Optimistic repaint happened before any write: the cached layout is the
  // sorted reading order.
  const layout = Home._layoutCache;
  assert.deepEqual(
    slugsOf(layout),
    ['appraise', 'game-corner', 'live-translation', 'todo-list'],
  );
  // Stored bucket too, so a later currentLayout() agrees.
  assert.deepEqual(
    slugsOf(Home._layouts['4']),
    ['appraise', 'game-corner', 'live-translation', 'todo-list'],
  );
  // Two writes: the arrangement and the fallback flow order.
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/home-layout', '/api/favorites/order'],
  );
  const layoutPut = JSON.parse(calls[0].opts.body);
  assert.equal(layoutPut.cols, 4);
  assert.deepEqual(
    Array.from(layoutPut.items, (it) => String(it.slug)),
    ['appraise', 'game-corner', 'live-translation', 'todo-list'],
  );
  // 'az' has no double-write above it — call order is layout first.
  assert.equal(calls[1].url, '/api/favorites/order');
  assert.deepEqual(
    Array.from(JSON.parse(calls[1].opts.body).order, (s) => String(s)),
    ['appraise', 'game-corner', 'live-translation', 'todo-list'],
  );
});

test('sort za reverses the comparison but keeps the slug tie-break ascending', () => {
  const { Home, sandbox } = makeHomeEnv();
  const calls = recorder(sandbox);
  Home._layouts = {};
  Home._apps = [
    mine('b-notes', 'Notes'),
    mine('a-notes', 'Notes'),
    mine('appraise', 'Appraise'),
  ];
  // home.js's Z–A rule: sort with the comparator, then reverse the ARRAY —
  // so the two same-named apps land b-notes before a-notes, the tie-break
  // riding the same reversal the names took, exactly as a person reading
  // the grid would expect.
  Home.sortShortcuts('za');
  assert.deepEqual(
    slugsOf(Home._layoutCache),
    ['b-notes', 'a-notes', 'appraise'],
  );
  assert.equal(calls[0].url, '/api/home-layout');
  assert.equal(calls[1].url, '/api/favorites/order');
  assert.deepEqual(
    Array.from(JSON.parse(calls[1].opts.body).order, (s) => String(s)),
    ['b-notes', 'a-notes', 'appraise'],
  );
});

test('manual is the resting state: no fetch, no repaint', () => {
  const { Home, sandbox } = makeHomeEnv();
  const calls = recorder(sandbox);
  Home._apps = [mine('appraise', 'Appraise'), mine('todo-list', 'Todo List')];
  let painted = false;
  Home.render = () => { painted = true; };
  Home.sortShortcuts('manual');
  Home.sortShortcuts('nonsense');
  assert.equal(painted, false);
  assert.deepEqual(calls, []);
  assert.equal(Home._layoutCache, null);
});

test('demo payload repaints but writes nothing', () => {
  const { Home, sandbox } = makeHomeEnv();
  const calls = recorder(sandbox);
  Home._layouts = {};
  Home._apps = [mine('appraise', 'Appraise'), mine('todo-list', 'Todo List')];
  Home._layoutIsDemo = true;
  Home.sortShortcuts('az');
  assert.deepEqual(
    slugsOf(Home._layoutCache),
    ['appraise', 'todo-list'],
  );
  assert.deepEqual(calls, [], 'the demo fixture is read-only: no layout or favorites write');
});

test('favorites body respects the route 200-slug cap', () => {
  const { Home, sandbox } = makeHomeEnv();
  const calls = recorder(sandbox);
  Home._layouts = {};
  // 220 same-named apps; the slug tie-break keeps the order deterministic.
  Home._apps = Array.from({ length: 220 }, (_, i) => mine(
    `app-${String(i).padStart(3, '0')}`, 'Same Name',
  ));
  Home.sortShortcuts('az');
  const favoritesPut = calls.find((c) => c.url === '/api/favorites/order');
  const order = JSON.parse(favoritesPut.opts.body).order;
  assert.equal(order.length, 200);
  assert.deepEqual(
    Array.from(order, (s) => String(s)),
    Array.from({ length: 200 }, (_, i) => `app-${String(i).padStart(3, '0')}`),
  );
  // The layout still carries every app — the cap bounds the favorites list,
  // never the grid.
  assert.equal(slugsOf(Home._layoutCache).length, 220);
  // 220 apps at four columns = 55 rows; the 8-row canvas holds 32 on it and
  // 188 spill into the overflow region, which is what deriveDefault places.
});

// Home-screen FREE-FORM placement — the drag half of "put apps and widgets
// anywhere". Replaces tests/home-drag-add.test.js, which pinned the flow
// reorder model (canDropCard / classifyCardDrop / buildYoursOrder →
// PUT /api/favorites/order). That model is gone: it could only express an
// ordering, and an ordering cannot describe a grid with holes in it.
//
// What is pinned here:
//
//   1. The options Home hands the kit's attachGridPlacement — in particular
//      that the item selector matches EVERY widget host, including a create
//      widget rendered in its disabled state (lacking app quota must not
//      make the widget unmovable).
//   2. The lift/settle deferral contract: onLift holds _dragActive so a WS
//      app_status can't yank a tile from under the finger, and onSettle
//      flushes whatever was deferred — reload wins over re-render.
//   3. The drop → persist pipeline: a legal drop writes the whole width to
//      PUT /api/home-layout and NEVER to /api/favorites/order; an illegal
//      one writes nothing at all.
//   4. The failure revert: a rejected write refetches server truth rather
//      than leaving the grid showing an arrangement nobody saved.
//   5. Layout resolution: a stored width wins, the other width is reflowed,
//      and a DERIVATION is never persisted (a phone visit must not silently
//      overwrite the arrangement made on a laptop).
//
// home.js is a plain browser script (`const Home = {…}`); we load it into a
// vm context with stubbed globals — same harness as
// home-your-apps-partition.test.js — with home-layout.js loaded first,
// since Home lays out against it.
//
// Run with: node --test tests/home-grid-placement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const HOME_SRC = read('public/js/home.js');
const LAYOUT_SRC = read('public/js/home-layout.js');

// The registry the server serves, as the client sees it.
const REGISTRY = [
  { key: 'challenges', title: 'Challenges', removable: true, sizes: { 4: [4, 2], 5: [2, 2] } },
  { key: 'discover', title: 'Discover', removable: false, sizes: { 4: [4, 2], 5: [2, 2] } },
  { key: 'create', title: 'Create app', removable: true, sizes: { 4: [1, 1], 5: [1, 1] } },
];

// Returns { Home, HomeLayout, fetchCalls, toasts, setFetch, sandbox,
// attachCalls }. attachCalls records every attachGridPlacement invocation.
function makeHome({ width = 1280, canCreateApps = true } = {}) {
  const fetchCalls = [];
  const toasts = [];
  const attachCalls = [];
  let fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps } },
    PlatformUI: { toast: (msg) => { toasts.push(String(msg)); } },
    innerWidth: width,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      elementFromPoint: () => null,
      createElement: () => {
        let t = '';
        return {
          style: {},
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          set textContent(v) { t = String(v); },
          set innerHTML(v) { t = String(v); },
          get innerHTML() {
            return t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          },
          querySelector: () => null,
          querySelectorAll: () => [],
          appendChild: () => {},
        };
      },
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    unNative: {
      attachGridPlacement: (listEl, opts) => {
        attachCalls.push({ listEl, opts });
        return { detach: () => {} };
      },
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({
        url,
        method: opts.method || 'GET',
        body: opts.body ? JSON.parse(opts.body) : null,
      });
      return fetchImpl(url, opts);
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    location: { search: '', hash: '' },
    URLSearchParams,
    Date,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  const HomeLayout = sandbox.HomeLayout;
  HomeLayout.setRegistry(REGISTRY);
  // The widget registry Home reads placement keys from.
  sandbox.HomePanels = {
    gridSlotKeys: () => REGISTRY.map((r) => r.key),
    render: () => {},
    ensureLoaded: () => Promise.resolve(),
  };
  return {
    Home, HomeLayout, fetchCalls, toasts, attachCalls, sandbox,
    setFetch: (fn) => { fetchImpl = fn; },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

const app = (slug, over = {}) => ({
  slug, name: slug, status: 'running',
  is_collaborator: true, is_favorited: false, your_apps_hidden: false,
  favorite_order: null, featured: false, ...over,
});

// ── The attach contract ───────────────────────────────────────────────

test('Home wires the placement recognizer, not the flow reorder', () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._wireCards({ querySelectorAll: () => [] }, true, 1);
  assert.equal(attachCalls.length, 1);
  const { opts } = attachCalls[0];
  assert.equal(typeof opts.cellFromPoint, 'function', 'the host owns the geometry');
  assert.equal(typeof opts.canPlace, 'function');
  assert.equal(typeof opts.onPlace, 'function');
  assert.equal(typeof opts.onHover, 'function', 'the host paints the target highlight');
});

// The disabled create widget must still drag. This is the regression guard
// for gating placement on app quota — the widget is on every home screen,
// so a viewer without quota must be able to move it like any other.
test('the item selector matches every widget host, enabled or not', () => {
  const { Home, attachCalls } = makeHome({ canCreateApps: false });
  Home._apps = [app('a')];
  Home._wireCards({ querySelectorAll: () => [] }, true, 1);
  const sel = attachCalls[0].opts.itemSelector;
  assert.match(sel, /\.home-panel-slot/);
  assert.doesNotMatch(sel, /data-create-enabled/,
    'the recognizer must not read the create widget’s enabled state');
  // A disabled create widget's host element matches it.
  assert.ok('.home-panel-slot'.split(', ').some((s) => sel.includes(s)));
});

// The search view is a flat, transient list with no layout to write.
test('the search view arms no placement recognizer', () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._wireCards({ querySelectorAll: () => [] }, false, null);
  assert.equal(attachCalls.length, 0);
});

// ── Lift / settle deferral ────────────────────────────────────────────

test('onLift holds _dragActive; onSettle clears it and flushes a reload', async () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._wireCards({ querySelectorAll: () => [], appendChild: () => {} }, true, 1);
  const { opts } = attachCalls[0];

  let loaded = 0;
  Home.load = async () => { loaded += 1; };

  opts.onLift({ classList: { contains: () => false }, dataset: {} });
  assert.equal(Home._dragActive, true);

  // A WS event arriving mid-drag defers instead of replacing the grid.
  Home._reloadPending = true;
  opts.onSettle(true);
  assert.equal(Home._dragActive, false);
  await flush();
  assert.equal(loaded, 1, 'the deferred reload ran once the gesture ended');
  assert.equal(Home._reloadPending, false);
});

test('onSettle prefers a full reload over a cheap re-render', async () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._wireCards({ querySelectorAll: () => [] }, true, 1);
  const { opts } = attachCalls[0];
  let loaded = 0;
  let rendered = 0;
  Home.load = async () => { loaded += 1; };
  Home.render = () => { rendered += 1; };

  Home._reloadPending = true;
  Home._rerenderPending = true;
  opts.onSettle(true);
  await flush();
  assert.equal(loaded, 1);
  assert.equal(rendered, 0, 'server truth supersedes the optimistic repaint');

  // Re-render alone when that is all that was deferred.
  Home._rerenderPending = true;
  opts.onSettle(true);
  await flush();
  assert.equal(rendered, 1);
});

// ── The drop → persist pipeline ───────────────────────────────────────

function seedLayout(Home, cols = 5) {
  Home._apps = [app('a'), app('b')];
  Home._layouts = {
    5: [
      { type: 'app', slug: 'a', col: 0, row: 0 },
      { type: 'app', slug: 'b', col: 4, row: 0 },
      { type: 'widget', key: 'discover', col: 0, row: 1 },
      { type: 'widget', key: 'challenges', col: 3, row: 1 },
      { type: 'widget', key: 'create', col: 4, row: 4 },
    ],
    4: [],
  };
  Home._layoutFetchedAt = Date.now();
  Home._layoutCache = Home._layouts[String(cols)];
  return Home._layoutCache;
}

test('a legal drop writes the whole width to PUT /api/home-layout', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  // Move app "a" from (0,0) to an empty cell at (2,0).
  Home._onGridPlace({ dataset: { slug: 'a' }, classList: { contains: () => false } },
    { col: 2, row: 0 }, 5);
  await flush();

  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/home-layout');
  assert.equal(writes[0].body.cols, 5);
  const moved = writes[0].body.items.find((i) => i.slug === 'a');
  assert.deepEqual([moved.col, moved.row], [2, 0]);
  // Everything else held still — holes are preserved, nothing re-packs.
  const other = writes[0].body.items.find((i) => i.slug === 'b');
  assert.deepEqual([other.col, other.row], [4, 0]);
  // The retired flow endpoint is never touched.
  assert.equal(fetchCalls.filter((c) => c.url === '/api/favorites/order').length, 0);
  assert.equal(Home._rerenderPending, true, 'the repaint is deferred to onSettle');
});

test('dropping a 1x1 onto another 1x1 swaps them', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  Home._onGridPlace({ dataset: { slug: 'a' }, classList: { contains: () => false } },
    { col: 4, row: 0 }, 5);
  await flush();

  const items = fetchCalls.find((c) => c.method === 'PUT').body.items;
  assert.deepEqual(
    [items.find((i) => i.slug === 'a').col, items.find((i) => i.slug === 'a').row], [4, 0]);
  assert.deepEqual(
    [items.find((i) => i.slug === 'b').col, items.find((i) => i.slug === 'b').row], [0, 0]);
});

test('an illegal drop persists nothing', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  // Onto a cell the 2x2 Discover widget occupies — a widget needs its whole
  // footprint free and a tile can only swap with another single cell.
  Home._onGridPlace({ dataset: { panelSlot: 'challenges' },
    classList: { contains: (c) => c === 'home-panel-slot' } }, { col: 0, row: 1 }, 5);
  await flush();
  assert.equal(fetchCalls.filter((c) => c.method === 'PUT').length, 0);
});

test('a rejected write reverts to server truth', async () => {
  const { Home, toasts, setFetch, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};
  setFetch(async (url, opts) => (
    (opts && opts.method === 'PUT')
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, json: async () => ({ layouts: { 4: [], 5: [] }, widgets: REGISTRY }) }
  ));

  Home._onGridPlace({ dataset: { slug: 'a' }, classList: { contains: () => false } },
    { col: 2, row: 0 }, 5);
  await flush();
  await flush();

  assert.equal(toasts.length, 1, 'the failure is surfaced, not swallowed');
  assert.match(toasts[0], /layout/i);
  // ...and the client refetches rather than keeping an unsaved arrangement.
  assert.ok(fetchCalls.some((c) => c.method === 'GET' && c.url.startsWith('/api/home-layout')));
});

// ── Layout resolution ─────────────────────────────────────────────────

test('a stored width wins; the other width is reflowed but not persisted', async () => {
  const { Home, fetchCalls } = makeHome({ width: 390 }); // 4 columns
  seedLayout(Home, 5);

  const layout = Home.currentLayout(4);
  // Reflowed from the 5-column arrangement: reading order preserved, and
  // the widgets take their PHONE footprints (full width).
  assert.equal(HomeLayoutIdsOf(layout).slice(0, 2).join(','), 'app:a,app:b',
    'apps keep their reading order across the reflow');
  assert.equal(HomeLayoutIdsOf(layout).length, 5, 'nothing is dropped');
  const discover = layout.find((i) => i.key === 'discover');
  assert.equal(discover.col, 0, 'a 4-wide widget can only start at column 0');
  await flush();
  // A derivation is NOT a claim on this width.
  assert.equal(fetchCalls.filter((c) => c.method === 'PUT').length, 0);
});

test('deriving from flow order places every widget, create included', async () => {
  const { Home, fetchCalls } = makeHome({ canCreateApps: false });
  Home._apps = [app('a'), app('b')];
  Home._layouts = { 4: [], 5: [] };
  Home._layoutFetchedAt = Date.now();

  const layout = Home.currentLayout(5);
  const ids = HomeLayoutIdsOf(layout);
  // Apps first — today's arrangement — then the widgets, each at the first
  // free rectangle in registry order. Reading order and PLACEMENT order
  // differ once a 2x2 widget leaves a 1x1 gap beside it, so assert the
  // contract (apps lead, nothing is dropped) rather than a brittle sequence.
  assert.equal(ids.slice(0, 2).join(','), 'app:a,app:b');
  assert.equal(ids.slice(2).sort().join(','),
    'widget:challenges,widget:create,widget:discover');
  // No app quota changes nothing about placement.
  assert.ok(ids.includes('widget:create'));
  await flush();
  assert.equal(fetchCalls.filter((c) => c.method === 'PUT').length, 0, 'still a derivation');
});

// Reading-order ids of a layout, for compact assertions.
function HomeLayoutIdsOf(layout) {
  return layout.slice()
    .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col))
    .map((i) => (i.type === 'widget' ? `widget:${i.key}` : `app:${i.slug}`));
}

// ── Cell hit-testing ──────────────────────────────────────────────────

test('cellFromPoint reads the overlay’s own cells, never grid arithmetic', () => {
  const { Home, sandbox } = makeHome();
  sandbox.document.elementFromPoint = () => ({
    closest: (sel) => (sel === '[data-cell]' ? { dataset: { cell: '3,2' } } : null),
  });
  assert.deepEqual({ ...Home._cellFromPoint(10, 10) }, { col: 3, row: 2 });

  // Off the grid (deadspace, or the gap between cells) is null, not a guess.
  sandbox.document.elementFromPoint = () => ({ closest: () => null });
  assert.equal(Home._cellFromPoint(10, 10), null);
  sandbox.document.elementFromPoint = () => null;
  assert.equal(Home._cellFromPoint(10, 10), null);
});

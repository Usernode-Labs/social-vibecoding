// #2894: a "Your apps" tile can be dragged INTO the open Homeroom widget
// strip. #2892: an app added to the widget must not keep the tile's
// held/selected state.
//
// The drag is not a second recognizer. The strip is one more cell on the
// kit's attachGridPlacement that the grid already uses — a sentinel
// cellFromPoint returns while the finger is over #widget-strip — so what is
// pinned here is each callback's widget branch:
//
//   1. cellFromPoint resolves the strip only while the section is showing;
//   2. canPlace uses the menu's gate (running, not pinned, room left);
//   3. onHover tints the strip (data-drop) instead of previewing the grid;
//   4. onPlace writes NO layout, and onSettle pins the app — optimistically,
//      reverting to the registry when the bridge refuses;
//   5. a refused drop on a full widget shakes the strip, as the menu does;
//   6. both add paths release the tile (#2892).
//
// Same vm harness as home-grid-placement.test.js, with a fake strip and
// fake tiles behind document.getElementById / querySelectorAll.
//
// Run with: node --test tests/home-widget-drop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installAppCard } = require('./helpers/app-card');
const { installGridStore } = require('./helpers/home-grid-store');
const { HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');

function fakeAttrs(el) {
  const attrs = Object.create(null);
  el.setAttribute = (k, v) => { attrs[k] = String(v); };
  el.getAttribute = (k) => (k in attrs ? attrs[k] : null);
  el.removeAttribute = (k) => { delete attrs[k]; };
  el.attrs = attrs;
  return el;
}

function fakeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    has: (c) => set.has(c),
    get size() { return set.size; },
  };
}

// The strip sits at y 100..200, x 10..380; the grid is below it.
function makeStrip(tileRects = []) {
  const strip = fakeAttrs({
    animations: [],
    getBoundingClientRect: () => ({ left: 10, top: 100, right: 380, bottom: 200, width: 370, height: 100 }),
    querySelectorAll: (sel) => (sel === '.widget-tile'
      ? tileRects.map((r) => ({ getBoundingClientRect: () => r }))
      : []),
    animate(frames, opts) { strip.animations.push({ frames, opts }); },
    scrollIntoView() {},
  });
  return strip;
}

function makeCard(slug) {
  const card = fakeAttrs({
    dataset: { slug },
    classList: fakeClassList(['app-card', 'un-reorder-slot', 'home-item-displaced']),
    style: { transform: 'translate(10px, 0px)' },
    blurred: 0,
    blur() { card.blurred += 1; },
    closest: (sel) => (sel.startsWith('.app-card') ? card : null),
  });
  return card;
}

function makeHome({ strip = makeStrip(), cards = [] } = {}) {
  const attachCalls = [];
  const bridgeCalls = [];
  const fetchCalls = [];
  const registry = [];
  let addImpl = async (payload) => {
    registry.push({ id: `id-${registry.length}`, name: payload.name, url: payload.url });
  };
  const document = {
    activeElement: null,
    getElementById: (id) => (id === 'widget-strip' ? strip : null),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.app-card[data-slug]' ? cards : []),
    elementFromPoint: () => null,
    createElement: () => ({
      style: {}, classList: fakeClassList(), querySelector: () => null,
      querySelectorAll: () => [], appendChild: () => {},
    }),
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps: true } },
    PlatformUI: { toast: () => {} },
    innerWidth: 390,
    document,
    unNative: {
      attachGridPlacement: (listEl, opts) => {
        attachCalls.push({ listEl, opts });
        return { detach: () => {} };
      },
    },
    usernode: {
      addHomeScreenShortcut: async (payload) => { bridgeCalls.push(payload); return addImpl(payload); },
      getHomeScreenShortcuts: async () => ({ items: registry.map((r) => ({ ...r })) }),
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, method: opts.method || 'GET' });
      return { ok: true, json: async () => ({}) };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    location: { search: '', hash: '', origin: 'https://example.test' },
    URL,
    URLSearchParams,
    Date,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  sandbox.HomePanels = { render: () => {}, ensureLoaded: () => Promise.resolve() };
  const Home = sandbox.__Home;
  // The icon heal pass is its own subsystem with its own tests; here it would
  // only add bridge traffic to the counts.
  Home._healWidgetIcons = async () => {};
  Home._ensureDarkIconCapability = async () => false;
  // The grid overlay is DOM work home-grid-placement.test.js covers; these
  // tests only need the lift to hold _dragActive.
  Home._showGridOverlay = () => {};
  return {
    Home, sandbox, strip, attachCalls, bridgeCalls, fetchCalls, registry,
    setAdd: (fn) => { addImpl = fn; },
  };
}

const app = (slug, over = {}) => ({
  slug, name: slug, status: 'running', icon_url: `/icons/${slug}.png`,
  is_collaborator: true, is_favorited: false, your_apps_hidden: false,
  favorite_order: null, featured: false, ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

// A widget-mechanism session with the section open and `pinned` in it.
function openWidget(Home, pinned = []) {
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetSectionVisible = true;
  Home._widgetItems = pinned.map((slug, i) => ({
    id: `p${i}`, name: slug, url: `https://example.test/app/${slug}`,
  }));
}

function attach(env) {
  env.Home._attachGridPlacement({ querySelectorAll: () => [] }, true);
  return env.attachCalls[env.attachCalls.length - 1].opts;
}

const tile = (slug) => ({ dataset: { slug } });

// ── 1. Hit-testing ────────────────────────────────────────────────────

test('the open strip is a drop cell; the grid geometry is not consulted there', () => {
  const env = makeHome();
  env.Home._apps = [app('a')];
  openWidget(env.Home);
  const opts = attach(env);
  let gridAsked = 0;
  env.Home._targetCellFor = () => { gridAsked += 1; return { col: 0, row: 0 }; };
  const cell = opts.cellFromPoint(50, 150, {});
  assert.equal(env.Home._isWidgetDropCell(cell), true);
  assert.equal(gridAsked, 0);
  // Below the strip the grid answers as before.
  assert.deepEqual({ ...opts.cellFromPoint(50, 400, {}) }, { col: 0, row: 0 });
  assert.equal(gridAsked, 1);
});

test('a hidden widget section is not a drop target', () => {
  const env = makeHome();
  env.Home._apps = [app('a')];
  openWidget(env.Home);
  env.Home._widgetSectionVisible = false;
  const opts = attach(env);
  env.Home._targetCellFor = () => null;
  assert.equal(opts.cellFromPoint(50, 150, {}), null);
});

test('the sentinel is stable, so the kit sees one cell for the whole strip', () => {
  const env = makeHome();
  openWidget(env.Home);
  const opts = attach(env);
  const a = opts.cellFromPoint(20, 110, {});
  const b = opts.cellFromPoint(370, 190, {});
  assert.equal(a, b);
  // Never collides with a real grid cell under the kit's col/row compare.
  assert.equal(typeof a.col, 'string');
});

// ── 2. canPlace ───────────────────────────────────────────────────────

test('canPlace on the strip uses the menu gate: running, unpinned, room left', () => {
  const env = makeHome();
  env.Home._apps = [app('a'), app('b'), app('broken', { status: 'error' })];
  openWidget(env.Home, ['b']);
  const opts = attach(env);
  const W = env.Home.WIDGET_DROP_CELL;
  assert.equal(opts.canPlace(tile('a'), W), true);
  assert.equal(opts.canPlace(tile('b'), W), false, 'already pinned');
  assert.equal(opts.canPlace(tile('broken'), W), false, 'not running');
  openWidget(env.Home, Array.from({ length: env.Home.WIDGET_CAPACITY }, (_, i) => `x${i}`));
  assert.equal(opts.canPlace(tile('a'), W), false, 'widget full');
});

// ── 3. onHover ────────────────────────────────────────────────────────

test('hovering the strip tints it and clears the grid preview', () => {
  const env = makeHome();
  env.Home._apps = [app('a'), app('b')];
  openWidget(env.Home, ['b']);
  const opts = attach(env);
  const previews = [];
  env.Home._previewDrop = (el, cell, ok) => { previews.push({ cell, ok }); };
  opts.onHover(tile('a'), env.Home.WIDGET_DROP_CELL, true);
  assert.equal(env.strip.getAttribute('data-drop'), 'ok');
  assert.equal(previews.at(-1).cell, null, 'no grid cell previewed under the strip');
  opts.onHover(tile('b'), env.Home.WIDGET_DROP_CELL, false);
  assert.equal(env.strip.getAttribute('data-drop'), 'refused');
  opts.onHover(tile('a'), { col: 1, row: 0 }, true);
  assert.equal(env.strip.getAttribute('data-drop'), null, 'leaving the strip clears it');
  assert.deepEqual({ ...previews.at(-1).cell }, { col: 1, row: 0 });
});

test('the ghost lands in the slot after the last pinned tile', () => {
  const tiles = [{ left: 22, top: 112, right: 86, bottom: 170, width: 64, height: 58 }];
  const env = makeHome({ strip: makeStrip(tiles) });
  openWidget(env.Home, ['b']);
  const opts = attach(env);
  assert.deepEqual({ ...opts.rectForCell(tile('a'), env.Home.WIDGET_DROP_CELL) }, { left: 98, top: 112 });
  const empty = makeHome();
  openWidget(empty.Home);
  const o2 = attach(empty);
  assert.deepEqual({ ...o2.rectForCell(tile('a'), empty.Home.WIDGET_DROP_CELL) }, { left: 22, top: 112 });
});

// ── 4. Drop → pin ─────────────────────────────────────────────────────

test('a drop on the strip pins the app and writes no layout', async () => {
  const card = makeCard('a');
  const env = makeHome({ cards: [card] });
  env.Home._apps = [app('a')];
  openWidget(env.Home);
  const opts = attach(env);
  let gridPlaced = 0;
  env.Home._onGridPlace = () => { gridPlaced += 1; };
  opts.onLift(tile('a'));
  opts.onPlace(tile('a'), env.Home.WIDGET_DROP_CELL);
  assert.equal(gridPlaced, 0, 'the tile keeps its cell on the canvas');
  assert.equal(env.bridgeCalls.length, 0, 'nothing is pinned mid-gesture');
  opts.onSettle(true);
  assert.equal(env.Home._dragActive, false);
  // Optimistic: the tile is in the strip before the bridge answers.
  assert.deepEqual(Array.from(env.Home._widgetSlugs()), ['a']);
  await flush(); await flush();
  assert.equal(env.bridgeCalls.length, 1);
  assert.equal(env.bridgeCalls[0].url, 'https://example.test/app/a');
  assert.deepEqual(env.Home._widgetItems.map((i) => i.id), ['id-0'], 'registry truth replaces the placeholder');
  assert.equal(env.fetchCalls.filter((c) => c.url === '/api/home-layout').length, 0);
  assert.equal(env.strip.getAttribute('data-drop'), null);
});

test('a refused pin snaps the strip back to the registry', async () => {
  const env = makeHome();
  env.Home._apps = [app('a')];
  openWidget(env.Home);
  env.setAdd(async () => { throw new Error('User denied'); });
  const opts = attach(env);
  opts.onLift(tile('a'));
  opts.onPlace(tile('a'), env.Home.WIDGET_DROP_CELL);
  opts.onSettle(true);
  assert.equal(env.Home._widgetItems.length, 1, 'placeholder shown while in flight');
  await flush(); await flush(); await flush();
  assert.deepEqual(env.Home._widgetItems, []);
});

// ── 5. Full widget ────────────────────────────────────────────────────

test('releasing over a full widget shakes it, as the menu does', () => {
  const env = makeHome();
  env.Home._apps = [app('a')];
  openWidget(env.Home, Array.from({ length: env.Home.WIDGET_CAPACITY }, (_, i) => `x${i}`));
  const opts = attach(env);
  opts.onLift(tile('a'));
  opts.cellFromPoint(50, 150, {});
  opts.onHover(tile('a'), null, false); // the kit clears the hover first
  opts.onSettle(false);
  assert.equal(env.strip.animations.length, 1);
  assert.equal(env.bridgeCalls.length, 0);
  // A refused drop anywhere else does not.
  opts.onLift(tile('a'));
  opts.cellFromPoint(50, 400, {});
  opts.onSettle(false);
  assert.equal(env.strip.animations.length, 1);
});

// ── 6. #2892: the tile is released ────────────────────────────────────

test('"Add to Homeroom widget" releases the held tile', async () => {
  const card = makeCard('a');
  const env = makeHome({ cards: [card] });
  env.sandbox.document.activeElement = card;
  env.Home._apps = [app('a')];
  openWidget(env.Home);
  let menuClosed = 0;
  env.Home._menu = { dismiss: () => { menuClosed += 1; } };
  env.Home._contextLift = { item: card, origin: null };
  const displaced = { style: { transform: 'translate(4px, 0px)' }, classList: fakeClassList(['home-item-displaced']) };
  env.Home._previewEls = new Set([displaced]);
  await env.Home._menuAddShortcut(env.Home._apps[0]);
  assert.equal(menuClosed, 1);
  assert.equal(env.Home._contextLift, null);
  assert.equal(displaced.style.transform, '', 'no preview left displaced');
  assert.equal(displaced.classList.contains('home-item-displaced'), false);
  assert.equal(card.blurred, 1, 'the focus the popover returned is dropped');
  assert.equal(env.bridgeCalls.length, 1);
});

test('a drop releases only the dropped tile', async () => {
  const card = makeCard('a');
  const env = makeHome({ cards: [card] });
  env.sandbox.document.activeElement = card;
  env.Home._apps = [app('a'), app('b')];
  openWidget(env.Home);
  await env.Home._dropOnWidget('b');
  assert.equal(card.blurred, 0, 'another tile keeps its focus');
  await env.Home._dropOnWidget('a');
  assert.equal(card.blurred, 1);
});

test('the tile hover fill is gated to real hover pointers (#2892)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
  assert.doesNotMatch(css, /^\.app-card:hover\s*\{/m, 'no ungated tile hover fill');
  assert.match(css, /@media \(hover: hover\) \{\s*\.app-card:hover \{ background-color: var\(--bg-card\); \}/);
  assert.match(css, /#widget-strip\[data-drop="ok"\]/);
  assert.match(css, /#widget-strip\[data-drop="refused"\]/);
});

// ── ?shot=widget-drop ─────────────────────────────────────────────────

test('?shot=widget-drop shows the strip lit as a target without touching the bridge', () => {
  const env = makeHome();
  env.sandbox.location.search = '?demo=1&shot=widget-drop';
  env.Home._apps = [app('a', { name: 'Alpha' }), app('b', { name: 'Beta' })];
  const cards = [makeCard('a'), makeCard('b')].map((c) => {
    c.classList.remove('un-reorder-slot', 'home-item-displaced');
    return c;
  });
  const listEl = { offsetParent: {}, querySelectorAll: () => cards };
  let renders = 0;
  env.Home.render = () => { renders += 1; };
  env.Home._maybeShowShotWidgetDrop(listEl);
  assert.equal(renders, 1, 'first pass paints the strip');
  assert.equal(env.Home._widgetUiActive(), true);
  assert.deepEqual(Array.from(env.Home._widgetSlugs()), ['b']);
  assert.equal(env.Home._shortcutSupport, null, 'the bridge mechanism is left alone');
  env.Home._maybeShowShotWidgetDrop(listEl);
  assert.equal(cards[0].classList.contains('un-reorder-slot'), true);
  assert.equal(env.strip.getAttribute('data-drop'), 'ok');
  assert.equal(env.bridgeCalls.length, 0);
});

test('without the shot param nothing is painted', () => {
  const env = makeHome();
  env.Home._apps = [app('a')];
  const listEl = { offsetParent: {}, querySelectorAll: () => [makeCard('a')] };
  env.Home._maybeShowShotWidgetDrop(listEl);
  assert.equal(env.Home._widgetUiActive(), false);
});

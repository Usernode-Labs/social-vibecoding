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
  { key: 'challenges', title: 'Challenges', removable: true, sizes: { 4: [4, 1], 5: [2, 2] } },
  { key: 'discover', title: 'Discover', removable: false, sizes: { 4: [4, 1], 5: [2, 2] } },
  { key: 'create', title: 'Create app', removable: true, sizes: { 4: [4, 1], 5: [1, 1] } },
];

// Returns { Home, HomeLayout, fetchCalls, toasts, setFetch, sandbox,
// attachCalls, setWidth, fireResize, fireMediaChange, mediaQueries }.
// attachCalls records every attachGridPlacement invocation; the viewport
// helpers drive the live-resize path (setWidth moves the reported
// innerWidth, then fireResize/fireMediaChange delivers the signal the
// browser would).
function makeHome({ width = 1280, canCreateApps = true } = {}) {
  const fetchCalls = [];
  const toasts = [];
  const attachCalls = [];
  const winListeners = Object.create(null);
  const mediaQueries = [];
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
    addEventListener: (type, fn) => {
      (winListeners[type] || (winListeners[type] = [])).push(fn);
    },
    removeEventListener: () => {},
    // The breakpoint signal. Records every query the code subscribes to so
    // a test can assert it watched the right one, and lets a test deliver
    // a `change` the way a real browser would on a viewport crossing.
    matchMedia: (query) => {
      const entry = { query, handlers: [], get matches() { return false; } };
      entry.addEventListener = (type, fn) => {
        if (type === 'change') entry.handlers.push(fn);
      };
      entry.removeEventListener = () => {};
      mediaQueries.push(entry);
      return entry;
    },
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
    Home, HomeLayout, fetchCalls, toasts, attachCalls, sandbox, mediaQueries,
    setFetch: (fn) => { fetchImpl = fn; },
    setWidth: (w) => { sandbox.innerWidth = w; },
    fireResize: () => { (winListeners.resize || []).forEach((fn) => fn()); },
    fireMediaChange: () => {
      mediaQueries.forEach((mq) => mq.handlers.forEach((fn) => fn(mq)));
    },
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

// Dropping a widget onto cells another widget occupies DISPLACES it — the
// old rule refused this, which is what made a crowded grid unrearrangeable.
test('a drop onto occupied cells displaces the occupant and persists', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  // Challenges (2x2 at 3,1) onto the cells Discover (2x2 at 0,1) holds.
  Home._onGridPlace({ dataset: { panelSlot: 'challenges' },
    classList: { contains: (c) => c === 'home-panel-slot' } }, { col: 0, row: 1 }, 5);
  await flush();

  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1, 'the drop commits');
  const items = writes[0].body.items;
  const at = (pred) => {
    const it = items.find(pred);
    return [it.col, it.row];
  };
  assert.deepEqual(at((i) => i.key === 'challenges'), [0, 1]);
  // Same footprint, so it takes the vacated cells — a swap.
  assert.deepEqual(at((i) => i.key === 'discover'), [3, 1]);
  // The app tiles nowhere near the target held still.
  assert.deepEqual(at((i) => i.slug === 'a'), [0, 0]);
  assert.deepEqual(at((i) => i.slug === 'b'), [4, 0]);
  assert.equal(items.length, 5, 'nothing is lost');
});

// The second reported bug: a 2x2 widget nudged one cell over overlaps its own
// footprint. The dragged item is excluded from the occupancy test, so this is
// an ordinary move rather than an impossible one.
test('a widget can be dropped overlapping its own footprint', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  // Challenges is at (3,1); nudge it to (3,2) — one row down, overlapping.
  Home._onGridPlace({ dataset: { panelSlot: 'challenges' },
    classList: { contains: (c) => c === 'home-panel-slot' } }, { col: 3, row: 2 }, 5);
  await flush();

  const writes = fetchCalls.filter((c) => c.method === 'PUT');
  assert.equal(writes.length, 1, 'the self-overlapping drop commits');
  const ch = writes[0].body.items.find((i) => i.key === 'challenges');
  assert.deepEqual([ch.col, ch.row], [3, 2]);
});

// Only an item that isn't in the layout at all is refused now.
test('a drop of an unknown item persists nothing', async () => {
  const { Home, fetchCalls } = makeHome();
  seedLayout(Home);
  Home.render = () => {};

  Home._onGridPlace({ dataset: { slug: 'not-in-the-layout' },
    classList: { contains: () => false } }, { col: 2, row: 2 }, 5);
  await flush();
  assert.equal(fetchCalls.filter((c) => c.method === 'PUT').length, 0);
});

// The overlay must tint an occupied target, or the grid lies about where a
// release will land. canPlace and place are the same decision.
test('canPlace accepts occupied targets and self-overlap', () => {
  const { Home, attachCalls } = makeHome();
  seedLayout(Home);
  Home._apps = [app('a'), app('b')];
  Home._wireCards({ querySelectorAll: () => [], appendChild: () => {} }, true, 2);
  const { opts } = attachCalls[0];
  const challenges = { dataset: { panelSlot: 'challenges' },
    classList: { contains: (c) => c === 'home-panel-slot' } };

  assert.equal(opts.canPlace(challenges, { col: 0, row: 1 }), true, 'occupied by Discover');
  assert.equal(opts.canPlace(challenges, { col: 3, row: 2 }), true, 'overlaps itself');
  assert.equal(opts.canPlace(challenges, { col: 0, row: 0 }), true, 'occupied by a tile');
});

// ── The live displacement preview ─────────────────────────────────────
//
// While an item hovers a target, the occupants that WOULD be pushed move to
// the cells they'd land in. The flow reorder this replaced gave that away for
// free; free placement has to show it deliberately, because only the items
// that actually collide move at all.

// A grid whose cells and items are real enough for the preview to measure.
// Each overlay cell reports a rect from its data-cell, so a translate delta
// is exactly (dcol * CELL_W, drow * CELL_H).
const CELL_W = 100;
const CELL_H = 120;

function makeGridDom(items) {
  const cells = new Map();
  const nodes = new Map();
  const mk = (extra) => ({
    style: {},
    _cls: new Set(),
    classList: {
      add(...c) { c.forEach((x) => extra._cls.add(x)); },
      remove(...c) { c.forEach((x) => extra._cls.delete(x)); },
      contains: (c) => extra._cls.has(c),
    },
    ...extra,
  });
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 8; row++) {
      const cell = { dataset: { cell: `${col},${row}` }, _cls: new Set() };
      cell.classList = {
        add: (c) => cell._cls.add(c),
        remove: (c) => cell._cls.delete(c),
        contains: (c) => cell._cls.has(c),
      };
      cell.getBoundingClientRect = () => ({ left: col * CELL_W, top: row * CELL_H });
      cells.set(`${col},${row}`, cell);
    }
  }
  for (const it of items) {
    const node = { dataset: {}, style: {}, _cls: new Set() };
    node.classList = {
      add: (...c) => c.forEach((x) => node._cls.add(x)),
      remove: (...c) => c.forEach((x) => node._cls.delete(x)),
      contains: (c) => node._cls.has(c),
    };
    if (it.type === 'widget') {
      node.dataset.panelSlot = it.key;
      // _itemFor dispatches on this class, exactly as the real host carries it.
      node._cls.add('home-panel-slot');
    } else {
      node.dataset.slug = it.slug;
    }
    nodes.set(it.type === 'widget' ? `widget:${it.key}` : `app:${it.slug}`, node);
  }
  const overlay = {
    _cls: new Set(),
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    querySelector: (sel) => {
      const m = /\[data-cell="([^"]+)"\]/.exec(sel);
      return m ? (cells.get(m[1]) || null) : null;
    },
    querySelectorAll: (sel) => (sel === '.home-grid-cell--on'
      ? [...cells.values()].filter((c) => c._cls.has('home-grid-cell--on'))
      : []),
  };
  const listEl = {
    querySelector: (sel) => {
      let m = /\[data-panel-slot="([^"]+)"\]/.exec(sel);
      if (m) return nodes.get(`widget:${m[1]}`) || null;
      m = /\.app-card\[data-slug="([^"]+)"\]/.exec(sel);
      if (m) return nodes.get(`app:${m[1]}`) || null;
      return null;
    },
    querySelectorAll: () => [],
    appendChild: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
  };
  overlay.parentNode = Object.assign(listEl, { removeChild: () => {} });
  return { overlay, listEl, nodes, cells, mk };
}

// Wire a Home with a known layout and a measurable overlay, then hover.
// `cols` picks the breakpoint the layout is stored at (5 = desktop, 4 = phone,
// where the big widgets go full-width).
function makePreview(layout, { cols = 5, width = cols === 4 ? 390 : 1280 } = {}) {
  const h = makeHome({ width });
  h.Home._layouts = cols === 4 ? { 4: layout, 5: [] } : { 5: layout, 4: [] };
  h.Home._layoutFetchedAt = Date.now();
  h.Home._layoutCache = layout;
  const dom = makeGridDom(layout);
  h.Home._overlayEl = dom.overlay;
  h.dom = dom;
  h.hover = (id, col, row) => {
    const el = dom.nodes.get(id);
    h.Home._previewDrop(el, { col, row }, true, 5);
  };
  h.transformOf = (id) => dom.nodes.get(id).style.transform || '';
  h.classesOf = (id) => [...dom.nodes.get(id)._cls].sort().join(' ');
  h.tinted = () => [...dom.cells.values()]
    .filter((c) => c._cls.has('home-grid-cell--on'))
    .map((c) => c.dataset.cell);
  return h;
}

test('hovering an occupied cell slides the occupant to where it would land', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
    { type: 'app', slug: 'far', col: 4, row: 4 },
  ];
  const h = makePreview(layout);
  h.hover('app:a', 2, 0);

  // The target tints...
  assert.deepEqual(h.tinted(), ['2,0']);
  // ...and the occupant has actually MOVED to the cell it would land in —
  // a's vacated (0,0), two columns to the left of where b sits.
  assert.equal(h.transformOf('app:b'), `translate(${-2 * CELL_W}px, 0px)`);
  assert.match(h.classesOf('app:b'), /home-item-displaced/);
  // The dragged item is NOT transformed: the ghost under the finger and its
  // dashed origin slot already represent it.
  assert.equal(h.transformOf('app:a'), '');
  // An item the drop doesn't touch holds completely still.
  assert.equal(h.transformOf('app:far'), '');
  assert.equal(h.classesOf('app:far'), '');
});

test('the preview clears and restores when the hover moves', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
    { type: 'app', slug: 'c', col: 3, row: 1 },
  ];
  const h = makePreview(layout);

  h.hover('app:a', 2, 0);
  assert.notEqual(h.transformOf('app:b'), '', 'b is previewed');

  // Hover a DIFFERENT occupied cell: b goes back, c takes over.
  h.hover('app:a', 3, 1);
  assert.equal(h.transformOf('app:b'), '', 'b is restored');
  assert.equal(h.classesOf('app:b'), '');
  assert.notEqual(h.transformOf('app:c'), '', 'c is now previewed');

  // Hover an EMPTY cell: nothing is displaced at all.
  h.hover('app:a', 4, 4);
  assert.equal(h.transformOf('app:c'), '');
  assert.deepEqual(h.tinted(), ['4,4']);

  // Leaving the grid clears the tint and every transform.
  h.Home._previewDrop(h.dom.nodes.get('app:a'), null, false, 5);
  assert.deepEqual(h.tinted(), []);
  assert.equal(h.transformOf('app:b'), '');
  assert.equal(h.transformOf('app:c'), '');
});

test('a widget hover previews its whole footprint and every item it pushes', () => {
  const layout = [
    { type: 'widget', key: 'challenges', col: 0, row: 0 },   // 2x2
    { type: 'app', slug: 'a', col: 3, row: 3 },
    { type: 'app', slug: 'b', col: 4, row: 3 },
    { type: 'app', slug: 'c', col: 3, row: 4 },
    { type: 'app', slug: 'd', col: 4, row: 4 },
  ];
  const h = makePreview(layout);
  h.hover('widget:challenges', 3, 3);

  // All four cells of the 2x2 target tint, not just the one under the finger.
  assert.deepEqual(h.tinted().sort(), ['3,3', '3,4', '4,3', '4,4']);
  // ...and all four tiles it covers are previewed into the vacated 2x2.
  for (const slug of ['a', 'b', 'c', 'd']) {
    assert.match(h.classesOf(`app:${slug}`), /home-item-displaced/, slug);
    assert.notEqual(h.transformOf(`app:${slug}`), '', slug);
  }
});

// A displaced item can be pushed clean off the 8-row canvas. There is no
// overlay cell to slide it to, so it says so where it stands rather than
// moving silently or sliding somewhere that doesn't exist yet.
test('an item pushed into the overflow rows is marked, not translated', () => {
  // A FULL canvas: a 2x2 widget at (0,0) plus a tile in every other cell.
  const layout = [{ type: 'widget', key: 'challenges', col: 0, row: 0 }];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 5; col++) {
      if (row < 2 && col < 2) continue;            // the widget's own cells
      layout.push({ type: 'app', slug: `a${col}${row}`, col, row });
    }
  }
  const h = makePreview(layout);
  // Drag the far-corner TILE onto the widget's origin. The widget has to go
  // somewhere; the vacated cell is one wide and there is no free 2x2 left, so
  // it is pushed clean off the canvas.
  h.hover('app:a47', 0, 0);

  const widget = h.dom.nodes.get('widget:challenges');
  assert.ok(widget._cls.has('home-item-to-overflow'),
    'the widget is marked as heading for the overflow rows');
  assert.equal(widget.style.transform || '', '',
    'and is NOT slid to a cell that does not exist yet');
  assert.ok(!widget._cls.has('home-item-displaced'),
    'the two states are distinct — one slides, one says so in place');
});

// The preview and the drop must be ONE computation. Two would eventually
// disagree, and the grid would lie about where a release lands.
test('the preview reuses the plan canPlace computed', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
  ];
  const h = makePreview(layout);
  let calls = 0;
  const realPlace = h.HomeLayout.place;
  h.HomeLayout.place = (...args) => { calls += 1; return realPlace.apply(h.HomeLayout, args); };

  const el = h.dom.nodes.get('app:a');
  assert.equal(h.Home._planFor(el, { col: 2, row: 0 }, 5) !== null, true);
  assert.equal(calls, 1);
  // onHover right after must not recompute it.
  h.Home._previewDrop(el, { col: 2, row: 0 }, true, 5);
  assert.equal(calls, 1, 'the memo is what makes highlight and drop agree');
  // A different cell is a different plan.
  h.Home._previewDrop(el, { col: 3, row: 0 }, true, 5);
  assert.equal(calls, 2);
  h.HomeLayout.place = realPlace;
});

test('hiding the overlay clears every preview transform', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 0 },
  ];
  const h = makePreview(layout);
  h.hover('app:a', 2, 0);
  assert.notEqual(h.transformOf('app:b'), '');
  // onSettle → _hideGridOverlay: a cancelled or refused drag must not leave a
  // tile parked at a position nothing saved.
  h.Home._hideGridOverlay();
  assert.equal(h.transformOf('app:b'), '');
  assert.equal(h.classesOf('app:b'), '');
});

test('the preview motion matches the kit’s FLIP family', () => {
  const CSS = read('public/css/app.css');
  // 200ms ease is attachReorder's gridFlip timing — the preview has to feel
  // like the same mechanism, not a second animation language.
  assert.match(CSS, /\.home-item-displaced \{[^}]*transition: transform 200ms ease/);
  assert.match(read('public/usernode-native/v1/native.js'), /transition = 'transform 200ms ease'/);
  // z-index so a sliding tile passes OVER its stationary neighbours.
  assert.match(CSS, /\.home-item-displaced \{[^}]*z-index: 2/);
  // Reduced motion drops the tween but keeps the move — the new POSITION is
  // the information.
  assert.match(CSS, /prefers-reduced-motion[^}]*\}[\s\S]*?\.home-item-displaced \{ transition: none/);
  // The overflow marker is a visible state, not a silent move.
  assert.match(CSS, /\.home-item-to-overflow \{[^}]*opacity/);
  assert.match(CSS, /\.home-item-to-overflow::after \{[^}]*content: '↓'/);
});

test('?shot=home-grid renders a real preview, not just the outlines', () => {
  // The preview is the part a reviewer needs to see and the part nothing can
  // navigate to, so the deep link has to enter it — otherwise the declared
  // check only proves the dashed cells still paint.
  const shot = HOME_SRC.slice(
    HOME_SRC.indexOf('_maybeShowShotGrid(listEl) {'),
    HOME_SRC.indexOf('\n  // Kit-era long-press actions menu'));
  assert.match(shot, /_previewDrop\(el, \{ col: 0, row: 0 \}, true, cols\)/);
  assert.match(shot, /canvas\[canvas\.length - 1\]/, 'a deterministic notional dragged item');
  assert.match(shot, /canvas\.length > 1/, 'a single-item grid has nothing to displace');
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
  // The designed default: widgets at their home cells (Challenges top-left,
  // so it leads reading order), apps filling in around them. The exact cells
  // are pinned in tests/home-layout-model.test.js — what matters here is
  // that the derivation is complete, so assert the SET, not the sequence.
  assert.equal([...ids].sort().join(','),
    'app:a,app:b,widget:challenges,widget:create,widget:discover');
  assert.equal(ids[0], 'widget:challenges', 'the top-left cell is Challenges');
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

// ── The target cell: the TILE's centroid, not the finger ──────────────
//
// The ghost tracks the finger from wherever the tile was grabbed, so the
// pointer sits a grab-offset away from the tile's own box. Resolving the
// target from the pointer put the tile's TOP-LEFT under the finger: grab a
// 2x2 widget by its bottom-right and the highlight appeared two cells right
// and two rows down from the block being held, and the drop landed there.
// These pin the centroid rule that replaced it.

// Point the sandbox's elementFromPoint at the fake overlay: a point resolves
// to the cell containing it, or to nothing outside the canvas — the same
// gate the real overlay provides through its own cell elements.
function hitTestCells(h, cols = 5) {
  h.sandbox.document.elementFromPoint = (x, y) => {
    const col = Math.floor(x / CELL_W);
    const row = Math.floor(y / CELL_H);
    const cell = (col >= 0 && col < cols && row >= 0 && row < 8)
      ? h.dom.cells.get(`${col},${row}`) : null;
    return { closest: (sel) => (sel === '[data-cell]' && cell ? cell : null) };
  };
}

// The kit's third argument: the dragged tile's live viewport geometry. `grab`
// is where inside the tile the finger is holding it — the whole point being
// that it must not change the answer.
function ghostInfo(el, { left, top, w, h: rows, grabX = 0, grabY = 0 }) {
  const width = w * CELL_W;
  const height = rows * CELL_H;
  return {
    item: el,
    rect: { left, top, width, height },
    centerX: left + width / 2,
    centerY: top + height / 2,
    pointerX: left + grabX * width,
    pointerY: top + grabY * height,
  };
}

// The recognizer's own options, so these exercise the wired callback rather
// than the internals.
function wiredOpts(h) {
  h.Home._apps = [app('a')];
  h.Home._wireCards({ querySelectorAll: () => [] }, true, 1);
  return h.attachCalls[h.attachCalls.length - 1].opts;
}

test('where the tile was grabbed does not move the target', () => {
  const layout = [{ type: 'widget', key: 'discover', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('widget:discover');
  // A 2x2 ghost sitting exactly over cells (1,1)-(2,2).
  const place = { left: CELL_W, top: CELL_H, w: 2, h: 2 };

  for (const [grabX, grabY] of [[0, 0], [0.5, 0.5], [1, 1], [0.9, 0.1]]) {
    const info = ghostInfo(el, { ...place, grabX, grabY });
    assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 5) },
      { col: 1, row: 1 }, `grab at ${grabX},${grabY} must not move the block`);
  }
});

test('a 2x2 widget grabbed at its bottom-right lands under the TILE, not the finger', () => {
  const layout = [{ type: 'widget', key: 'discover', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('widget:discover');
  const info = ghostInfo(el, { left: CELL_W, top: CELL_H, w: 2, h: 2, grabX: 1, grabY: 1 });

  // The finger is two cells right and two rows down of the tile's own corner —
  // which is exactly what the old pointer hit-test answered.
  assert.deepEqual({ ...h.Home._cellFromPoint(info.pointerX, info.pointerY) }, { col: 3, row: 3 });
  assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 5) },
    { col: 1, row: 1 });
});

test('a phone-width widget follows the tile’s row, not the finger’s', () => {
  // 4 columns: Challenges is full-width and one row tall (#968), so only the
  // ROW is a real choice — and dropping a row lower than the tile is the whole
  // bug report. The finger holds the tile's bottom edge, which is inside the
  // row BELOW the one the tile is sitting in.
  const layout = [{ type: 'widget', key: 'challenges', col: 0, row: 1 }];
  const h = makePreview(layout, { cols: 4, width: 390 });
  hitTestCells(h, 4);
  const el = h.dom.nodes.get('widget:challenges');
  const info = ghostInfo(el, { left: 0, top: CELL_H, w: 4, h: 1, grabX: 0.5, grabY: 1 });

  assert.equal(h.Home._cellFromPoint(info.pointerX, info.pointerY).row, 2,
    'the finger is in the tile’s lower row');
  assert.deepEqual({ ...h.Home._targetCellFor(info.pointerX, info.pointerY, info, 4) },
    { col: 0, row: 1 }, 'the block stays where the tile is');
});

test('a tile snaps once it is more than halfway into the next column', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('app:a');
  const at = (left) => h.Home._targetCellFor(0, 0,
    ghostInfo(el, { left, top: 0, w: 1, h: 1 }), 5).col;

  assert.equal(at(CELL_W), 1, 'aligned with column 1');
  assert.equal(at(CELL_W + 40), 1, 'not yet halfway');
  assert.equal(at(CELL_W + 60), 2, 'past halfway — snaps on');
});

test('the target is clamped to the canvas, so the token IS the landing cell', () => {
  const layout = [{ type: 'widget', key: 'discover', col: 2, row: 2 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('widget:discover');

  // A 2x2 tile centred in the very first cell wants a top-left of (-1,-1).
  const corner = ghostInfo(el, { left: -CELL_W / 2, top: -CELL_H / 2, w: 2, h: 2 });
  assert.deepEqual({ ...h.Home._targetCellFor(0, 0, corner, 5) }, { col: 0, row: 0 });

  // ...and one pushed at the last column is nudged in to where it fits, which
  // is the same cell _rectForCell measures, so the glide can't disagree.
  const edge = ghostInfo(el, { left: 3.9 * CELL_W, top: CELL_H, w: 2, h: 2 });
  const cell = h.Home._targetCellFor(0, 0, edge, 5);
  assert.deepEqual({ ...cell }, { col: 3, row: 1 });
  assert.deepEqual({ ...h.Home._rectForCell(el, cell, 5) },
    { left: 3 * CELL_W, top: 1 * CELL_H });
});

test('a tile whose CENTRE leaves the canvas has no target, finger or not', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const el = h.dom.nodes.get('app:a');
  // Dragged up off the grid: the finger is still over a cell (it is holding
  // the tile's bottom edge), the tile is not.
  const info = ghostInfo(el, { left: 0, top: -0.75 * CELL_H, w: 1, h: 1, grabY: 1 });
  assert.deepEqual({ ...h.Home._cellFromPoint(info.pointerX, info.pointerY) }, { col: 0, row: 0 });
  assert.equal(h.Home._targetCellFor(info.pointerX, info.pointerY, info, 5), null);
});

test('no tile geometry (an older kit) falls back to the pointer hit-test', () => {
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  hitTestCells(h);
  const opts = wiredOpts(h);
  h.Home._overlayEl = h.dom.overlay; // _wireCards doesn't touch it; be explicit

  assert.deepEqual({ ...opts.cellFromPoint(250, 250) }, { col: 2, row: 2 },
    'degrades to today’s behaviour rather than breaking the drag');
  assert.deepEqual({ ...opts.cellFromPoint(250, 250, { item: null }) }, { col: 2, row: 2 });
});

test('the wired hover tints the block the TILE covers, and the glide agrees', () => {
  const layout = [
    { type: 'widget', key: 'discover', col: 0, row: 0 },
    { type: 'app', slug: 'a', col: 4, row: 0 },
  ];
  const h = makePreview(layout);
  hitTestCells(h);
  const opts = wiredOpts(h);
  h.Home._overlayEl = h.dom.overlay;
  const el = h.dom.nodes.get('widget:discover');

  // The tile is sitting over cells (2,1)-(3,2), held by its top-left corner.
  const info = ghostInfo(el, { left: 2 * CELL_W, top: CELL_H, w: 2, h: 2 });
  const cell = opts.cellFromPoint(info.pointerX, info.pointerY, info);
  assert.deepEqual({ ...cell }, { col: 2, row: 1 });

  assert.equal(opts.canPlace(el, cell), true);
  opts.onHover(el, cell, true);
  assert.deepEqual(h.tinted().sort(), ['2,1', '2,2', '3,1', '3,2'],
    'exactly the block under the tile');
  assert.deepEqual({ ...opts.rectForCell(el, cell) }, { left: 2 * CELL_W, top: CELL_H });
});

// ── Where the release glide lands ──────────────────────────────────────
//
// The kit settles the ghost on the rect _rectForCell returns. Getting that
// wrong is the bug this suite exists to prevent regressing: a placement drag
// never moves the real item, so if the kit falls back to the item's own rect
// the tile flies from the finger BACK to the cell it was picked up from and
// only then pops into the drop cell — one release, two contradictory motions,
// too fast to read as anything but a glitch.

test('rectForCell settles the ghost on the LANDING cell, not the origin cell', () => {
  const layout = [
    { type: 'app', slug: 'a', col: 0, row: 0 },
    { type: 'app', slug: 'b', col: 2, row: 3 },
  ];
  const h = makePreview(layout);
  const el = h.dom.nodes.get('app:a');

  // Drop 'a' (origin 0,0 → rect 0,0) on cell 3,5.
  assert.deepEqual({ ...h.Home._rectForCell(el, { col: 3, row: 5 }, 5) },
    { left: 3 * CELL_W, top: 5 * CELL_H });
  // Emphatically NOT the origin, which is what item.getBoundingClientRect()
  // would still report mid-drag.
  assert.notDeepEqual({ ...h.Home._rectForCell(el, { col: 3, row: 5 }, 5) }, { left: 0, top: 0 });

  // Dropping where it already is settles in place — a no-op drop must not
  // glide anywhere.
  assert.deepEqual({ ...h.Home._rectForCell(el, { col: 0, row: 0 }, 5) }, { left: 0, top: 0 });
});

test('the settle target is the plan’s cell, so an edge nudge lands where the tint promised', () => {
  // A 2x2 widget hovered at the last column cannot be placed there — the
  // plan nudges it left to fit. The tint shows the nudged footprint, and the
  // glide has to agree with it: settling on the cell under the FINGER would
  // drop the tile a column short of where it visibly lands.
  const layout = [{ type: 'widget', key: 'discover', col: 0, row: 0, w: 2, h: 2 }];
  const h = makePreview(layout);
  const el = h.dom.nodes.get('widget:discover');

  const plan = h.Home._planFor(el, { col: 4, row: 1 }, 5);
  const placed = plan.next.find((i) => h.HomeLayout.idOf(i) === 'widget:discover');
  assert.equal(placed.col, 3, 'a 2-wide widget at col 4 of 5 is nudged to col 3');

  assert.deepEqual({ ...h.Home._rectForCell(el, { col: 4, row: 1 }, 5) },
    { left: 3 * CELL_W, top: 1 * CELL_H }, 'the glide follows the plan, not the pointer');
  // And the tint agrees, which is the whole point of sharing the memo.
  h.Home._previewDrop(el, { col: 4, row: 1 }, true, 5);
  assert.deepEqual(h.tinted().sort(), ['3,1', '3,2', '4,1', '4,2']);
});

test('rectForCell returns null when there is no cell to settle on', () => {
  // Null means "fall back to the item's own rect": a slightly wrong glide is
  // better than reading a rect off nothing, and better than a thrown error
  // mid-release, which would leave the ghost on screen forever.
  const layout = [{ type: 'app', slug: 'a', col: 0, row: 0 }];
  const h = makePreview(layout);
  const el = h.dom.nodes.get('app:a');

  // No overlay at all (a drop resolved after teardown).
  const overlay = h.Home._overlayEl;
  h.Home._overlayEl = null;
  assert.equal(h.Home._rectForCell(el, { col: 1, row: 1 }, 5), null);
  h.Home._overlayEl = overlay;

  // An element that is in no layout has no plan and therefore no landing.
  assert.equal(h.Home._rectForCell({ dataset: {}, _cls: new Set(), classList: { contains: () => false } },
    { col: 1, row: 1 }, 5), null);

  // A landing off the bottom of the canvas has no overlay cell to measure.
  // canPlace refuses those, so this guard is belt-and-braces — stub the plan
  // to reach it.
  const realPlace = h.HomeLayout.place;
  h.HomeLayout.place = () => [{ type: 'app', slug: 'a', col: 0, row: h.HomeLayout.MAX_ROWS }];
  h.Home._planMemo = null;
  assert.equal(h.Home._rectForCell(el, { col: 0, row: 1 }, 5), null);
  h.HomeLayout.place = realPlace;
  h.Home._planMemo = null;
});

test('the host hands rectForCell to the kit, wired to the same memo as the tint', () => {
  const { Home, attachCalls } = makeHome();
  Home._apps = [app('a')];
  Home._wireCards({ querySelectorAll: () => [] }, true, 1);
  const { opts } = attachCalls[0];
  assert.equal(typeof opts.rectForCell, 'function',
    'without this the kit settles on the item’s own rect — the origin cell');

  // It must route through _rectForCell (and so through _planFor's memo)
  // rather than measure something of its own.
  const calls = [];
  const real = Home._rectForCell;
  Home._rectForCell = (...args) => { calls.push(args); return { left: 7, top: 9 }; };
  const el = { dataset: {} };
  assert.deepEqual(opts.rectForCell(el, { col: 2, row: 2 }), { left: 7, top: 9 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], el);
  assert.deepEqual(calls[0][1], { col: 2, row: 2 });
  Home._rectForCell = real;
});

test('the overlay is inset by the grid’s ASYMMETRIC padding', () => {
  // _rectForCell measures overlay cells, so any offset between the overlay
  // and the real grid becomes a jump at the very end of the glide — the one
  // frame the motion is supposed to be seamless. #app-list is
  // `p-2 pt-1.5 sm:p-3 sm:pt-2`: the top is tighter than the sides, and a
  // uniform inset sits the whole overlay 2px (phone) / 4px (desktop) low.
  const CSS = read('public/css/app.css');
  assert.match(read('public/index.html'), /id="app-list"[^>]*class="[^"]*\bp-2 pt-1\.5 sm:p-3 sm:pt-2/,
    'the padding these insets mirror');
  assert.match(CSS, /\.home-grid-overlay \{[^}]*inset: 0\.375rem 0\.5rem 0\.5rem;/);
  assert.match(CSS, /min-width: 640px\)[\s\S]*?\.home-grid-overlay \{[^}]*inset: 0\.5rem 0\.75rem 0\.75rem;/);
});

// ── Live reflow across the 640px boundary ─────────────────────────────
//
// Every item's cell is an INLINE grid-column/grid-row written at render
// time. The CSS switches columns on its own (grid-cols-4 sm:grid-cols-5,
// plus the media-queried --home-cell-h) but those inline placements do
// not: without a resize handler, widening a narrowed desktop window keeps
// the 4-column arrangement inside a 5-column grid — a dead trailing
// column, widgets spanning 4 of 5 — until some unrelated event happens to
// re-render. These pin the handler AND the rule that it never writes.

// A helper: render() needs real DOM, so drive _applyColumnCount with
// render stubbed out and count the re-renders.
function watchRenders(Home) {
  const calls = [];
  Home.render = () => { calls.push(Home.currentCols()); };
  return calls;
}

test('the grid subscribes to BOTH a resize and the 640px media query', () => {
  const h = makeHome({ width: 1280 });
  h.Home._apps = [app('a')];
  h.Home._wireViewport();

  // matchMedia is the precise signal — it fires once, on the crossing.
  assert.equal(h.mediaQueries.length, 1, 'exactly one query, subscribed once');
  assert.equal(h.mediaQueries[0].query, '(min-width: 640px)',
    'the same boundary HomeLayout.columnsForWidth and Tailwind’s sm use');
  assert.ok(h.mediaQueries[0].handlers.length >= 1);

  // resize is the backstop for WebViews without MediaQueryList events.
  const renders = watchRenders(h.Home);
  h.Home._renderedCols = 5;
  h.setWidth(500);
  h.fireResize();
  assert.deepEqual(renders, [], 'debounced — nothing yet');
  return new Promise((resolve) => setTimeout(() => {
    assert.deepEqual(renders, [4], 'and then exactly one re-render, at 4');
    resolve();
  }, h.Home.RESIZE_DEBOUNCE_MS + 60));
});

test('_wireViewport is idempotent — render() calls it on every paint', () => {
  const h = makeHome();
  h.Home._wireViewport();
  h.Home._wireViewport();
  h.Home._wireViewport();
  assert.equal(h.mediaQueries.length, 1,
    're-wiring on every render must not stack listeners');
  // And render() is what arms it, so the very first paint starts watching.
  assert.match(HOME_SRC, /Home\._wireSearch\(\);[\s\S]{0,220}Home\._wireViewport\(\);/,
    'render() arms the viewport watcher alongside the search wiring');
});

test('narrowing a DESKTOP window past 640px re-renders at 4 columns', () => {
  const h = makeHome({ width: 1280 });
  h.Home._apps = [app('a')];
  h.Home._wireViewport();
  h.Home._renderedCols = 5;
  const renders = watchRenders(h.Home);

  h.setWidth(500);
  h.fireMediaChange();
  assert.deepEqual(renders, [4], 'the reflow is live, not next-event');

  // Widening back returns to 5 — the round trip, which is the bug the user
  // actually saw (the 4-column arrangement stranded in a 5-column grid).
  h.Home._renderedCols = 4;
  h.setWidth(1280);
  h.fireMediaChange();
  assert.deepEqual(renders, [4, 5]);

  // The handler itself writes nothing. Persisting here would be the worst
  // version of the bug: carrying a laptop's window across 640px would
  // claim the phone's arrangement without the viewer touching a tile.
  assert.deepEqual(h.fetchCalls.filter((c) => c.method === 'PUT'), []);
});

test('a resize that does NOT change the column count re-renders nothing', () => {
  const h = makeHome({ width: 1280 });
  h.Home._renderedCols = 5;
  const renders = watchRenders(h.Home);
  for (const w of [1100, 900, 700, 641, 2000]) {
    h.setWidth(w);
    h.Home._applyColumnCount();
  }
  assert.deepEqual(renders, [],
    'dragging a window edge must not repaint the grid on every frame');
});

test('a resize during an active SEARCH re-renders nothing', () => {
  const h = makeHome({ width: 1280 });
  h.Home._query = 'chess';
  h.Home._renderedCols = null; // what the search view records
  const renders = watchRenders(h.Home);
  h.setWidth(500);
  h.Home._applyColumnCount();
  assert.deepEqual(renders, [],
    'the search view is a flat list with no placement to go stale');
  // Clearing the query re-reads the live width, because null never matches.
  h.Home._query = '';
  h.Home._applyColumnCount();
  assert.deepEqual(renders, [4]);
});

// THE NO-PERSIST RULE. A width the viewer has never dragged at is a
// DERIVATION — reflowed from the other width, or packed from flow order.
// Persisting it on a resize would let carrying a laptop's window across
// 640px silently claim the phone's arrangement (and vice versa).
test('crossing the breakpoint never persists a layout', async () => {
  const h = makeHome({ width: 1280 });
  h.Home._apps = [app('a'), app('b'), app('c')];
  // The viewer has dragged at 5 columns only. 4 has never been touched.
  h.Home._layouts = {
    '4': [],
    '5': [
      { type: 'app', slug: 'a', col: 4, row: 0 },
      { type: 'app', slug: 'b', col: 0, row: 2 },
      { type: 'app', slug: 'c', col: 2, row: 3 },
      { type: 'widget', key: 'challenges', col: 0, row: 0 },
      { type: 'widget', key: 'discover', col: 2, row: 0 },
      { type: 'widget', key: 'create', col: 4, row: 3 },
    ],
  };
  h.Home._layoutFetchedAt = Date.now();
  h.fetchCalls.length = 0;

  // Narrow: 4 has nothing stored, so this is the reflow derivation.
  h.setWidth(500);
  const at4 = h.Home.currentLayout(4);
  await flush();
  assert.ok(at4.length >= 6, 'everything came across');
  assert.deepEqual(h.fetchCalls.filter((c) => c.method === 'PUT'), [],
    'a DERIVED layout is never written — the viewer must drag at this width first');

  // And it is order-preserving, which is what "conforms on smaller screens
  // like it does today" means: the 5-column arrangement read in reading
  // order puts a on row 0, b on row 2 and c on row 3, and the 4-column
  // derivation keeps them in that relative order.
  const order = [...at4].filter((i) => i.type === 'app').map((i) => i.slug);
  assert.deepEqual(order, ['a', 'b', 'c']);

  // Widen back: 5 IS stored and needs no repair, so still no write, and
  // the stored cells come back exactly.
  h.setWidth(1280);
  const at5 = h.Home.currentLayout(5);
  await flush();
  assert.deepEqual(h.fetchCalls.filter((c) => c.method === 'PUT'), [],
    'returning to a stored width re-reads it, it does not re-save it');
  const a5 = at5.find((i) => i.slug === 'a');
  assert.deepEqual([a5.col, a5.row], [4, 0], 'the hole-bearing arrangement survived the round trip');
});

test('each width keeps its OWN arrangement across a resize', () => {
  const h = makeHome({ width: 1280 });
  h.Home._apps = [app('a'), app('b')];
  // Two arrangements the viewer really made, at the two widths.
  h.Home._layouts = {
    '4': [{ type: 'app', slug: 'a', col: 3, row: 5 }, { type: 'app', slug: 'b', col: 0, row: 0 },
      { type: 'widget', key: 'challenges', col: 0, row: 1 },
      { type: 'widget', key: 'discover', col: 0, row: 3 },
      // Full-width at four columns, so column 0 and a row of its own.
      { type: 'widget', key: 'create', col: 0, row: 6 }],
    '5': [{ type: 'app', slug: 'a', col: 0, row: 0 }, { type: 'app', slug: 'b', col: 4, row: 4 },
      { type: 'widget', key: 'challenges', col: 1, row: 0 },
      { type: 'widget', key: 'discover', col: 3, row: 0 },
      { type: 'widget', key: 'create', col: 0, row: 1 }],
  };
  h.Home._layoutFetchedAt = Date.now();

  const cellOf = (layout, slug) => {
    const i = layout.find((x) => x.slug === slug);
    return [i.col, i.row];
  };
  assert.deepEqual(cellOf(h.Home.currentLayout(5), 'a'), [0, 0]);
  h.setWidth(500);
  assert.deepEqual(cellOf(h.Home.currentLayout(4), 'a'), [3, 5],
    'the phone shows the phone arrangement, not a reflow of the desktop one');
  h.setWidth(1280);
  assert.deepEqual(cellOf(h.Home.currentLayout(5), 'a'), [0, 0],
    'and the desktop one is untouched by the visit');
});

// A breakpoint crossing MID-GESTURE. The recognizer captured the old column
// count when it was attached and the overlay was built with the old number
// of cells, while the CSS grid underneath has already switched — the tint,
// the hit-test and the drop would all describe a grid that is no longer on
// screen. detach() is the kit's clean abort (ghost removed, dashed slot
// released, hover cleared, onSettle(false) fired).
test('a breakpoint crossing mid-drag aborts the gesture, then re-renders', () => {
  const h = makeHome({ width: 1280 });
  h.Home._wireViewport();
  const detaches = [];
  h.Home._renderedCols = 5;
  h.Home._dragActive = true;
  h.Home._placementHandle = {
    detach: () => { detaches.push('detached'); h.Home._dragActive = false; },
  };
  const renders = watchRenders(h.Home);

  h.setWidth(500);
  h.fireMediaChange();

  assert.deepEqual(detaches, ['detached'], 'the lift is cancelled, not left dangling');
  assert.equal(h.Home._dragActive, false, 'so the re-render is not swallowed by the drag guard');
  assert.equal(h.Home._placementHandle, null, 'and _wireCards re-attaches at the new count');
  assert.deepEqual(renders, [4]);
});

test('the abort happens BEFORE the re-render, or the repaint is swallowed', () => {
  // render() defers while _dragActive holds (it sets _reloadPending and
  // returns), so a re-render ordered ahead of the detach would be dropped
  // and the grid would stay in the old column count anyway.
  const src = HOME_SRC.slice(HOME_SRC.indexOf('  _applyColumnCount() {'));
  const body = src.slice(0, src.indexOf('\n  },'));
  const detachAt = body.indexOf('_placementHandle.detach()');
  const renderAt = body.indexOf('Home.render()');
  assert.ok(detachAt > -1 && renderAt > -1);
  assert.ok(detachAt < renderAt, 'detach must precede render');
  assert.match(body, /Home\._dragActive && Home\._placementHandle/,
    'and only when a gesture is actually in flight');
});

test('render() records the column count the DOM now holds', () => {
  // _applyColumnCount diffs the live viewport against this. If render()
  // stopped writing it the handler would either fire on every resize or
  // never fire at all, depending on which way it went stale.
  assert.match(HOME_SRC, /Home\._renderedCols = cols;/,
    'the grid view records what it painted');
  assert.match(HOME_SRC, /Home\._renderedCols = null;/,
    'and the search view records "no placement"');
  assert.match(HOME_SRC, /if \(cols === Home\._renderedCols\) return;/,
    'the handler is a no-op unless the count actually moved');
});

test('the row-height token switches at the SAME 640px boundary', () => {
  // The overlay measures cells and the tiles sit in them, so the cell
  // height has to flip in step with the column count — a media query at a
  // different boundary would leave one of them briefly wrong.
  const CSS = read('public/css/app.css');
  assert.match(CSS, /--home-cell-h: 7\.75rem;/, 'the desktop row height is a token');
  // The phone override and the overlay's phone gap share one block, keyed
  // to the same boundary (639.98 is the standard non-overlapping spelling
  // of "below 640"). Sliced to that block rather than matched within a
  // character window of its opening brace: the window made the assertion a
  // function of how much PROSE the block carries, so a comment growing by a
  // line failed a test about geometry.
  const at = CSS.indexOf('@media (max-width: 639.98px)');
  assert.ok(at > -1, 'the phone block exists');
  const end = CSS.indexOf('@media (min-width: 640px)', at);
  const phoneBlock = CSS.slice(at, end > -1 ? end : CSS.length);
  assert.match(phoneBlock, /--home-cell-h: 7\.25rem;/,
    'the row height flips at 640px, the same boundary as grid-cols-4 sm:grid-cols-5');
  assert.match(phoneBlock, /\.home-grid-overlay \{ gap: 0\.375rem; \}/,
    'and the drag overlay flips with it, so its cells stay aligned to the tiles');
  assert.equal(HomeLayoutBreakpoint(), 640,
    'and the JS agrees, or it lays out against a count the CSS is not rendering');
});

function HomeLayoutBreakpoint() {
  const m = LAYOUT_SRC.match(/BREAKPOINT_PX:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── The staging demo tiles are placed, not dropped ────────────────────
//
// GET /api/apps?demo=1 injects two read-only demo tiles, and the ?demo=1
// layout places them on the grid on purpose — that route exists so a
// reviewer signed in as ANY cloned identity sees the feature. But they are
// neither favourited nor collaborations, so partitionApps rightly leaves
// them out of "Your apps", and repair() drops whatever presentIds() does
// not list. The demo route's whole subject was being deleted from it before
// the first paint: a reviewer with no apps of their own got three widgets
// on an otherwise bare grid, and every dapp.json check that selects an app
// tile at ?demo=1 failed on a screen that looked deliberate.
//
// The spec's rule is that [data-demo] tiles are "excluded from the drag but
// placed by the layout like anything else" — the recognizer's own
// `:not([data-demo])` selector is what excludes them, not their absence.

test('demo tiles count as present, so repair() keeps them on the grid', () => {
  const { Home } = makeHome();
  Home._apps = [
    app('mine', { is_favorited: true }),
    { ...app('demo-emoji'), demo: true, is_collaborator: false },
    { ...app('demo-image'), demo: true, is_collaborator: false },
  ];
  const ids = Home.presentIds();
  assert.ok(ids.includes('app:mine'));
  assert.ok(ids.includes('app:demo-emoji'), 'a demo tile is present');
  assert.ok(ids.includes('app:demo-image'));
  // Listed exactly once — a demo tile that were ALSO yours must not appear
  // twice, or repair() would try to place the same item two ways.
  assert.equal(ids.filter((i) => i === 'app:demo-emoji').length, 1);
});

test('a demo tile that IS yours is listed once, not twice', () => {
  const { Home } = makeHome();
  Home._apps = [{ ...app('both', { is_favorited: true }), demo: true }];
  const ids = Home.presentIds().filter((i) => i === 'app:both');
  assert.deepEqual([...ids], ['app:both']);
});

test('the demo layout survives repair for a viewer with no apps of their own', () => {
  const { Home, HomeLayout } = makeHome();
  // Exactly the ?demo=1 shape: two demo tiles and the widgets, nothing the
  // viewer owns.
  Home._apps = [
    { ...app('staging-demo-emoji-icon'), demo: true, is_collaborator: false },
    { ...app('staging-demo-image-icon'), demo: true, is_collaborator: false },
  ];
  Home._layouts = {
    4: [
      { type: 'app', slug: 'staging-demo-emoji-icon', col: 0, row: 0 },
      { type: 'app', slug: 'staging-demo-image-icon', col: 3, row: 0 },
      { type: 'widget', key: 'discover', col: 0, row: 1 },
      { type: 'widget', key: 'challenges', col: 0, row: 4 },
      { type: 'widget', key: 'create', col: 0, row: 6 },
    ],
    5: [],
  };
  Home._layoutFetchedAt = Date.now();
  Home._layoutIsDemo = true;

  const layout = Home.currentLayout(4);
  const ids = layout.map((i) => HomeLayout.idOf(i));
  assert.ok(ids.includes('app:staging-demo-emoji-icon'),
    'the demo route still shows the tiles it exists to show');
  assert.ok(ids.includes('app:staging-demo-image-icon'));
  assert.equal(layout.filter((i) => i.type === 'app').length, 2);
});

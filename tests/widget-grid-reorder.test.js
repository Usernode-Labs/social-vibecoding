// Issue #770: the "Usernode widget" tile strip's kit drag uses the
// grid (displacement) mode, matching the app-card grid from #753.
// These tests pin the attachReorder options _wireWidgetStrip passes —
// grid: true + itemSelector — and the callback contracts: onLift /
// onSettle hold Home._dragActive (and onSettle flushes a deferred
// reload/re-render), and onReorder persists the strip's DOM order via
// the bridge's reorderHomeScreenShortcuts.
//
// home.js declares `const Home = {…}` at top level; we load it into a vm
// context with stubbed globals and call _wireWidgetStrip directly with fake
// DOM nodes — same harness as home-drag-add.test.js. Its source comes from
// ./helpers/home-modules, which resolves the module's post-#1083 location and
// strips the one `import` line a vm context cannot parse.
//
// Run with: node --test tests/widget-grid-reorder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC } = require('./helpers/home-modules');

// Returns { Home, attachCalls, reorderCalls, toasts }. attachCalls
// records every unNative.attachReorder invocation ({ listEl, opts });
// reorderCalls the id arrays sent to the bridge's
// reorderHomeScreenShortcuts stub.
function makeHome() {
  const attachCalls = [];
  const reorderCalls = [];
  const toasts = [];
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    PlatformUI: { toast: (msg) => { toasts.push(String(msg)); } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    unNative: {
      attachReorder: (listEl, opts) => {
        attachCalls.push({ listEl, opts });
        return { detach: () => {} };
      },
    },
    usernode: {
      reorderHomeScreenShortcuts: async (ids) => { reorderCalls.push(ids); },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, attachCalls, reorderCalls, toasts };
}

const flush = () => new Promise((r) => setImmediate(r));

// Minimal fake DOM for _wireWidgetStrip: a listEl whose only queryable
// child is the strip, and a strip holding widget tiles (dataset.wid).
function makeStrip(ids) {
  const tiles = ids.map((id) => ({ dataset: { wid: id } }));
  const strip = {
    tiles,
    querySelectorAll: (sel) => (sel === '.widget-tile' ? strip.tiles : []),
  };
  const listEl = {
    querySelector: (sel) => (sel === '#widget-strip' ? strip : null),
  };
  return { listEl, strip };
}

function wire(ids = ['a', 'b', 'c']) {
  const env = makeHome();
  const { listEl, strip } = makeStrip(ids);
  env.Home._wireWidgetStrip(listEl);
  assert.equal(env.attachCalls.length, 1, 'attachReorder wired once');
  return { ...env, strip, opts: env.attachCalls[0].opts, attachedTo: env.attachCalls[0].listEl };
}

// ── attachReorder options ─────────────────────────────────────────

test('widget strip attaches kit reorder in grid mode on the strip', () => {
  const { opts, attachedTo, strip } = wire();
  assert.equal(attachedTo, strip, 'attached to the strip element');
  assert.equal(opts.grid, true, 'grid (displacement) mode is on');
  assert.equal(opts.itemSelector, '.widget-tile');
  assert.equal(typeof opts.onLift, 'function');
  assert.equal(typeof opts.onSettle, 'function');
  assert.equal(typeof opts.onReorder, 'function');
});

// ── onLift / onSettle hold _dragActive ────────────────────────────

test('onLift sets _dragActive; onSettle clears it', () => {
  const { Home, opts } = wire();
  assert.equal(Home._dragActive, false);
  opts.onLift();
  assert.equal(Home._dragActive, true, 'lift holds the drag guard');
  opts.onSettle(false);
  assert.equal(Home._dragActive, false, 'settle releases it');
});

test('onSettle flushes a deferred reload into Home.load()', () => {
  const { Home, opts } = wire();
  let loads = 0;
  Home.load = () => { loads += 1; };
  opts.onLift();
  Home._reloadPending = true; // a WS update arrived mid-drag
  opts.onSettle(true);
  assert.equal(loads, 1, 'deferred reload runs at settle');
  assert.equal(Home._reloadPending, false);
  assert.equal(Home._dragActive, false);
});

test('onSettle flushes a deferred re-render when no reload is pending', () => {
  const { Home, opts } = wire();
  let renders = 0;
  Home.render = () => { renders += 1; };
  opts.onLift();
  Home._rerenderPending = true;
  opts.onSettle(false);
  assert.equal(renders, 1, 'deferred re-render runs at settle');
  assert.equal(Home._rerenderPending, false);
});

// ── onReorder persists the strip's DOM order ──────────────────────

test('onReorder saves the tile order the strip currently shows', async () => {
  const { Home, opts, strip, reorderCalls } = wire(['a', 'b', 'c']);
  Home._widgetItems = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];
  // Simulate the kit's live DOM move (b dragged to the front) — the
  // kit fires onReorder AFTER the element has moved.
  strip.tiles = [
    { dataset: { wid: 'b' } },
    { dataset: { wid: 'a' } },
    { dataset: { wid: 'c' } },
  ];
  opts.onReorder(1, 0, strip.tiles[0]);
  await flush();
  // Spread into host-realm arrays: the ids array is built inside the vm
  // context, whose Array.prototype fails deepStrictEqual across realms.
  assert.equal(reorderCalls.length, 1, 'one bridge reorder call');
  assert.deepEqual([...reorderCalls[0]], ['b', 'a', 'c'], 'bridge got the DOM order');
  assert.deepEqual(
    [...Home._widgetItems].map((it) => it.id),
    ['b', 'a', 'c'],
    'optimistic mirror matches'
  );
});

// ── The URL migration pass (#1489) ──────────────────────────────────────
//
// A bridge re-add is an in-place refresh KEYED ON URL (NATIVE-BRIDGE.md), so
// a pinned entry cannot be moved to a new address by re-adding it: that
// creates a second entry and leaves the first one pinned. The migration is
// therefore four calls in a fixed order, and the order is the contract these
// tests pin.

// A Home wired to a fake widget registry. `calls` records the bridge
// sequence; `registry` is the mutable list the stubs read and write.
function makeUrlHealHome({ items, failRemove = false }) {
  const calls = [];
  let registry = items.slice();
  let nextId = 900;
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    PlatformUI: { toast: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams,
    location: { origin: 'https://sv.example', search: '' },
    localStorage: {
      _d: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    unNative: { attachReorder: () => ({ detach: () => {} }) },
    usernode: {
      addHomeScreenShortcut: async (payload) => {
        calls.push({ m: 'add', url: payload.url });
        registry = registry.concat([{ id: `new-${nextId++}`, name: payload.name, url: payload.url }]);
      },
      getHomeScreenShortcuts: async () => {
        calls.push({ m: 'get' });
        return { items: registry.slice() };
      },
      removeHomeScreenShortcut: async (id) => {
        calls.push({ m: 'remove', id });
        if (failRemove) throw new Error('denied');
        registry = registry.filter((it) => it.id !== id);
      },
      reorderHomeScreenShortcuts: async (ids) => { calls.push({ m: 'reorder', ids }); },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  Home._shortcutSupport = { mechanism: 'widget' };
  Home._widgetItems = registry.slice();
  Home._apps = [
    { slug: 'weather', name: 'Weather', icon_emoji: '🌤' },
    { slug: 'ledger', name: 'Ledger', icon_emoji: '📒' },
  ];
  Home._iconTileDataUrl = () => 'data:image/png;base64,AA==';
  Home._ensureDarkIconCapability = async () => null;
  return { Home, calls, current: () => registry };
}

test('one pass migrates ONE stale pin: add, read back, remove, reorder (#1489)', async () => {
  const { Home, calls } = makeUrlHealHome({
    items: [
      { id: 'a', name: 'Weather', url: 'https://sv.example/app/weather' },
      { id: 'b', name: 'Ledger', url: 'https://sv.example/app/ledger' },
    ],
  });
  await Home._healWidgetUrls();
  assert.deepEqual(calls.map((c) => c.m), ['add', 'get', 'remove', 'reorder', 'get'],
    'add BEFORE remove, with a read-back in between to learn the new id');
  assert.equal(calls[0].url, 'https://sv.example/app/weather/full');
  assert.equal(calls[2].id, 'a', 'the stale entry is the one removed');
  const reorder = calls.find((c) => c.m === 'reorder');
  assert.equal(reorder.ids.length, 2);
  assert.ok(reorder.ids[0].startsWith('new-'),
    'the replacement is put back at the original entry’s index, not appended');
  assert.equal(reorder.ids[1], 'b', 'the untouched pin keeps its place');
  assert.match(Home._urlHealOutcome, /^migrated weather$/);
  // ONE per pass: the second stale entry is still stale afterwards, because
  // add-before-remove puts the registry transiently over the widget's
  // eight-tile capacity and two at once would hide a tile.
  assert.ok(Home._widgetItems.some((it) => it.url === 'https://sv.example/app/ledger'));
});

test('a pass with nothing stale left touches the bridge not at all (#1489)', async () => {
  const { Home, calls } = makeUrlHealHome({
    items: [{ id: 'a', name: 'Weather', url: 'https://sv.example/app/weather/full' }],
  });
  await Home._healWidgetUrls();
  assert.deepEqual(calls, []);
  assert.equal(Home._urlHealOutcome, 'nothing to migrate');
});

test('a rejected remove leaves the duplicate rather than losing the pin (#1489)', async () => {
  const { Home, calls } = makeUrlHealHome({
    items: [{ id: 'a', name: 'Weather', url: 'https://sv.example/app/weather' }],
    failRemove: true,
  });
  await Home._healWidgetUrls();
  assert.deepEqual(calls.map((c) => c.m), ['add', 'get', 'remove']);
  assert.match(Home._urlHealOutcome, /^failed on weather: /);
  // Both entries are present: the user sees two tiles for one app, which the
  // next pass heals. The alternative ordering would have lost the pin.
  assert.equal(Home._widgetItems.length, 2);
  assert.ok(Home._widgetItems.some((it) => it.url === 'https://sv.example/app/weather'));
  assert.ok(Home._widgetItems.some((it) => it.url === 'https://sv.example/app/weather/full'));
});

test('a foreign pin is never migrated, and an app that has not loaded is left un-tried (#1489)', async () => {
  const { Home, calls } = makeUrlHealHome({
    items: [
      { id: 'f', name: 'Other', url: 'https://elsewhere.example/app/other' },
      { id: 'g', name: 'Gone', url: 'https://sv.example/app/gone' },
    ],
  });
  await Home._healWidgetUrls();
  assert.deepEqual(calls, [], 'nothing to do: one foreign, one app not in the list');
  assert.ok(!Home._urlHealTried.has('g'),
    'an app that has not loaded yet stays a candidate for a later pass');
});

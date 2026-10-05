// "Sort A–Z" on Home's Shortcuts heading (#3750).
//
// What is pinned here:
//
//   1. HomeLayout.sortByName keeps the CELLS (holes and overflow included)
//      and only changes which app sits in each — case-insensitive, numeric,
//      slug as the tie-break — and isSortedByName agrees with it.
//   2. Home.render() publishes `sortable` on the chrome store: true only with
//      two or more tiles out of name order, never in the search view.
//   3. Home.sortShortcutsAZ() commits like a drop: the sorted arrangement
//      becomes this width's stored layout, is PUT to /api/home-layout, and is
//      not written for the staging demo fixture.
//   4. The button: absent while the flag is false (the prerendered heading is
//      the bare label), and pressing it calls the controller.
//
// Run with: node --test tests/home-sort-shortcuts.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SORT = 'frontend/src/features/home/sort-shortcuts.tsx';
const INDEX = 'frontend/src/features/home/index.tsx';

const HomeLayout = new Function(`${LAYOUT_SRC}\n;return HomeLayout;`)();

// ── 1. the model ──────────────────────────────────────────────────────

const names = { b: 'banana', a: 'Apple', c: 'cherry', d: 'App 10', e: 'App 2' };
const nameOf = (slug) => names[slug];
const at = (slug, col, row) => ({ type: 'app', slug, col, row });

test('sortByName hands the same cells out in name order, holes kept', () => {
  // Row 1 left empty on purpose: two groups of tiles.
  const layout = [at('c', 0, 0), at('b', 1, 0), at('a', 0, 2)];
  const sorted = HomeLayout.sortByName(layout, nameOf);
  assert.deepEqual(sorted, [at('a', 0, 0), at('b', 1, 0), at('c', 0, 2)]);
  assert.equal(HomeLayout.isSortedByName(layout, nameOf), false);
  assert.equal(HomeLayout.isSortedByName(sorted, nameOf), true);
});

test('sortByName is case-insensitive, numeric, and falls back to the slug', () => {
  const layout = [at('d', 0, 0), at('c', 1, 0), at('e', 2, 0), at('zz', 3, 0), at('a', 0, 1)];
  const order = HomeLayout.sortByName(layout, nameOf).map((it) => it.slug);
  // "App 2" < "App 10" < "Apple" (numeric), "cherry" after them; "zz" has no
  // name and sorts by its slug.
  assert.deepEqual(order, ['e', 'd', 'a', 'c', 'zz']);
});

test('overflow tiles keep the end of the alphabet and their overflow row', () => {
  const R = HomeLayout.MAX_ROWS;
  const layout = [at('a', 0, R), at('c', 0, 0), at('b', 1, 0)];
  const sorted = HomeLayout.sortByName(layout, nameOf);
  assert.deepEqual(sorted, [at('a', 0, 0), at('b', 1, 0), at('c', 0, R)]);
});

// ── 2-3. Home, in a vm ────────────────────────────────────────────────

function makeHome() {
  const puts = [];
  const sandbox = {
    console,
    App: { user: { id: 1 }, _isScreenVisible: () => true },
    PlatformUI: { toast: () => {} },
    HomeLayout: null,
    document: {
      createElement: () => ({ style: {}, textContent: '', innerHTML: '' }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      if (opts && opts.method === 'PUT') puts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    },
    location: { search: '', origin: 'https://sv.test' },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n;globalThis.HomeLayout = HomeLayout;`, sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.HomePanels = HomePanels;`, sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, chromeStore: sandbox.chromeStore, puts };
}

const app = (slug, name) => ({
  slug, name, status: 'running', created_by: 1, is_collaborator: true,
  icon_emoji: null, icon_url: null,
});

const slugsInOrder = (layout) => HomeLayout.readingOrder(
  JSON.parse(JSON.stringify(layout)),
).map((it) => it.slug);

test('render offers the sort only for two or more tiles out of name order', () => {
  const { Home, chromeStore } = makeHome();
  Home._apps = [app('one', 'Zebra')];
  Home.render();
  assert.equal(chromeStore.get().sortable, false, 'one tile: nothing to sort');

  Home._apps = [app('z', 'zebra'), app('a', 'Aardvark')];
  Home.render();
  assert.equal(chromeStore.get().sortable, true, 'two tiles out of order');

  Home._query = 'zeb';
  Home.render();
  assert.equal(chromeStore.get().sortable, false, 'never in the search view');
});

test('sortShortcutsAZ stores and saves the sorted arrangement, then stops offering it', async () => {
  const { Home, chromeStore, puts } = makeHome();
  Home._apps = [app('c', 'cherry'), app('a', 'Apple'), app('b', 'banana')];
  Home.render();
  assert.equal(chromeStore.get().sortable, true);

  Home.sortShortcutsAZ();
  await new Promise((r) => setImmediate(r));
  const cols = Home.currentCols();
  assert.deepEqual(slugsInOrder(Home._layouts[String(cols)]), ['a', 'b', 'c']);
  assert.deepEqual(slugsInOrder(Home._layoutCache), ['a', 'b', 'c'], 'what the drag reads');
  assert.equal(puts.length, 1, 'one PUT, through the same path a drop takes');
  assert.equal(puts[0].url, '/api/home-layout');
  assert.equal(puts[0].body.cols, cols);
  assert.deepEqual(puts[0].body.items.map((it) => it.slug), ['a', 'b', 'c']);
  assert.equal(chromeStore.get().sortable, false, 'already sorted: the action steps aside');

  // A second press would move nothing, and writes nothing.
  Home.sortShortcutsAZ();
  await new Promise((r) => setImmediate(r));
  assert.equal(puts.length, 1);
});

test('the staging demo fixture repaints sorted but is never written back', async () => {
  const { Home, puts } = makeHome();
  Home._apps = [app('b', 'banana'), app('a', 'Apple')];
  Home._layoutIsDemo = true;
  Home.render();
  Home.sortShortcutsAZ();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(slugsInOrder(Home._layoutCache), ['a', 'b']);
  assert.equal(puts.length, 0);
});

// ── 4. the button ─────────────────────────────────────────────────────

test('the button draws nothing until there is something to sort', () => {
  const { SortShortcutsBody } = loadTsx(SORT);
  assert.equal(renderToHtml(createElement(SortShortcutsBody, { sortable: false })), '');
  const html = renderToHtml(createElement(SortShortcutsBody, { sortable: true }));
  assert.match(html, /id="home-shortcuts-sort-btn"/);
  assert.match(html, />Sort A–Z<\/button>/);
  // And it is the Shortcuts heading's action.
  assert.match(read(INDEX), /<SectionHeading action=\{<SortShortcuts \/>\}>Shortcuts<\/SectionHeading>/);
});

test('pressing it calls Home.sortShortcutsAZ', () => {
  const { SortShortcutsBody } = loadTsx(SORT);
  let calls = 0;
  const prev = global.window;
  global.window = { Home: { sortShortcutsAZ() { calls += 1; } } };
  try {
    const el = SortShortcutsBody({ sortable: true });
    el.props.onClick({ stopPropagation() {} });
  } finally {
    if (prev === undefined) delete global.window; else global.window = prev;
  }
  assert.equal(calls, 1);
});

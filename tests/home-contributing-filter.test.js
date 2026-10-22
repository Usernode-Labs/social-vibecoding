'use strict';

// ALL / CONTRIBUTING (#5823): the two chips beside Home's "My apps" heading.
//
// Contributing narrows the launcher to the apps the viewer helps build — the
// same three-source set the Contributors list counts, which the server sends
// as `is_contributor` per row. What this file pins is the STATE side in the
// real Home module (the vm harness of tests/home-edit-mode.test.js):
//
//   * All is the default, and its paint is today's;
//   * Contributing paints only contributing apps, PACKED in reading order —
//     and never touches the saved arrangement or PUT /api/home-layout;
//   * the expander counts the filtered set;
//   * the chips hide while searching and while arranging, and when My apps
//     holds only one kind of app;
//   * an empty Contributing view says so;
//   * the choice survives load() (a visit), which is the promise the spec
//     makes — Home does not remember it across reloads.
//
// Run with: node --test tests/home-contributing-filter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { englishPlatformI18n } = require('./lib/platform-i18n');

// A Home in a vm sandbox, with every fetch recorded so "nothing is
// persisted" can be asserted rather than inferred.
function makeHome() {
  const fetches = [];
  const sandbox = {
    console,
    App: { user: { id: 1, canCreateApps: true }, _isScreenVisible: () => true },
    PlatformUI: { toast: () => {} },
    document: {
      createElement: () => ({ style: {}, textContent: '', innerHTML: '' }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      fetches.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      return { ok: true, json: async () => ({ apps: [] }) };
    },
    location: { search: '', hash: '' },
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
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  installAppCard(sandbox);
  const gridStore = installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n;globalThis.HomeLayout = HomeLayout;`, sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.HomePanels = HomePanels;`, sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const model = () => JSON.parse(JSON.stringify(gridStore.get()));
  const moreCount = () => sandbox.chromeStore.get().moreCount;
  return { Home: sandbox.__Home, model, moreCount, sandbox, fetches };
}

// The viewer's own apps (favourites are what make an app "yours"), in the
// order Home.partitionApps keeps them.
const mine = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  slug: `app-${i}`, name: `App ${i}`, status: 'running',
  is_favorited: true, favorite_order: i, is_collaborator: false,
  is_contributor: false,
  ...extra,
}));

const marked = (n, contributors) => Array.from({ length: n }, (_, i) => ({
  slug: `app-${i}`, name: `App ${i}`, status: 'running',
  is_favorited: true, favorite_order: i, is_collaborator: false,
  is_contributor: contributors.includes(i),
}));

const cell = (item) => (item.placement ? [item.placement.col, item.placement.row] : null);

test('All is the default, and its paint is the grid as it was', () => {
  const { Home, model } = makeHome();
  Home._apps = marked(2, [0]);
  Home.render();
  const state = model();
  assert.equal(state.filter, 'all');
  assert.equal(state.filtered, false);
  assert.equal(state.filterEmpty, false);
  assert.equal(state.filterable, true, 'My apps holds both kinds, so the chips are worth showing');
  assert.equal(state.items.length, 2, 'every app is on the grid');
  assert.equal(state.items[0].app.slug, 'app-0');
});

test('Contributing paints only contributing apps, packed in reading order', () => {
  const { Home, model } = makeHome();
  Home._apps = marked(3, [1, 2]);
  // A real arrangement with the app the viewer does not build FIRST and a
  // hole in the middle. Contributing must drop it and pack the other two.
  Home._layouts = { 4: [
    { type: 'app', slug: 'app-0', col: 0, row: 0 },
    { type: 'app', slug: 'app-1', col: 2, row: 1 },
    { type: 'app', slug: 'app-2', col: 3, row: 1 },
  ] };
  Home.render();
  Home.setAppsFilter('contributing');
  const state = model();
  assert.equal(state.filter, 'contributing');
  assert.equal(state.filtered, true);
  assert.equal(state.filterEmpty, false);
  assert.deepEqual(state.items.map((it) => it.app.slug), ['app-1', 'app-2']);
  assert.deepEqual(state.items.map(cell), [[0, 0], [1, 0]], 'no holes in the filtered view');
});

test('the filtered view leaves the saved arrangement alone and persists nothing', () => {
  const { Home, model, fetches } = makeHome();
  Home._apps = marked(3, [0, 2]);
  Home._layouts = { 4: [
    { type: 'app', slug: 'app-0', col: 0, row: 0 },
    { type: 'app', slug: 'app-1', col: 3, row: 0 },
    { type: 'app', slug: 'app-2', col: 0, row: 2 },
  ] };
  Home.render();
  const layoutsBefore = JSON.parse(JSON.stringify(Home._layouts));
  const cacheBefore = JSON.parse(JSON.stringify(Home._layoutCache));
  const callsBefore = fetches.length;

  Home.setAppsFilter('contributing');
  assert.equal(model().filtered, true);
  assert.deepEqual(Home._layouts, layoutsBefore, 'the stored arrangement is untouched');
  assert.deepEqual(JSON.parse(JSON.stringify(Home._layoutCache)), cacheBefore, 'the drag cache still describes the real arrangement');
  const writes = fetches.slice(callsBefore).filter((f) => f.method === 'PUT');
  assert.deepEqual(writes, [], 'no PUT /api/home-layout from a filtered paint');

  Home.setAppsFilter('all');
  assert.equal(model().filtered, false);
  assert.deepEqual(model().items.map(cell), [[0, 0], [3, 0], [0, 2]],
    'All brings back the arrangement exactly as it was');
});

test('the expander counts the apps in Contributing, not the whole shelf', () => {
  const { Home, model, moreCount } = makeHome();
  // Nine contributors among twelve apps, on a budget of one row: two rows
  // show (DEFAULT_ROWS is the floor), so the ninth is behind the expander.
  Home._apps = marked(12, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  Home.visibleRowBudget = () => 1;
  Home.setAppsFilter('contributing');
  assert.equal(model().items.length, 8);
  assert.equal(moreCount(), 9, 'the filtered count, not 12');
});

test('the chips hide while searching and while arranging, and when My apps holds one kind', () => {
  const { Home, model } = makeHome();
  Home._apps = marked(3, [0]);
  Home.render();
  assert.equal(model().filterable, true, 'mixed kinds');

  Home._query = 'App 1';
  Home.render();
  assert.equal(model().view, 'search');
  assert.equal(model().filterable, false, 'a search always covers all of My apps');

  Home._query = '';
  Home._editing = true;
  Home.render();
  assert.equal(model().filterable, false, 'arranging shows the real arrangement');

  Home._editing = false;
  Home._apps = marked(3, [0, 1, 2]);
  Home.render();
  assert.equal(model().filterable, false, 'nothing to narrow when every app is one you build');

  Home._apps = marked(3, []);
  Home.render();
  assert.equal(model().filterable, false, 'and nothing to narrow when you build none of them');
});

test('an empty Contributing view says so, keeps the chips, and flows the Create tile', () => {
  const { Home, model } = makeHome();
  Home._apps = marked(3, []);
  Home.render();
  Home.setAppsFilter('contributing');
  const state = model();
  assert.equal(state.filtered, true);
  assert.equal(state.filterEmpty, true, 'the grid owes the viewer a line and a way back');
  assert.equal(state.items.length, 0);
  assert.equal(state.filterable, true, 'the chips stay so All is one tap away');
  assert.equal(state.create.placement, null, 'the Create tile flows after the note');
});

test('the choice survives load(), so moving between tabs keeps it', async () => {
  const { Home, model } = makeHome();
  Home._apps = marked(3, [0]);
  Home.render();
  Home.setAppsFilter('contributing');
  await Home.load();
  assert.equal(Home._appsFilter, 'contributing', 'load() does not reset the choice');
  assert.equal(model().filter, 'contributing');
});

test('setAppsFilter repaints only when the choice actually changes', () => {
  const { Home } = makeHome();
  Home._apps = marked(2, [0]);
  Home.render();
  let paints = 0;
  const render = Home.render;
  Home.render = () => { paints += 1; return render.call(Home); };
  Home.setAppsFilter('contributing');
  assert.equal(paints, 1);
  Home.setAppsFilter('contributing');
  assert.equal(paints, 1, 'same choice, no repaint');
  Home.setAppsFilter('all');
  assert.equal(paints, 2);
});

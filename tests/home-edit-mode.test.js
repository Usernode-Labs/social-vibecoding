'use strict';

// EDIT MODE (#4669): long-pressing a tile of your own on Home puts the My
// apps grid into edit mode — the tiles wiggle, each one grows a remove
// button, and "Done" beside the heading ends it, with "Add apps" beside it
// opening the sheet of apps that are not on the shelf. The trailing Create
// tile keeps its place and its whole at-rest identity. This pins the STATE
// side of that in the real Home module (the same vm harness
// tests/home-create-tile.test.js uses), because the markup side is only half
// the feature: the decision of when the grid is editable, what a remove
// button does, and what ends the state.
//
// Run with: node --test tests/home-edit-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// A Home in a vm sandbox — the shape home-create-tile.test.js established.
// `fetch` answers an empty catalog, so load() settles and render() runs.
function makeHome() {
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
    fetch: async () => ({ ok: true, json: async () => ({ apps: [] }) }),
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
  return { Home: sandbox.__Home, model, moreCount, sandbox };
}

const mine = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  slug: `app-${i}`, name: `App ${i}`, status: 'running',
  is_favorited: true, favorite_order: i, is_collaborator: false,
  ...extra,
}));

// ── the state ─────────────────────────────────────────────────────────

test('setEditing(true) pushes editing to the grid store; false takes it back', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(2);
  Home.render();
  assert.equal(model().editing, false, 'off before anything is held');
  Home.setEditing(true);
  assert.equal(model().editing, true);
  Home.setEditing(false);
  assert.equal(model().editing, false);
  // A second call with the same value is a no-op — no repaint for nothing.
  const paintCalls = [];
  const render = Home.render;
  Home.render = () => { paintCalls.push(1); return render.call(Home); };
  Home.setEditing(false);
  assert.equal(paintCalls.length, 0, 'no render when the flag does not change');
});

test('a render never publishes editing in the search view', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(3);
  Home._editing = true;
  Home._query = 'App 1';
  Home.render();
  assert.equal(model().view, 'search');
  assert.equal(model().editing, false, 'a search is a transient list, not the shelf');
});

test('while editing the grid shows EVERY tile and no expander', () => {
  const { Home, model, moreCount } = makeHome();
  // Rows 0-2 full and one app on row 3, on a budget of three rows: the
  // resting grid holds row 3 back with "Show all 11 apps".
  Home._apps = mine(11);
  Home._layouts = { 4: [
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'app', slug: `app-${i}`, col: i % 4, row: Math.floor(i / 4) })),
    { type: 'app', slug: 'app-10', col: 0, row: 3 },
  ] };
  Home.visibleRowBudget = () => 3;
  Home._editing = false;
  Home.render();
  assert.equal(model().items.length, 10, 'collapsed without edit mode');
  assert.ok(moreCount() > 0, 'the expander is up');

  Home._editing = true;
  Home.render();
  const state = model();
  assert.equal(state.editing, true);
  assert.equal(state.items.length, 11, 'edit mode shows every tile, so all are reachable');
  assert.equal(moreCount(), 0, 'and nothing is held back');
  assert.ok(state.create, 'the trailing Create tile keeps its place in edit mode');
  // ...and leaving puts the collapse back.
  Home._editing = false;
  Home.render();
  assert.equal(model().items.length, 10);
  assert.ok(moreCount() > 0);
});

test('while editing the trailing tile keeps its at-rest presence, private members included', () => {
  const { Home, model, sandbox } = makeHome();
  sandbox.App.user.privateMember = true;
  Home._apps = mine(2);
  Home.render();
  assert.equal(model().create, null, 'a private member gets no Create tile at rest');
  Home._editing = true;
  Home.render();
  assert.equal(model().create, null, 'and none in edit mode: Add apps is the heading button now');
  // ...and a normal account keeps its Create tile's facts.
  const { Home: H2, model: m2 } = makeHome();
  H2._apps = mine(2);
  H2._editing = true;
  H2.render();
  assert.equal(m2().create.enabled, true, 'the Create view fields are still filled');
});

// ── the remove button's action ────────────────────────────────────────

test('_editRemove unfavourites, for a pinned app and for a hidden-pin collaborator alike', () => {
  const { Home } = makeHome();
  const calls = [];
  Home.toggleAdded = (slug, desired) => { calls.push([slug, desired]); };

  Home._apps = [
    mine(1)[0],
    { slug: 'collab-app', name: 'Collab', is_collaborator: true, is_favorited: false, your_apps_hidden: false },
  ];
  Home._editRemove('app-0');
  Home._editRemove('collab-app');
  Home._editRemove('no-such-app');
  assert.deepEqual(calls, [
    ['app-0', false],
    ['collab-app', false],
  ], 'exactly what the tile menu\'s "Remove from My apps" passes, and nothing for an unknown slug');
});

// ── the deferral under a drag ─────────────────────────────────────────

test('entering edit mode mid-gesture defers the paint to the settle flush', () => {
  const { Home, model } = makeHome();
  Home._apps = mine(2);
  Home.render();
  Home._dragActive = true;
  Home.setEditing(true);
  assert.equal(model().editing, false, 'React never reconciles under the kit');
  assert.equal(Home._rerenderPending, true, 'onSettle drains this and repaints');
  Home._dragActive = false;
  Home.render();
  assert.equal(model().editing, true, 'the wiggle starts on release');
});

// ── what ends edit mode ───────────────────────────────────────────────

test('load() ends edit mode — the router calls it on every visit to Home', async () => {
  const { Home } = makeHome();
  Home._editing = true;
  await Home.load();
  assert.equal(Home._editing, false);
});

test('a value in the search field ends edit mode', () => {
  const HOME = HOME_SRC;
  assert.match(HOME, /if \(Home\._editing && input\.value\) Home\._editing = false;/,
    'the search input\'s own listener clears the flag');
});

test('Escape ends edit mode, through a once-wired document listener', () => {
  const listeners = [];
  const { Home, sandbox } = makeHome();
  sandbox.document.addEventListener = (type, fn) => { if (type === 'keydown') listeners.push(fn); };
  Home._editExitWired = false;
  Home.render();
  Home.render();
  assert.equal(listeners.length, 1, 'wired once, however many renders run');
  Home._editing = true;
  listeners[0]({ key: 'Escape' });
  assert.equal(Home._editing, false, 'Escape ends it');
  Home._editing = true;
  listeners[0]({ key: 'Enter' });
  assert.equal(Home._editing, true, 'and nothing else does');
});

// ── where edit mode starts ────────────────────────────────────────────

test('both long-press entry sites start it, and only for own non-demo tiles', () => {
  const HOME = HOME_SRC;
  // Touch: the kit recognizer's own selector is the gate — it only ever
  // hands onLift a `.app-card[data-yours]:not([data-demo])` — so the touch
  // branch needs no second check and must have one call.
  assert.match(HOME, /itemSelector: '\.app-card\[data-yours\]:not\(\[data-demo\]\)'/);
  assert.match(HOME, /Home\.openCardMenu\(item\.dataset\.slug, item\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*Home\.setEditing\(true\);/,
    'the touch lift starts edit mode beside the menu it opens');
  // Mouse and pen: the 400ms hold timer, gated on the card's own attributes.
  const timer = HOME.slice(HOME.indexOf('opened = true;'), HOME.indexOf('if (opened) setTimeout'));
  assert.match(timer, /Home\.openCardMenu\(card\.dataset\.slug, card\);/);
  assert.match(timer, /card\.hasAttribute\('data-yours'\) && !card\.hasAttribute\('data-demo'\)/);
  assert.match(timer, /Home\.setEditing\(true\);/);
  // A hold that reaches the timer through a remove button is not a hold on
  // the tile.
  assert.match(HOME, /e\.target\.closest\('\.app-card-remove'\)\) return;/);
});

// ── the markup side, where source is the honest check ─────────────────

test('the heading actions and the wiggle are on the screen they serve', () => {
  const index = read('frontend/src/features/home/index.tsx');
  assert.match(index, /home-edit-done/);
  assert.match(index, /grid\.editing \?/, 'no action at all while edit mode is off');
  assert.match(index, /Home\?\.setEditing\?\.\(false\)/);
  // "Add apps" rides beside Done (#4669): the sheet opens from the heading,
  // not from a stand-in trailing tile.
  assert.match(index, /home-edit-add/);
  assert.match(index, /openAddAppsSheet\(\)/);
  assert.doesNotMatch(read('frontend/src/features/home/app-grid.tsx'), /AddAppsTile/);
  assert.doesNotMatch(read('frontend/src/features/home/create-tile.tsx'), /AddAppsTile/);
  const css = read('public/css/app.css');
  assert.match(css, /@keyframes home-wiggle/);
  assert.match(css, /#app-list\[data-editing\] > \.app-card > \.relative \{\n  animation: home-wiggle 260ms ease-in-out infinite alternate;\n\}/);
  assert.match(css, /#app-list\.un-reordering\[data-editing\] > \.app-card > \.relative \{\n  animation-play-state: paused;\n\}/);
  // The override lives inside a reduce block, so its rule is indented four
  // — an exact match on the shape, wherever in the file the block sits.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?#app-list\[data-editing\] > \.app-card > \.relative \{\n    animation: none;\n  \}/,
    'the wiggle is the only thing reduced motion takes away');
});

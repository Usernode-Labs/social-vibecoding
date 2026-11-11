// ONE PINNED GRID: Home's Pinned apps and Pinned communities are one grid.
//
// A community pinned on Home (GET /api/me/home-pins, home-pins-store.ts)
// puts its app's tile in `#app-list` beside the apps you pinned (home.js
// `Home.onHome`), the tile wears the votes its community waits on you for,
// Needs you and All communities end the grid before New community, taking a
// tile off unpins both of the pins that can put it there, and a tap on a tile
// opens the chooser (pin-chooser.tsx) instead of the app.
//
// home.js runs here as classic script text in a vm (./helpers/home-modules
// strips its imports), with the two stores it reads off `window` faked: the
// pins (`HomePinsStore`) and the community scope (`CommunityScopeStore`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fakeStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) { state = { ...state, ...patch }; for (const l of [...listeners]) l(); },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

function makeHome({ pins = [], joined = [], owed = {}, ready = true, needs = 0 } = {}) {
  const unpinned = [];
  const toggled = [];
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
      dispatchEvent: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
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
    // menuItemsFor reads these through imports the vm strips (as
    // tests/home-card-menu.test.js declares them): a laptop, no repo link.
    detectInstallHost: () => 'none',
    linkKind: () => null,
    readInterfaceMode: () => 'advanced',
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  sandbox.HomePinsStore = fakeStore({ ready, pins, joined, owed });
  sandbox.CommunityScopeStore = fakeStore({ badgeNeeds: needs });
  sandbox.UsernodeReact = {
    homePins: { unpin: async (slug, say) => { unpinned.push({ slug, said: say.unpinned }); return true; } },
  };
  vm.createContext(sandbox);
  installAppCard(sandbox);
  const gridStore = installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n;globalThis.HomeLayout = HomeLayout;`, sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.HomePanels = HomePanels;`, sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  Home._menuToggleFavorite = (app, desired) => { toggled.push({ slug: app.slug, desired }); return Promise.resolve(); };
  const model = () => JSON.parse(JSON.stringify(gridStore.get()));
  return { Home, model, sandbox, unpinned, toggled };
}

const app = (slug, over = {}) => ({
  slug, name: slug.toUpperCase(), status: 'running', is_favorited: false, is_collaborator: false, ...over,
});
const pin = (slug) => ({ slug, name: slug, iconUrl: null, iconEmoji: null, iconColor: null, member: true });

test('a pinned community puts its app on the one grid, beside the apps you pinned', () => {
  const { Home, model } = makeHome({ pins: [pin('community-only')] });
  Home._apps = [
    app('mine', { is_favorited: true, favorite_order: 0 }),
    app('community-only', { is_member: true }),
    app('elsewhere'),
  ];
  Home._appsLoaded = true;
  Home.render();
  const slugs = model().items.map((it) => it.app.slug);
  assert.deepEqual(slugs.sort(), ['community-only', 'mine']);
  assert.equal(Home.onHome(Home._apps[1]), true);
  assert.equal(Home.isYours(Home._apps[1]), false, 'a community pin is not an app pin');
});

test('a tile wears the votes its community waits on you for', () => {
  const { Home, model } = makeHome({ pins: [pin('voting')], owed: { voting: 3 } });
  Home._apps = [app('voting', { is_member: true })];
  Home._appsLoaded = true;
  Home.render();
  assert.equal(model().items[0].app.votes, 3);
});

test('Needs you and All communities end the grid, before New community', () => {
  const { Home, model } = makeHome({
    pins: [pin('a')],
    joined: [{ slug: 'a' }, { slug: 'not-on-home' }],
    needs: 4,
  });
  Home._apps = [app('a', { is_member: true }), app('not-on-home', { is_member: true })];
  Home._appsLoaded = true;
  Home.render();
  const m = model();
  assert.deepEqual(m.trailing.map((t) => t.kind), ['needs', 'all']);
  assert.equal(m.trailing[0].count, 4);
  const cells = [m.items[0].app.slug, ...m.trailing.map((t) => t.kind), 'create'];
  const places = [m.items[0].placement, ...m.trailing.map((t) => t.placement), m.create.placement];
  // One after the other along the first row: the tile, Needs you, All
  // communities, then the Create tile.
  assert.deepEqual(places.map((p) => [p.col, p.row]), [[0, 0], [1, 0], [2, 0], [3, 0]], cells.join(' '));
});

test('nothing waiting and nothing left out says nothing', () => {
  const { Home, model } = makeHome({ pins: [pin('a')], joined: [{ slug: 'a' }], needs: 0 });
  Home._apps = [app('a', { is_member: true })];
  Home._appsLoaded = true;
  Home.render();
  assert.deepEqual(model().trailing, []);
});

test('edit mode and the search view draw no trailing tiles', () => {
  const env = makeHome({ pins: [pin('a')], joined: [{ slug: 'a' }, { slug: 'b' }], needs: 2 });
  env.Home._apps = [app('a', { is_member: true }), app('b', { is_member: true })];
  env.Home._appsLoaded = true;
  env.Home._editing = true;
  env.Home.render();
  assert.deepEqual(env.model().trailing, []);
  env.Home._editing = false;
  env.Home._query = 'a';
  env.Home.render();
  assert.deepEqual(env.model().trailing, []);
});

test('a pin landing repaints the grid', () => {
  const { Home, model, sandbox } = makeHome({ pins: [] });
  Home._apps = [app('late', { is_member: true })];
  Home._appsLoaded = true;
  Home.render();
  assert.equal(model().items.length, 0);
  sandbox.HomePinsStore.set({ pins: [pin('late')] });
  assert.deepEqual(model().items.map((it) => it.app.slug), ['late']);
});

test('taking a tile off Home unpins whatever put it there, with one toast', async () => {
  const both = makeHome({ pins: [pin('both')] });
  both.Home._apps = [app('both', { is_favorited: true, is_member: true })];
  await both.Home.takeOffHome(both.Home._apps[0]);
  assert.deepEqual(both.toggled, [{ slug: 'both', desired: false }]);
  assert.deepEqual(both.unpinned, [{ slug: 'both', said: '' }], 'the app\'s own toast speaks for both');

  const community = makeHome({ pins: [pin('only')] });
  community.Home._apps = [app('only', { is_member: true })];
  await community.Home.takeOffHome(community.Home._apps[0]);
  assert.deepEqual(community.toggled, []);
  assert.equal(community.unpinned.length, 1);
  assert.match(community.unpinned[0].said, /Unpinned ONLY/);
});

test('the tile menu offers Unpin from Home for a tile that is on Home for its community', () => {
  const { Home } = makeHome({ pins: [pin('only')] });
  const row = app('only', { is_member: true });
  Home._apps = [row];
  const fav = Home.menuItemsFor(row).find((item) => item.key === 'favorite');
  assert.equal(fav.label, 'Unpin from Home');
});

test('a stored arrangement is not repaired before the pins are read', () => {
  const { Home } = makeHome({ ready: false, pins: [] });
  let persisted = 0;
  Home._persistLayout = () => { persisted += 1; return Promise.resolve(true); };
  Home._apps = [app('mine', { is_favorited: true })];
  Home._appsLoaded = true;
  // A stored cell for a tile that is on Home for its community alone, whose
  // pin has not been read yet: it must survive this paint.
  Home._layouts = { 4: [
    { type: 'app', slug: 'mine', col: 0, row: 0 },
    { type: 'app', slug: 'community-only', col: 1, row: 0 },
  ] };
  Home.currentLayout(4);
  assert.equal(persisted, 0);
  assert.equal(Home._layouts[4].length, 2);
});

test('the grid opens the chooser on a tap, and the chooser offers the app and its community', () => {
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /openPinChooser\(\{ slug: app\.slug, name: app\.name, votes: app\.votes \}, el\)/);
  assert.doesNotMatch(grid, /\(window as any\)\.App\?\.navigateToApp\(app\.slug\);\n\s*\}\}/,
    'a tap no longer opens the app straight away');
  assert.match(grid, /<PinChooser \/>/);
  const chooser = read('frontend/src/features/home/pin-chooser.tsx');
  assert.match(chooser, /placeUnderAnchor\(/, 'placed like the vote popover');
  assert.match(chooser, /useAnchoredDismiss\(/, 'dismissed like the vote popover');
  assert.match(chooser, /kit\.sheet\(/, 'a bottom sheet on touch, like the vote sheet');
  assert.match(chooser, /data-pin-choice="app"/);
  assert.match(chooser, /data-pin-choice="community"/);
  assert.match(chooser, /win\(\)\?\.Home\?\.openHub\?\.\(slug\)/);
});

test('Home draws one Pinned section: the Pinned communities section is retired', () => {
  const index = read('frontend/src/features/home/index.tsx');
  assert.doesNotMatch(index, /<PinnedCommunities \/>/);
  const home = JSON.parse(read('frontend/locales/en/home.json'));
  assert.equal(home['grid.heading'].text, 'Pinned');
  assert.equal(home['chooser.openApp'].text, 'Open app');
  assert.equal(home['chooser.community'].text, 'Go to community');
});

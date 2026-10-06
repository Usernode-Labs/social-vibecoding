'use strict';

// An empty "Your apps" says nothing: a new account's Home is the New project
// tile alone (the owner, 6 October 2026, from the planned-vs-built review).
//
// It carried "No apps added yet. Make one with New project, or find one in
// the Discover section." from #2564 until then, which told a new account what
// the tile beside it already showed; the "Look around first" tour now points
// at the tile instead. What stays pinned:
//
//   1. A finished, empty load draws no line: the tile alone.
//   2. The initial state is still the skeleton (the hydration contract,
//      AGENTS.md: the SSG pass renders `INITIAL_GRID`).
//   3. A failed load and a search that matched nothing keep their own lines.
//   4. `Home.render()` reaches the empty state for an account with no apps.
//
// Run with: node --test tests/home-empty-apps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore, INITIAL_GRID } = require('./helpers/home-grid-store');
const { installAppCard } = require('./helpers/app-card');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const GRID = 'frontend/src/features/home/app-grid.tsx';
const SHEET = 'frontend/src/features/app-context/app-context-sheet.tsx';

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The line it used to draw.
const SENTENCE = 'No apps added yet. Make one with New project, or find one in the Discover section.';

// ── rendering AppGrid at an arbitrary state ───────────────────────────
//
// The component reads its model through `useStoreState(gridStore)`, and the
// store is a module singleton inside the bundle. `loadTsx`'s `stubs` hands the
// import a store of our own instead, which is all `useStoreState` needs: a
// `get` and a `subscribe`. Nothing subscribes under `renderToStaticMarkup`.
function renderGrid(patch) {
  const state = { ...INITIAL_GRID, ...patch };
  const gridStore = { get: () => state, subscribe: () => () => {} };
  const { AppGrid } = loadTsx(GRID, { stubs: { './grid-store': { gridStore } } });
  return renderToHtml(createElement(AppGrid, {}));
}

// ── 1. no line ────────────────────────────────────────────────────────

test('the line and its copy are gone, from the grid and from the source', () => {
  const src = read(GRID);
  assert.doesNotMatch(src, /AppsEmptyNote|NO_APPS_YET|no-apps-yet|data-home-apps-empty/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'frontend/src/features/apps/no-apps-yet.ts')), false);
  assert.ok(!read(SHEET).includes(SENTENCE), 'and the app menu carries no copy either');
});

// ── 2. the states around it ────────────────────────────

test('the initial state renders no note — the prerender has none either', () => {
  const html = renderGrid({});
  assert.ok(!html.includes(SENTENCE),
    'a grid that has not loaded yet is loading, not empty; drawing this would be'
    + ' a hydration mismatch against the prerendered document');
  assert.match(html, /Loading your apps/, 'it is still the skeleton at this point');
  assert.ok(!read('public/index.html').includes(SENTENCE),
    'and the prerendered shell agrees');
});

test('a finished, empty load draws no line: the New project tile alone', () => {
  const html = renderGrid({ ready: true });
  assert.ok(!html.includes(SENTENCE), html);
  assert.ok(!/No apps added/.test(html));
  assert.ok(!/Loading your apps/.test(html), 'and the skeleton is gone');
  const withTile = renderGrid({ ready: true, create: { enabled: true, hint: '', placement: null } });
  assert.match(withTile, /id="home-create-tile"/);
  assert.ok(!withTile.includes(SENTENCE));
});

test('a load that produced apps does not', () => {
  const app = {
    slug: 'demo-app',
    name: 'Demo App',
    status: 'running',
    icon: { kind: 'letter', letter: 'D' },
    locked: false,
    demo: false,
    statusLabel: '',
    isAwaiting: false,
    isError: false,
    clickable: true,
    failureReason: null,
    showRetry: false,
    forkName: null,
  };
  const html = renderGrid({
    ready: true,
    items: [{ kind: 'card', placement: { col: 0, row: 0, w: 1, h: 1 }, app }],
  });
  assert.ok(!html.includes(SENTENCE));
  assert.match(html, /Demo App/);
});

test('a failed or offline load keeps its own answer', () => {
  const failed = renderGrid({
    ready: true, notice: { text: "Couldn't load your apps", tone: 'error' },
  });
  assert.ok(!failed.includes(SENTENCE), 'the error card says what happened and offers a Retry');
  assert.match(failed, /data-apps-load-error=""/);

  const offline = renderGrid({ ready: true, notice: { text: "You're offline", tone: 'muted' } });
  assert.ok(!offline.includes(SENTENCE), 'offline is not "you have no apps"');
});

test('a search that matched nothing keeps its own answer', () => {
  const html = renderGrid({ ready: true, view: 'search', emptyQuery: 'zzz' });
  assert.ok(!html.includes(SENTENCE), 'the search line names the query instead');
  assert.match(html, /No apps match/);
});

// ── 3. Home.render() reaches that state for an account with no apps ───

function makeHome() {
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
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  const gridStore = installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(
    `${read('frontend/src/features/home/home-layout.js')}\n;globalThis.HomeLayout = HomeLayout;`,
    sandbox,
  );
  vm.runInContext(`${PANELS_SRC}\n;globalThis.HomePanels = HomePanels;`, sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, gridStore };
}

test('an account with no apps reaches the empty state, which draws no line', () => {
  const { Home, gridStore } = makeHome();
  Home._apps = [];
  Home.render();
  // Cross-realm: the store lives in the vm context, so round-trip through JSON.
  const state = JSON.parse(JSON.stringify(gridStore.get()));
  assert.equal(state.ready, true, 'the load finished');
  assert.equal(state.view, 'grid');
  assert.deepEqual(state.items, []);
  assert.equal(state.notice, null);
  assert.equal(state.emptyQuery, null);
  // ...and that state draws no line.
  assert.ok(!renderGrid(state).includes(SENTENCE));
});

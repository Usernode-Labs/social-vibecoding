'use strict';

// #2564: an empty "Your apps" says so.
//
// A finished load of the launcher canvas with nothing on it used to render an
// empty `#app-list`, so the area under the "Your apps" label was blank on a
// first sign-in. It now carries the one line the app-context sheet's switcher
// strip already used for the same empty set, and both read it from the shared
// constant in frontend/src/features/apps/no-apps-yet.ts.
//
// Three properties are worth pinning, and none of them is a grep:
//
//   1. The note is ABSENT from the initial store state. That is the hydration
//      contract (AGENTS.md): the SSG pass renders `INITIAL_GRID`, so a first
//      client render that drew the note would mismatch the prerendered
//      document, `console.error`, and fail the proposal checks.
//   2. It appears only for a finished, un-noticed, un-searched, empty load —
//      the grid has two other empty answers (the error card and the
//      "no match" search line) and this must not displace either.
//   3. `Home.render()` actually reaches that state for an account with no
//      apps, which is the case the request is about.
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
const COPY = 'frontend/src/features/apps/no-apps-yet.ts';

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const SENTENCE = 'No apps added yet. Find apps to add in the Discover section.';

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

// ── 1. the line itself ────────────────────────────────────────────────

test('the note is the exact sentence, from the shared constant', () => {
  const { NO_APPS_YET } = loadTsx(COPY);
  assert.equal(NO_APPS_YET, SENTENCE, 'the wording is fixed copy, not a paraphrase');

  const { AppsEmptyNote } = loadTsx(GRID);
  const html = renderToHtml(createElement(AppsEmptyNote, {}));
  assert.match(html, /data-home-apps-empty=""/);
  assert.ok(html.includes(SENTENCE), `the note renders the sentence: ${html}`);
  assert.match(html, /col-span-full/, 'it spans the four columns of the canvas');
});

test('the launcher says it with a constant, and nothing hand-types it', () => {
  // ONE CALLER NOW, not two. The app chip's sheet used to open on a strip of
  // your other apps and needed this sentence for the account that has none;
  // #2718's review took the strip out — a rail of other apps at the top of a
  // menu about ONE app is an invitation to leave it — so there is no second
  // surface to keep in step with. The constant stays: it is still the
  // launcher's copy, and the rule that matters is the one below, that NOBODY
  // hand-types the sentence.
  const src = read(GRID);
  assert.match(src, /from '\.\.\/apps\/no-apps-yet'/, `${GRID} imports the shared copy`);
  assert.match(src, /NO_APPS_YET/, `${GRID} renders the constant`);
  assert.ok(!read(SHEET).includes(SENTENCE),
    'and the app menu, which no longer lists apps, does not carry a copy');
});

// ── 2. when it draws, and when it must not ────────────────────────────

test('the initial state renders no note — the prerender has none either', () => {
  const html = renderGrid({});
  assert.ok(!html.includes(SENTENCE),
    'a grid that has not loaded yet is loading, not empty; drawing this would be'
    + ' a hydration mismatch against the prerendered document');
  assert.match(html, /Loading your apps/, 'it is still the skeleton at this point');
  assert.ok(!read('public/index.html').includes(SENTENCE),
    'and the prerendered shell agrees');
});

test('a finished, empty load draws it', () => {
  const html = renderGrid({ ready: true });
  assert.ok(html.includes(SENTENCE), html);
  assert.ok(!/Loading your apps/.test(html), 'and the skeleton is gone');
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

test('an account with no apps pushes exactly the state the note keys off', () => {
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
  // ...and that state is the one the component draws the note for.
  assert.ok(renderGrid(state).includes(SENTENCE));
});

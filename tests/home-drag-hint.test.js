'use strict';

// #4023 ("According to me"): the launcher's drag-to-rearrange and long-press
// gestures already existed, and nothing on the screen said so. The one-line
// hint under the "Shortcuts" heading is what makes them findable.
//
// Three properties are worth pinning, and none of them is a grep:
//
//   1. The hint is ABSENT from the initial store state. That is the hydration
//      contract (AGENTS.md): the SSG pass renders `INITIAL_GRID`, so a first
//      client render that drew the hint would mismatch the prerendered
//      document, `console.error`, and fail the proposal checks.
//   2. It shows only for a finished, un-noticed, un-searched load that has
//      tiles on screen — never above an empty shelf, a load notice, or the
//      search view, which each already answer for themselves.
//   3. It sits between the "Shortcuts" heading and the grid, as a sibling of
//      the `h2`, so the declared check that selects
//      `#home-body #home-apps-section > h2.home-area-label` keeps matching.
//
// Run with: node --test tests/home-drag-hint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { INITIAL_GRID } = require('./helpers/home-grid-store');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const GRID = 'frontend/src/features/home/app-grid.tsx';
const INDEX = 'frontend/src/features/home/index.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Fixed copy, the words the tiles themselves use ("app actions" is the tiles'
// title tooltip): the spec quotes it verbatim.
const HINT = 'Hold and drag a tile to rearrange it; long-press for app actions.';

const APP = {
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
  audience: 'open',
};

// DragHint at an arbitrary model — the same store stub tests/home-empty-apps
// .test.js hands `loadTsx`: `useStoreState` needs only `get` and `subscribe`.
// Nothing subscribes under `renderToStaticMarkup`.
function renderHint(patch) {
  const state = { ...INITIAL_GRID, ...patch };
  const gridStore = { get: () => state, subscribe: () => () => {} };
  const { DragHint } = loadTsx(GRID, { stubs: { './grid-store': { gridStore } } });
  return renderToHtml(createElement(DragHint, {}));
}

const WITH_TILES = {
  ready: true,
  items: [{ kind: 'card', placement: { col: 0, row: 0, w: 1, h: 1 }, app: APP }],
};

// ── 1. the line itself ────────────────────────────────────────────────

test('the hint is the exact wording, with its class as the only hook', () => {
  const html = renderHint(WITH_TILES);
  assert.ok(html.includes(HINT), `the hint renders its fixed copy: ${html}`);
  assert.match(html, /class="home-drag-hint /, 'the class the test and the copy review select on');
  assert.ok(!/—/.test(HINT), 'no em dash in the copy');
  assert.ok(!/\bid=/.test(html) && !/data-/.test(html),
    'no id and no data-*: the prerendered document and the id inventory stay untouched');
});

// ── 2. when it draws, and when it must not ────────────────────────────

test('the initial state renders no hint — the prerender has none either', () => {
  assert.equal(renderHint({}), '', 'a grid that has not loaded yet is loading, not hinting');
  assert.ok(!read('public/index.html').includes(HINT),
    'and the prerendered shell agrees — the hint is data-dependent');
});

test('a finished load with tiles draws it under the heading', () => {
  const html = renderHint(WITH_TILES);
  assert.ok(html.includes(HINT));
});

test('an empty grid keeps the hint off — it never sits above an empty shelf', () => {
  assert.equal(renderHint({ ready: true }), '',
    'an empty launcher offers the New project tile, not a drag lesson');
});

test('a load notice keeps its own answer', () => {
  assert.equal(renderHint({ ...WITH_TILES, notice: { text: "Couldn't load your apps", tone: 'error' } }), '',
    'the error card says what happened and offers a Retry');
  assert.equal(renderHint({ ...WITH_TILES, notice: { text: "You're offline", tone: 'muted' } }), '');
});

test('the search view keeps the hint off', () => {
  assert.equal(renderHint({ ...WITH_TILES, view: 'search' }), '');
  assert.equal(renderHint({ ...WITH_TILES, view: 'search', emptyQuery: 'zzz' }), '',
    'the "no match" line names the query instead');
});

// ── 3. where it sits on the screen ────────────────────────────────────

test('index.tsx renders it between the Shortcuts heading and the grid', () => {
  const src = read(INDEX);
  const heading = src.indexOf('<SectionHeading>Shortcuts</SectionHeading>');
  const hint = src.indexOf('<DragHint />');
  const grid = src.indexOf('<AppGrid />');
  assert.ok(heading !== -1 && hint !== -1 && grid !== -1);
  assert.ok(heading < hint && hint < grid,
    'a sibling after the h2, so the declared check selecting the heading keeps matching');
});

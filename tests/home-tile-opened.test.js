// A Pinned apps tile says when you last opened its app (part of #4025).
//
// "Opened 2h ago" under the name of an app this account left on this device
// in the last 30 days (frontend/src/features/nav/recent-apps-store.js keeps
// when). An app never opened says nothing, and so does a tile whose caption
// lane already carries a status. The first version of this hint was a
// Discover row's (#6323), which went with that screen.
//
// Run with: node --test tests/home-tile-opened.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { INITIAL_GRID } = require('./helpers/home-grid-store');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const GRID = 'frontend/src/features/home/app-grid.tsx';
const STORE = 'frontend/src/features/nav/recent-apps-store.js';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const tile = (over = {}) => ({
  slug: 'plant-pal',
  name: 'Plant Pal',
  status: 'running',
  icon: { kind: 'letter', letter: 'P' },
  locked: false,
  demo: false,
  statusLabel: '',
  buildLine: null,
  isAwaiting: false,
  isError: false,
  clickable: true,
  failureReason: null,
  showRetry: false,
  forkName: null,
  audience: 'open',
  ...over,
});

/** The grid drawn for `apps`, with `recents` as the device's list of apps left. */
function renderGrid(apps, recents, patch = {}) {
  const state = {
    ...INITIAL_GRID,
    ready: true,
    view: 'grid',
    items: apps.map((app, i) => ({ kind: 'card', placement: { col: i, row: 0, w: 1, h: 1 }, app })),
    ...patch,
  };
  const gridStore = { get: () => state, subscribe: () => () => {} };
  const real = loadTsx(STORE);
  const list = { apps: recents };
  const recentAppsStore = { get: () => list, subscribe: () => () => {} };
  const { AppGrid } = loadTsx(GRID, {
    stubs: {
      './grid-store': { gridStore },
      '../nav/recent-apps-store.js': { ...real, recentAppsStore },
    },
  });
  return renderToHtml(createElement(AppGrid, {}));
}

const left = (slug, at) => ({ slug, name: slug, iconUrl: null, iconEmoji: null, at });
const LINE = /<p class="app-card-status app-card-opened"><span class="app-card-opened-long">([^<]*)<\/span><span class="app-card-opened-short">([^<]*)<\/span><\/p>/;
const openedLine = (html) => (html.match(LINE) || [])[1];
const shortLine = (html) => (html.match(LINE) || [])[2];

test('the words are the Home catalog\'s, a whole message', () => {
  assert.equal(message('home:grid.tile.opened'), 'Opened {{when}}');
  assert.equal(message('home:grid.tile.openedShort'), '{{when}}');
  assert.match(read(GRID), /t\('home:grid\.tile\.opened', \{ when: /);
  assert.match(read(GRID), /t\('home:grid\.tile\.openedShort', \{ when: /);
});

test('a tile whose app was opened says when, under its name', () => {
  const html = renderGrid([tile()], [left('plant-pal', ago(2 * HOUR + 60 * 1000))]);
  assert.equal(openedLine(html), 'Opened 2h ago', html);
  assert.equal(shortLine(html), '2h ago', 'and the time alone, for a phone\'s narrow tile');
  assert.match(html, /aria-label="Plant Pal, Opened 2h ago"/, 'a screen reader hears it with the name');
});

test('an app never opened says nothing: no line, no empty element', () => {
  const html = renderGrid([tile(), tile({ slug: 'club-votes', name: 'Club Votes' })],
    [left('plant-pal', ago(5 * 60 * 1000))]);
  assert.equal((html.match(/app-card-opened"/g) || []).length, 1, 'one tile of the two says it');
  assert.equal(openedLine(html), 'Opened 5m ago');
  assert.match(html, /aria-label="Club Votes"/);
  assert.doesNotMatch(renderGrid([tile()], []), /app-card-opened|Opened/);
});

test('a status keeps the caption lane, and search results and demo tiles say nothing', () => {
  const recents = [left('plant-pal', ago(HOUR))];
  const errored = renderGrid([tile({ statusLabel: 'Error', isError: true })], recents);
  assert.doesNotMatch(errored, /app-card-opened/);
  assert.match(errored, />Error</);
  assert.doesNotMatch(renderGrid([tile()], recents, { view: 'search' }), /app-card-opened/,
    'the line is Pinned apps\' own');
  assert.doesNotMatch(renderGrid([tile({ demo: true })], recents), /app-card-opened/);
});

test('recentAppTimes: the latest time for each app, within 30 days, never a guess', () => {
  const { recentAppTimes } = loadTsx(STORE);
  const now = Date.parse('2026-11-19T12:00:00Z');
  const times = recentAppTimes([
    left('twice', '2026-11-19T09:00:00Z'),
    left('twice', '2026-11-19T11:00:00Z'),
    left('old', '2026-10-01T12:00:00Z'),
    left('no-clock', ''),
    left('ahead', '2026-11-20T12:00:00Z'),
    null,
  ], now);
  assert.deepEqual([...times.keys()], ['twice']);
  assert.equal(times.get('twice'), Date.parse('2026-11-19T11:00:00Z'), 'the later of two entries');
});

test('the line fits the tile\'s caption lane uncut, and Standard (WIP) does not draw it', () => {
  const css = read('public/css/app.css');
  const rule = css.match(/\n\.app-card-opened \{[^}]*\}/);
  assert.ok(rule, 'app.css styles the line');
  assert.match(rule[0], /color: var\(--text-muted\)/);
  assert.match(rule[0], /white-space: nowrap/, 'one line: the row height is fixed');
  assert.doesNotMatch(rule[0], /ellipsis|overflow|margin/, 'a time is never cut, and the line stays in its lane');
  assert.match(css, /\n\.app-card-opened-short \{ display: none; \}\n@media \(max-width: 639\.98px\) \{\n  \.app-card-opened-long \{ display: none; \}\n  \.app-card-opened-short \{ display: inline; \}\n\}/,
    'under the tile\'s own 640px breakpoint the time alone is shown');
  assert.match(css, /html:not\(\[data-skin\]\) #app-list \.app-card-opened \{ display: none; \}/,
    'the kit\'s Home (Standard (WIP), and the standard look since 20 Nov 2026) does not draw the line');
});

test('past a week it still counts days, never a date with a year', () => {
  const html = renderGrid([tile()], [left('plant-pal', ago(29 * 24 * HOUR + HOUR))]);
  assert.equal(openedLine(html), 'Opened 29d ago');
  assert.equal(shortLine(html), '29d ago');
});

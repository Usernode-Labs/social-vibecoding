// Bug f of the navigation audit: the Leaderboard screen's bar title did not
// follow its tabs.
//
// App._routeLeaderboard titled the screen on the way IN, but a tab press
// never comes back through the router — Leaderboard._syncHash rewrites the
// address with history.replaceState, which fires no hashchange — so the bar
// said "Challenges" over Kudos or the standings, and a cold
// #leaderboard/topochain said "Topochain", a word the strip did not use. The
// page ALSO kept its own <h2>Leaderboard</h2>, a second name for a screen the
// platform names once, in the bar.
//
// Now: one table of titles (App.LEADERBOARD_TITLES, each the label of the tab
// its address shows), read on entry AND on every in-screen change
// (Leaderboard._syncTitle), and no in-page heading.
//
// Run with: node --test tests/leaderboard-title-sync.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const appJs = read('public/js/app.js');
const lbSrc = read('frontend/src/features/leaderboard/leaderboard.js');
const island = read('frontend/src/features/leaderboard/index.tsx');

/** App's real title table and title function, lifted out of app.js. */
function realTitles() {
  const start = appJs.indexOf('  LEADERBOARD_TITLES: {');
  const end = appJs.indexOf('  _routeLeaderboard(', start);
  assert.ok(start > 0 && end > start, 'LEADERBOARD_TITLES and _leaderboardTitle located');
  return vm.runInNewContext(`(function(){ const App = { ${appJs.slice(start, end)} }; return App; })()`);
}

/** The real Leaderboard module, run as a script against a small DOM. */
function loadLeaderboard(App, { hash = '#leaderboard/challenges', detail = null } = {}) {
  const classes = new Map();
  const el = (id) => {
    if (!classes.has(id)) classes.set(id, new Set());
    const set = classes.get(id);
    return { classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) } };
  };
  const location = { hash };
  // One global object, as in a browser: the module reaches its guests both
  // as `window.X` and as bare `X`.
  const ctx = {
    App,
    TopochainChallenges: { open() {}, close() {}, _detailChallenge: detail },
    TopochainLeaderboard: { open() {}, close() {} },
    TopochainEventContext: { open() {}, close() {} },
    LeaderboardHistory: { open() {}, close() {} },
    location,
    history: { replaceState: (_s, _t, url) => { location.hash = url; } },
    document: { getElementById: el },
    console,
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // The module is a plain object literal; only its trailing publish needs a
  // tweak to run as a script, and its store accessor reads `window`.
  const code = lbSrc.replace(/^export .*$/gm, '');
  vm.runInContext(`${code}\n;globalThis.__lb = Leaderboard;`, ctx);
  return { Leaderboard: ctx.__lb, location };
}

function recordingApp() {
  const App = realTitles();
  App.titles = [];
  App.setHeaderTitle = (text) => App.titles.push(text);
  return App;
}

test('every address titles the bar with the label of the tab it shows', () => {
  const App = realTitles();
  const labels = Object.fromEntries([...island.matchAll(/\{ key: '([a-z]+)', label: '([^']+)' \}/g)]
    .map((m) => [m[1], m[2]]));
  assert.deepEqual(labels, { challenges: 'Challenges', kudos: 'Kudos', topochain: 'Standings', seasons: 'History' });
  for (const [key, label] of Object.entries(labels)) {
    assert.equal(App._leaderboardTitle(key), label, `#leaderboard/${key} says "${label}"`);
  }
  // The Kudos pane's own sub-views are the Kudos tab.
  for (const sub of ['prs', 'users', 'history']) assert.equal(App._leaderboardTitle(sub), 'Kudos');
  assert.equal(App._leaderboardTitle(undefined), 'Challenges', 'a bare #leaderboard is Challenges (#2374)');
  assert.equal(App._leaderboardTitle('users', 'dana'), '@dana', 'a person outranks the section');
  assert.ok(!/topochain: 'Topochain'/.test(appJs), 'no word the strip does not use');
});

test('a tab press re-titles the bar, although it never reaches the router', async () => {
  const App = recordingApp();
  const { Leaderboard, location } = loadLeaderboard(App);
  await Leaderboard.open();
  assert.equal(App.titles.at(-1), 'Challenges');
  for (const [section, title, hash] of [
    ['kudos', 'Kudos', '#leaderboard/prs'],
    ['topochain', 'Standings', '#leaderboard/topochain'],
    ['seasons', 'History', '#leaderboard/seasons'],
    ['challenges', 'Challenges', '#leaderboard/challenges'],
  ]) {
    Leaderboard._setSection(section);
    assert.equal(App.titles.at(-1), title, `${section}: the bar follows the tab`);
    assert.equal(location.hash, hash, 'and the address is rewritten in place, as before');
  }
  Leaderboard._setSub('users');
  assert.equal(App.titles.at(-1), 'Kudos');
  Leaderboard.openProfile('dana');
  assert.equal(App.titles.at(-1), '@dana');
});

test('a closed screen and an open challenge page keep their own titles', () => {
  const App = recordingApp();
  const closed = loadLeaderboard(App).Leaderboard;
  closed._setSection('kudos');
  assert.equal(App.titles.length, 0, 'deep-link restore before open() titles nothing: the router did');
  const App2 = recordingApp();
  const onDetail = loadLeaderboard(App2, { detail: { id: 5 } }).Leaderboard;
  onDetail._open = true;
  onDetail._syncTitle();
  assert.equal(App2.titles.length, 0, 'a challenge page keeps "Challenge" (TopochainChallenges._syncChrome)');
});

test('the screen says its name once: no in-page heading over the strip', () => {
  const main = island.slice(island.indexOf('    <main\n'), island.indexOf('id="standings-tabs"'));
  assert.ok(main.length > 0);
  assert.doesNotMatch(main.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''), /<h2/,
    'the bar is the screen\'s only title');
});

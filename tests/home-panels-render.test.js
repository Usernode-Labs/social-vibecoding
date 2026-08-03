// public/js/home-panels.js — the home screen's Challenges card (#911).
//
// The card sits between the "Your apps" grid and "Featured apps", in its
// OWN static <section id="home-panels"> outside #app-list (the grid's
// innerHTML is replaced on every WS app event and search keystroke, which
// would otherwise destroy the card and its listeners — the same reasoning
// that keeps the home search input outside the grid).
//
// Contracts guarded here:
//
//   1. Reward strings are organiser prose: rendered verbatim, with the
//      single exception that a bare number gets " pts" appended.
//   2. The progress bar clamps and never divides by a zero/NaN target.
//   3. Rows lead with what you have NOT done yet.
//   4. Binary rows get a ✓ Done / Not done yet chip; numeric rows get a
//      real progressbar with truthful aria values.
//   5. Organiser text is escaped for BOTH text and attribute contexts —
//      goals land inside aria-label="…", so & < > alone is not enough.
//   6. Nothing is rendered when there is nothing to say: signed out, no
//      data, panel hidden, or (for non-admins) no open challenges.
//
// Loads the module in a vm sandbox with the stub DOM idiom of
// tests/home-find-more.test.js — no browser.
//
// Run with: node --test tests/home-panels-render.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SRC = read('public/js/home-panels.js');
const INDEX = read('public/index.html');
const SW = read('public/sw.js');
const SCHEMA = read('src/db/schema.sql');
const SETTINGS = read('public/js/settings.js');
const HOME = read('public/js/home.js');

// A minimal #home-panels element the module can paint into, so render()
// can be exercised end to end and its output inspected.
function makeSection() {
  return {
    innerHTML: '',
    _classes: new Set(['hidden']),
    classList: {
      toggle: (c, on) => {
        if (on) makeSection._last._classes.add(c);
        else makeSection._last._classes.delete(c);
      },
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

function makeHomePanels({ user = { id: 1, isAdmin: false }, search = '' } = {}) {
  const section = makeSection();
  makeSection._last = section;
  const sandbox = {
    console,
    App: { user },
    document: {
      getElementById: (id) => (id === 'home-panels' ? section : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout,
    URLSearchParams,
    location: { search, hash: '' },
    Date,
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  return { HP: sandbox.__HP, section, sandbox };
}

const challenge = (over = {}) => ({
  id: 1,
  label: 'COMMUNITY',
  goal: 'Report a reproducible bug',
  task: 'Find and file a reproducible bug report.',
  reward: '250 pts',
  cta: null,
  metric: null,
  progress: { done: false, current: null, target: null },
  earned_points: 0,
  ...over,
});

const panel = (over = {}) => ({
  key: 'challenges',
  title: 'Challenges',
  season: { id: 1, name: 'Season 1' },
  total: 1,
  done: 0,
  points_remaining: null,
  challenges: [challenge()],
  ...over,
});

function renderWith(data, opts) {
  const { HP, section } = makeHomePanels(opts);
  HP._data = data;
  HP.render();
  return { HP, html: section.innerHTML, section };
}

// ── formatReward ──────────────────────────────────────────────────

test('formatReward: organiser prose verbatim, a bare number gets "pts"', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.formatReward('1500'), '1500 pts');
  assert.equal(HP.formatReward('6,500'), '6,500 pts');
  assert.equal(HP.formatReward('300 pts'), '300 pts');
  assert.equal(HP.formatReward('Up to 6,500 pts'), 'Up to 6,500 pts');
  assert.equal(HP.formatReward('½ of your final credits'), '½ of your final credits');
  assert.equal(HP.formatReward('Unlocks future rewards'), 'Unlocks future rewards');
  assert.equal(HP.formatReward(null), '');
  assert.equal(HP.formatReward('  '), '');
});

// ── progressPercent ───────────────────────────────────────────────

test('progressPercent: clamped, and safe against a zero/NaN target', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.progressPercent(0, 8), 0);
  assert.equal(HP.progressPercent(3, 8), 38);
  assert.equal(HP.progressPercent(8, 8), 100);
  assert.equal(HP.progressPercent(99, 8), 100, 'never wider than the track');
  assert.equal(HP.progressPercent(3, 0), 0);
  assert.equal(HP.progressPercent(3, null), 0);
  assert.equal(HP.progressPercent(NaN, 8), 0);
  assert.equal(HP.progressPercent(-2, 8), 0);
});

// ── orderRows ─────────────────────────────────────────────────────

test('orderRows: not-done rows come first, stably', () => {
  const { HP } = makeHomePanels();
  const rows = [
    challenge({ id: 1, progress: { done: true, current: null, target: null } }),
    challenge({ id: 2 }),
    challenge({ id: 3, progress: { done: true, current: null, target: null } }),
    challenge({ id: 4 }),
  ];
  assert.deepEqual(HP.orderRows(rows).map((c) => c.id), [2, 4, 1, 3]);
  assert.deepEqual(rows.map((c) => c.id), [1, 2, 3, 4], 'input is not mutated');
});

// ── summaryLine ───────────────────────────────────────────────────

test('summaryLine: the points clause only appears when it can be honest', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.summaryLine(panel({ total: 5, done: 2, points_remaining: 4300 })),
    '2 of 5 done · 4,300 pts still on the table');
  assert.equal(HP.summaryLine(panel({ total: 5, done: 2, points_remaining: null })),
    '2 of 5 done');
  assert.equal(HP.summaryLine(panel({ total: 3, done: 3, points_remaining: 0 })),
    '3 of 3 done', 'nothing left to earn drops the clause');
});

// ── Rendering ─────────────────────────────────────────────────────

test('render: a binary not-done row gets the muted chip and no bar', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.match(html, /Not done yet/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.match(html, /250 pts/);
  assert.match(html, /Report a reproducible bug/);
  assert.match(html, /Season 1/, 'the season captions the card');
});

test('render: a done binary row gets the ✓ chip and the points it earned', () => {
  const p = panel({
    done: 1,
    challenges: [challenge({
      progress: { done: true, current: null, target: null },
      earned_points: 250,
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.match(html, /&#10003; Done/);
  assert.match(html, /You earned 250 pts/);
  assert.doesNotMatch(html, /Not done yet/);
});

test('render: a numeric row gets a progressbar with truthful aria values', () => {
  const p = panel({
    challenges: [challenge({
      metric: { kind: 'count', label: 'Apps tested', target: 8 },
      progress: { done: false, current: 3, target: 8 },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="3"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="8"/);
  assert.match(html, /width:38%/);
  assert.match(html, /3 \/ 8 Apps tested/);
});

test('render: a numeric row at zero still renders an (empty) bar', () => {
  const p = panel({
    challenges: [challenge({
      metric: { kind: 'count', label: 'Kudos', target: 5 },
      progress: { done: false, current: 0, target: 5 },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.match(html, /width:0%/);
  assert.match(html, /0 \/ 5 Kudos/);
});

test('render: an http(s) cta becomes a real anchor; anything else is dropped', () => {
  const ok = panel({
    challenges: [challenge({ cta: { label: 'Start', link: 'https://example.invalid/go' } })],
  });
  assert.match(renderWith({ registry: [], hidden: [], panels: [ok] }).html,
    /<a href="https:\/\/example\.invalid\/go" target="_blank" rel="noopener"/);

  const evil = panel({
    challenges: [challenge({ cta: { label: 'Start', link: 'javascript:alert(1)' } })],
  });
  const html = renderWith({ registry: [], hidden: [], panels: [evil] }).html;
  assert.doesNotMatch(html, /javascript:/, 'a non-http(s) scheme is never an href');
  assert.doesNotMatch(html, /home-panel-cta/);
});

test('render: organiser text is escaped in text AND attribute contexts', () => {
  const p = panel({
    challenges: [challenge({
      goal: 'Break "out" of <it> & \'quote\'',
      metric: { kind: 'count', label: 'x', target: 4 },
      progress: { done: false, current: 1, target: 4 },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.doesNotMatch(html, /aria-label="[^"]*"out"/, 'no raw quote inside an attribute');
  assert.match(html, /&quot;out&quot;/);
  assert.match(html, /&lt;it&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&#39;quote&#39;/);
});

test('render: the footer counts the challenges the card could not fit', () => {
  const five = Array.from({ length: 5 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 8, challenges: five })],
  });
  assert.match(html, /See all 8 challenges/);

  const { html: exact } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 5, challenges: five })],
  });
  assert.match(exact, /See all challenges/);
  assert.doesNotMatch(exact, /See all 5 challenges/);
});

test('render: nothing at all when signed out, unloaded, or hidden', () => {
  // Signed out.
  const out = renderWith({ registry: [], hidden: [], panels: [panel()] },
    { user: null });
  assert.equal(out.html, '');
  assert.ok(out.section._classes.has('hidden'));

  // Data not loaded yet — absent, never a skeleton flash.
  const { HP, section } = makeHomePanels();
  HP.render();
  assert.equal(section.innerHTML, '');

  // Dismissed by this viewer: the server omits it from `panels`.
  const hiddenOut = renderWith({ registry: [{ key: 'challenges', title: 'Challenges' }], hidden: ['challenges'], panels: [] });
  assert.equal(hiddenOut.html, '');
});

test('render: an empty card is admin-only', () => {
  const empty = panel({ total: 0, done: 0, challenges: [] });
  const asUser = renderWith({ registry: [], hidden: [], panels: [empty] },
    { user: { id: 1, isAdmin: false } });
  assert.equal(asUser.html, '', 'no empty box on every home screen');

  const asAdmin = renderWith({ registry: [], hidden: [], panels: [empty] },
    { user: { id: 1, isAdmin: true } });
  assert.match(asAdmin.html, /No challenges are running right now/);
  assert.ok(!asAdmin.section._classes.has('hidden'));
});

test('setHidden drops the panel optimistically and restores it on failure', async () => {
  const { HP, section, sandbox } = makeHomePanels();
  HP._data = { registry: [{ key: 'challenges', title: 'Challenges' }], hidden: [], panels: [panel()] };
  HP.render();
  assert.match(section.innerHTML, /Report a reproducible bug/);

  sandbox.fetch = async () => ({ ok: false, json: async () => ({}) });
  const ok = await HP.setHidden('challenges', true);
  assert.equal(ok, false);
  assert.deepEqual(HP._data.hidden, [], 'a failed write must not look like it stuck');
  assert.match(section.innerHTML, /Report a reproducible bug/);
});

// ── Source pins ───────────────────────────────────────────────────

test('index.html hosts #home-panels between the grid and Featured apps', () => {
  const grid = INDEX.indexOf('id="app-list"');
  const panels = INDEX.indexOf('id="home-panels"');
  const findMore = INDEX.indexOf('id="home-find-more"');
  assert.ok(grid > 0 && panels > 0 && findMore > 0);
  assert.ok(panels > grid, 'the card sits below "Your apps"');
  assert.ok(panels < findMore, 'and above "Featured apps"');
  // Outside the grid, or a re-render would destroy it.
  assert.ok(INDEX.indexOf('</section>', panels) < findMore);
});

// #922 centred the whole feed in a 1024px .home-column and DELETED the
// per-box .home-section-block bound (plus Home.alignSections). The card has
// to follow that convention: header, then the card as a plain full-width
// child of the section — same shape tests/home-find-more.test.js pins for
// "Featured apps" and "Create an app". A re-introduced wrapper would render
// this one box narrower than its neighbours.
test('the card is a full-width child of its section, not separately bounded', () => {
  const populated = renderWith({ registry: [], hidden: [], panels: [panel()] }).html;
  const empty = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, done: 0, challenges: [] })] },
    { user: { id: 1, isAdmin: true } }
  ).html;
  for (const [name, html] of [['populated', populated], ['empty state', empty]]) {
    assert.doesNotMatch(html, /home-section-block/,
      `${name}: the column is the only width cap now`);
    assert.match(html, /class="home-section-header/, `${name}: shared heading`);
    // The card follows the header directly — no wrapper between them.
    assert.match(html, /<\/div>\s*<div class="home-panel-card/,
      `${name}: the card is the header's sibling`);
  }
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /\.home-section-block\b/, 'the class really is gone');
});

test('the module is loaded before home.js and precached by the service worker', () => {
  const panelsTag = INDEX.indexOf('src="/js/home-panels.js"');
  const homeTag = INDEX.indexOf('src="/js/home.js"');
  assert.ok(panelsTag > 0 && homeTag > 0);
  assert.ok(panelsTag < homeTag, 'home.js calls into HomePanels');
  assert.match(SW, /'\/js\/home-panels\.js'/);
});

test('home.js loads the panels once per TTL and paints them on every render', () => {
  assert.match(HOME, /HomePanels\?\.ensureLoaded\(\)/);
  assert.match(HOME, /HomePanels\?\.render\(\)/);
});

test('Settings offers the Home screen widgets section under Preferences', () => {
  assert.match(SETTINGS, /\{ key: 'home-panels', label: 'Home screen widgets', group: 'Preferences' \}/);
  assert.match(SETTINGS, /_renderHomePanelsSection\(\)/);
  assert.match(INDEX, /data-settings-section="home-panels"/);
  assert.match(INDEX, /id="settings-home-panels-list"/);
});

test('the per-user hidden set defaults to "everything visible"', () => {
  assert.match(SCHEMA, /home_panels_hidden TEXT\[\] NOT NULL DEFAULT '\{\}'/);
});

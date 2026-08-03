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
    '2 of 5 · 4,300 pts left');
  assert.equal(HP.summaryLine(panel({ total: 5, done: 2, points_remaining: null })),
    '2 of 5');
  assert.equal(HP.summaryLine(panel({ total: 3, done: 3, points_remaining: 0 })),
    '3 of 3', 'nothing left to earn drops the clause');
});

// ── visibleSlots ──────────────────────────────────────────────────
//
// The height cap buys exactly ROW_SLOTS 44px rows. Overflow spends the
// LAST slot on the "See all N" link rather than adding a row, so the
// budget is the same whether or not there is overflow.

test('visibleSlots: everything fits, no link row', () => {
  const { HP } = makeHomePanels();
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const out = HP.visibleSlots(panel({ total: 4, challenges: four }));
  assert.equal(out.rows.length, 4);
  assert.equal(out.link, false);
  assert.equal(out.total, 4);
});

test('visibleSlots: overflow gives the last slot to the link', () => {
  const { HP } = makeHomePanels();
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const out = HP.visibleSlots(panel({ total: 9, challenges: four }));
  assert.equal(out.rows.length, 3, 'three challenges + the link = four slots');
  assert.equal(out.link, true);
  assert.equal(out.total, 9, 'the link carries the TRUE total, not the page size');
  // Never more than the budget, whichever branch runs.
  assert.ok(out.rows.length + (out.link ? 1 : 0) <= HP.ROW_SLOTS);
});

test('visibleSlots: not-done rows win the slots when overflow trims', () => {
  const { HP } = makeHomePanels();
  const rows = [
    challenge({ id: 1, progress: { done: true, current: null, target: null } }),
    challenge({ id: 2 }),
    challenge({ id: 3 }),
    challenge({ id: 4 }),
  ];
  const out = HP.visibleSlots(panel({ total: 7, challenges: rows }));
  assert.deepEqual(out.rows.map((c) => c.id), [2, 3, 4],
    'the actionable rows survive; the finished one is what gets dropped');
});

test('visibleSlots: tolerates an empty/absent challenge list', () => {
  const { HP } = makeHomePanels();
  // Field-by-field, not deepEqual: the module runs in a vm realm, so its
  // objects have a different Object.prototype and strict deepEqual rejects
  // them as "same structure but not reference-equal".
  const empty = HP.visibleSlots(panel({ total: 0, challenges: [] }));
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.link, false);
  assert.equal(empty.total, 0);
  assert.equal(HP.visibleSlots({}).rows.length, 0);
  assert.equal(HP.visibleSlots({}).link, false);
});

// ── Rendering ─────────────────────────────────────────────────────

test('render: a binary not-done row is one line — hollow glyph, no bar', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.match(html, /home-panel-glyph[^"]*rounded-full border/, 'hollow ring, not a chip');
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /Not done yet/, 'the wordy chip is gone at this density');
  assert.match(html, /250 pts/);
  assert.match(html, /Report a reproducible bug/);
});

test('render: a done row gets the ✓ glyph, not a chip or an earned-points line', () => {
  const p = panel({
    done: 1,
    challenges: [challenge({
      progress: { done: true, current: null, target: null },
      earned_points: 250,
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.match(html, /&#10003;/);
  assert.match(html, /text-emerald-500/);
  assert.doesNotMatch(html, /You earned/, 'dropped — the row is one line now');
  assert.doesNotMatch(html, /Done<\/span>/);
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
  // The compact count; the metric label rides the aria-label so the row
  // stays one line.
  assert.match(html, /3\/8/);
  assert.match(html, /aria-label="[^"]*3 of 8 Apps tested"/);
  // The bar hugs the row's bottom edge — that's what keeps rows uniform.
  assert.match(html, /absolute left-2\.5 right-2\.5 bottom-\[3px\] h-\[2px\]/);
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
  assert.match(html, /0\/5/);
});

test('render: the row drops the category, task and CTA — task becomes the tooltip', () => {
  const p = panel({
    challenges: [challenge({
      label: 'COMMUNITY',
      task: 'Find and file a reproducible bug report.',
      cta: { label: 'Start', link: 'https://example.invalid/go' },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });
  assert.doesNotMatch(html, /COMMUNITY/, 'the category pill is gone at this density');
  assert.doesNotMatch(html, /<a href=/, 'no per-row Start button');
  assert.doesNotMatch(html, /example\.invalid/);
  // The task survives only as the row tooltip.
  assert.match(html, /title="[^"]*Find and file a reproducible bug report\."/);
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

test('render: the overflow slot replaces a row and carries the true total', () => {
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 8, challenges: four })],
  });
  assert.match(html, /See all 8 challenges/);
  // Four slots total: three challenges + the link. Count the row class with
  // a word boundary — `home-panel-rows` (the container) would otherwise
  // inflate the tally.
  assert.equal((html.match(/home-panel-row\b(?!s)/g) || []).length, 4);
  assert.equal((html.match(/data-challenge-id/g) || []).length, 3);

  // Nothing to overflow: four challenge rows, no link.
  const { html: exact } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 4, challenges: four })],
  });
  assert.doesNotMatch(exact, /See all/);
  assert.equal((exact.match(/data-challenge-id/g) || []).length, 4);
});

test('render: the title bar carries the title, the counter and the ✕ — no extra rows', () => {
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 6, done: 1, points_remaining: 3900 })],
  });
  assert.match(html, /home-panel-bar/);
  assert.match(html, /Challenges/);
  assert.match(html, /1 of 6 · 3,900 pts left/, 'the summary folds into the bar');
  assert.match(html, /home-panel-hide[^>]*data-panel-key="challenges"/);
  // The bar is flex-none so the ROWS list is what the cap compresses.
  assert.match(html, /home-panel-bar flex-none/);
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

// ── Container shape: one bordered block PER WIDGET ────────────────
//
// The core of the per-widget-container requirement. Only `challenges`
// exists today, so the two-panel case is the one that would silently
// regress into a shared card without a test.

test('render: each panel is its own bordered article, stacked as siblings', () => {
  const two = {
    registry: [{ key: 'challenges', title: 'Challenges' }],
    hidden: [],
    panels: [
      panel(),
      // A hypothetical second widget. renderPanel dispatches on key, so an
      // unknown one renders nothing rather than throwing — that's the
      // degradation path when the server ships a panel the client predates.
      { key: 'future-widget', title: 'Rank', total: 1, done: 0, challenges: [] },
    ],
  };
  const { html } = renderWith(two);
  // The known panel still renders as exactly one bordered article…
  assert.equal((html.match(/<article class="home-panel /g) || []).length, 1);
  assert.doesNotMatch(html, /Rank/, 'an unknown panel key is skipped, not thrown on');
  // …and the stack wrapper is what separates blocks.
  assert.match(html, /class="space-y-2"/);

  // Two RENDERABLE panels → two sibling articles, never one shared card.
  const bothKnown = {
    registry: [], hidden: [],
    panels: [panel(), panel({ title: 'Challenges' })],
  };
  const { html: pair } = renderWith(bothKnown);
  assert.equal((pair.match(/<article class="home-panel /g) || []).length, 2,
    'one bordered block per widget');
  assert.equal((pair.match(/home-panel-bar/g) || []).length, 2,
    'each block carries its OWN title bar and ✕');
  // Siblings: one article must close before the next opens (no nesting).
  const first = pair.indexOf('</article>');
  const second = pair.indexOf('<article', first);
  assert.ok(first > 0 && second > first, 'blocks are siblings, not nested');
});

// ── Height cap ────────────────────────────────────────────────────

test('the cap is a CSS constant, enforced by flex, and clips rather than grows', () => {
  const css = read('public/css/app.css');
  // 14rem = two app rows; the derivation lives in the comment beside it.
  assert.match(css, /--home-panel-max-h:\s*14rem/);
  const panelRule = css.match(/\.home-panel \{[^}]*\}/)[0];
  assert.match(panelRule, /max-height:\s*var\(--home-panel-max-h\)/);
  assert.match(panelRule, /flex-direction:\s*column/);
  // min-height: 0 is what lets overflow: hidden clip instead of the flex
  // item refusing to compress and pushing the article past the cap.
  const rowsRule = css.match(/\.home-panel-rows \{[^}]*\}/)[0];
  assert.match(rowsRule, /min-height:\s*0/);
  assert.match(rowsRule, /overflow:\s*hidden/);
  // 44px rows are what make the 4-slot budget exact.
  assert.match(css.match(/\.home-panel-row \{[^}]*\}/)[0], /height:\s*2\.75rem/);
  // No runtime measurement — #922 deleted that mechanism for the width
  // axis and app.css says not to bring it back.
  assert.doesNotMatch(HOME, /alignSections|--home-section-indent/);
});

test('the 14rem cap still matches the app tile it is derived from', () => {
  // 0.75rem*2 padding + 3.5rem icon + 0.5rem gap + 1.25rem title = 6.75rem
  // per row; two rows + the grid's 0.5rem gap = 14rem. If any of these
  // tokens moves, --home-panel-max-h has to move with it — that is the
  // whole point of pinning both sides here.
  const card = HOME.match(/<div class="app-card app-card-draggable[^"]*"/)[0];
  assert.match(card, /\bp-3\b/, 'app tile padding feeds the 1.5rem term');
  assert.match(card, /\bgap-2\b/, 'app tile gap feeds the 0.5rem term');
  assert.match(HOME, /class="app-icon-tile w-14 h-14/, 'icon feeds the 3.5rem term');
  assert.match(HOME, /class="font-medium text-sm truncate/, 'title feeds the 1.25rem term');
  const grid = INDEX.match(/<div id="app-list"[^>]*>/)[0];
  assert.match(grid, /\bgap-2\b/, 'the grid gap feeds the between-rows 0.5rem term');
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
// per-box .home-section-block bound (plus Home.alignSections). Each block
// has to follow that convention: a plain full-width child, no per-box
// width cap — a re-introduced wrapper would render these boxes narrower
// than the "Featured apps" card below them.
test('each block is a full-width child of the section, not separately bounded', () => {
  const populated = renderWith({ registry: [], hidden: [], panels: [panel()] }).html;
  const empty = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, done: 0, challenges: [] })] },
    { user: { id: 1, isAdmin: true } }
  ).html;
  for (const [name, html] of [['populated', populated], ['empty state', empty]]) {
    assert.doesNotMatch(html, /home-section-block/,
      `${name}: the column is the only width cap now`);
    // The bordered block IS the article — no wrapper, and the title lives
    // inside it (N widgets can't share one heading above the section).
    assert.match(html, /<article class="home-panel home-panel-card /,
      `${name}: the block is the article itself`);
    assert.match(html, /home-panel-bar/, `${name}: its own title bar`);
    assert.doesNotMatch(html, /class="home-section-header/,
      `${name}: the title moved inside the block`);
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

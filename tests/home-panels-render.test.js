// frontend/src/features/home/home-panels.js — the home screen's Challenges
// card (#911).
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
const { HOME_SRC: HOME, PANELS_SRC: SRC } = require('./helpers/home-modules');
const INDEX = read('public/index.html');
const ISLAND = read('frontend/src/features/home/index.tsx');
const SW = read('public/sw.js');
const SCHEMA = read('src/db/schema.sql');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const ROUTE = read('src/routes/home-panels.js');
const CSS = read('public/css/app.css');

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
      // The slot path clears and hides the section before painting the
      // hosts, so both spellings have to exist on the stub.
      add: (c) => makeSection._last._classes.add(c),
      remove: (c) => makeSection._last._classes.delete(c),
      contains: (c) => makeSection._last._classes.has(c),
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

// A `[data-panel-slot]` host, the shape Home.render() plants in #app-list.
// Tracks the attributes render() stamps on it so the "state on the HOST"
// contract can be asserted (see _stampState).
function makeSlot(key) {
  const attrs = { 'data-panel-slot': key };
  const classes = new Set(['hidden']);
  const slot = {
    dataset: { panelSlot: key },
    innerHTML: '',
    attrs,
    _classes: classes,
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute: (n, v) => { attrs[n] = v; },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    removeAttribute: (n) => { delete attrs[n]; },
    // Good enough for the lookups _stampState does: find the inner element
    // carrying one of the state attributes, reading it out of the HTML.
    // Attribute-selector shaped rather than hard-coded to one name, so a
    // new entry in HomePanels.STATE_ATTRS is covered the day it lands.
    querySelector: (sel) => {
      const attr = /^\[([a-z-]+)\]$/.exec(sel);
      if (!attr) return null;
      const m = new RegExp(`${attr[1]}="([^"]*)"`).exec(slot.innerHTML);
      return m ? { getAttribute: () => m[1] } : null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  return slot;
}

// The three fixed section hosts render() writes into, keyed the way it looks
// them up. `slots` is still the parameter name every test passes: THE UI
// OVERHAUL changed WHERE a block renders, not what it renders, so the hosts
// are the same stub under a different id.
const SECTION_HOST_IDS = {
  discover: 'home-discover-section',
  challenges: 'home-challenges-section',
  create: 'home-create-section',
};

function makeHomePanels({
  user = { id: 1, isAdmin: false }, search = '', home = null, slots = null,
} = {}) {
  const section = makeSection();
  makeSection._last = section;
  // Map each supplied host onto the id render() will resolve it by.
  const hosts = new Map();
  for (const slot of slots || []) {
    const key = slot.dataset && slot.dataset.panelSlot;
    if (key && SECTION_HOST_IDS[key]) hosts.set(SECTION_HOST_IDS[key], slot);
  }
  const sandbox = {
    console,
    App: { user },
    // Only when a test asks for it — the default keeps every existing test
    // exercising the module with no Home on the window, exactly as before.
    ...(home ? { Home: home } : {}),
    document: {
      getElementById: (id) => hosts.get(id) || (id === 'home-panels' ? section : null),
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

// Menu rows come back from the vm realm, whose Array fails deepStrictEqual's
// prototype check — compare the labels as one string instead.
const labels = (items) => Array.from(items, (i) => i.label).join(' | ');

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

// Render every section and hand back what they painted, joined.
//
// This used to read one node — #home-panels, the stacked fallback host below
// the grid. THE UI OVERHAUL replaced that host with three fixed section hosts
// and render() paints each directly, so "what the widgets rendered" is the
// three concatenated. Every assertion below is a substring or shape check
// over that text, so joining is faithful: it is the same markup, from the same
// renderers, in the same order.
function renderWith(data, opts = {}) {
  const hosts = ['discover', 'challenges', 'create'].map(makeSlot);
  const { HP, section, sandbox } = makeHomePanels({ ...opts, slots: hosts });
  HP._data = data;
  HP.render();
  return {
    HP,
    html: hosts.map((h) => h.innerHTML).join(''),
    hosts,
    host: (key) => hosts.find((h) => h.dataset.panelSlot === key),
    section,
    sandbox,
    // Re-paint into the SAME hosts, so a test can assert on what a second
    // render left behind (an optimistic hide that failed, say).
    rerender() {
      HP.render();
      return hosts.map((h) => h.innerHTML).join('');
    },
  };
}

// The FIVE-COLUMN width, for the shape that only exists there (#968): the
// footer with its expand toggle, the four-row budget, expansion itself. The
// harness has no innerWidth, so the column count is injected the way the
// module actually reads it — through Home.currentCols() — which is also what
// the in-grid helpers below do. Without it, currentCols() falls back to the
// PHONE shape, which is the deliberately-safe default for an unknown width.
const AT_DESKTOP = { home: { currentCols: () => 5 } };

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
// The height cap buys exactly ROW_SLOTS 40px rows. Overflow spends the
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

test('visibleSlots: overflow keeps all four row slots — the footer owns it', () => {
  const { HP } = makeHomePanels();
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const out = HP.visibleSlots(panel({ total: 9, challenges: four }));
  // The overflow affordance moved OUT of the row list into the footer's
  // expand toggle, so a fourth challenge is no longer sacrificed for it.
  assert.equal(out.rows.length, 4);
  assert.equal(out.link, false, 'no row slot is spent on overflow any more');
  assert.equal(out.total, 9, 'the footer label carries the TRUE total');
  assert.ok(out.rows.length <= HP.ROW_SLOTS);
});

test('visibleSlots: not-done rows win the slots when the cap trims', () => {
  const { HP } = makeHomePanels();
  const rows = [
    challenge({ id: 1, progress: { done: true, current: null, target: null } }),
    challenge({ id: 2 }),
    challenge({ id: 3 }),
    challenge({ id: 4 }),
    challenge({ id: 5 }),
  ];
  const out = HP.visibleSlots(panel({ total: 7, challenges: rows }));
  assert.deepEqual(out.rows.map((c) => c.id), [2, 3, 4, 5],
    'the actionable rows survive; the finished one is what gets dropped');
});

test('visibleSlots: expanded draws every row the server sent', () => {
  const { HP } = makeHomePanels();
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  HP._expanded.challenges = true;
  const out = HP.visibleSlots(panel({ total: 9, challenges: nine, expanded: true }));
  assert.equal(out.rows.length, 9, 'the row cap does not apply when expanded');
  assert.equal(out.expanded, true);
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
  // The bar hugs the row's bottom edge — that's what keeps rows uniform —
  // and is OUTLINED so an empty track still reads as a bar. Its geometry
  // is in app.css now (pinned in "the bar gets a lane…" below), derived
  // from the meter lane, so the markup carries only `absolute`.
  assert.match(html, /home-panel-bar-track absolute rounded-full/);
  assert.doesNotMatch(html, /bottom-\[3px\]/,
    'the cramped 3px-from-the-divider geometry is gone, and is no longer a utility class');
  // A FAINT outline: it describes the bar's extent without competing with
  // the violet fill, which is the actual signal.
  assert.match(html, /home-panel-bar-track[^"]*border border-zinc-300\/60/);
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
  // The 0/5 case is exactly why the track is outlined: with no fill at all,
  // the border + light interior are the only thing distinguishing an empty
  // bar from the row's hairline divider.
  assert.match(html, /home-panel-bar-track[^"]*border border-zinc-300\/60 dark:border-zinc-600\/60 bg-white dark:bg-zinc-900/);
});

// ── The bar's breathing room ──────────────────────────────────────
//
// The bar used to be centred-text-with-a-bar-jammed-underneath: half a
// pixel of line-box clearance above it, three pixels to the row divider
// below. The fix is a LANE — a strip reserved along the bottom of every
// row in the panel, which the text is padded clear of — rather than a
// taller row, because the height cap only had ~16px to give.

test('the bar gets a lane, and the lane is what holds the text off it', () => {
  const css = read('public/css/app.css');
  // The lane, and the bar's geometry derived from it. Both are variables
  // so the two clearances move together instead of drifting apart.
  assert.match(css, /--home-panel-meter-lane:\s*0\.875rem/);
  const laneRule = css.match(/\.home-panel-rows--metered \.home-panel-row \{[^}]*\}/)[0];
  assert.match(laneRule, /padding-bottom:\s*var\(--home-panel-meter-lane\)/,
    'padding on the row is what moves the TEXT up — flex centres in what is left');
  const barRule = css.match(/\.home-panel-bar-track \{[^}]*\}/)[0];
  assert.match(barRule, /bottom:\s*var\(--home-panel-bar-gap\)/);
  assert.match(barRule, /height:\s*var\(--home-panel-bar-h\)/);
  // Clear of the divider below by more than the 3px that read as cramped.
  const gapPx = parseFloat(css.match(/--home-panel-bar-gap:\s*([\d.]+)rem/)[1]) * 16;
  assert.ok(gapPx >= 5, `the bar must clear the row divider (${gapPx}px)`);
  // And the lane must be taller than the bar, or there is no gap ABOVE it.
  const lanePx = parseFloat(css.match(/--home-panel-meter-lane:\s*([\d.]+)rem/)[1]) * 16;
  const barPx = parseFloat(css.match(/--home-panel-bar-h:\s*([\d.]+)rem/)[1]) * 16;
  assert.ok(lanePx > barPx + gapPx - 1,
    `the lane (${lanePx}px) must hold the bar (${barPx}px + ${gapPx}px) clear of the text`);
  // Sideways it spans the row's TEXT column — the goal's left edge — and
  // stops short of the right corner rather than running flush into it.
  assert.match(barRule, /left:\s*1\.75rem/);
  assert.match(barRule, /right:\s*0\.75rem/);
});

test('the lane is reserved per PANEL, so every goal sits on one baseline', () => {
  // A row with no bar still gets the lane when a SIBLING has one —
  // otherwise the goals in a mixed list float at two different heights,
  // which reads as a rendering slip rather than as "this one has no bar".
  const mixed = renderWith({
    registry: [], hidden: [],
    panels: [panel({
      challenges: [
        challenge({ id: 1 }),
        challenge({
          id: 2,
          metric: { kind: 'count', label: 'Kudos', target: 5 },
          progress: { done: false, current: 2, target: 5 },
        }),
      ],
    })],
  }).html;
  assert.match(mixed, /home-panel-rows home-panel-rows--metered/);

  // …but a widget with no numeric challenge at all reserves nothing: an
  // empty strip under every row, for a bar that will never come, is just
  // a row that looks top-heavy.
  const binaryOnly = renderWith({
    registry: [], hidden: [], panels: [panel({ challenges: [challenge({ id: 1 })] })],
  }).html;
  assert.doesNotMatch(binaryOnly, /home-panel-rows--metered/);
});

test('a numeric challenge at full target draws a full bar AND the ✓', () => {
  // The state the staging seed exists to make visible (challenge 900514,
  // credited five of five). Both halves matter: a full bar with a hollow
  // ring, or a ✓ over a part-filled bar, would each be a bug.
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({
      done: 1,
      challenges: [challenge({
        goal: 'Vote on five proposals',
        metric: { kind: 'count', label: 'Proposals voted', target: 5 },
        progress: { done: true, current: 5, target: 5 },
      })],
    })],
  });
  assert.match(html, /width:100%/);
  assert.match(html, /aria-valuenow="5"[^>]*aria-valuemax="5"/);
  assert.match(html, /5\/5/);
  assert.match(html, /home-panel-glyph[^>]*text-emerald-500[^>]*>&#10003;</);
});

test('both glyph states occupy the same 10px box the bar aligns to', () => {
  // The bar's left: 1.75rem (28px) is px-2.5 (10) + glyph (10) + gap-2 (8). A ✓
  // that sized itself intrinsically would shift the goal text and
  // desynchronise the bar from it on precisely the done rows, so both
  // glyphs are pinned to w-2.5 here.
  const rows = ({ done, current }) => renderWith({
    registry: [], hidden: [], panels: [panel({
      challenges: [challenge({
        metric: { kind: 'count', label: 'Kudos', target: 5 },
        progress: { done, current, target: 5 },
      })],
    })],
  }).html;
  assert.match(rows({ done: false, current: 0 }), /home-panel-glyph shrink-0 w-2\.5 h-2\.5 rounded-full/);
  assert.match(rows({ done: true, current: 5 }), /home-panel-glyph shrink-0 w-2\.5 h-2\.5 flex/);
  // The row's own gutter and gap are the other two terms — if either
  // moves, the bar's 28px left inset has to move with it.
  assert.match(rows({ done: false, current: 0 }), /home-panel-row flex items-center gap-2 px-2\.5/);
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

test('render: the footer carries the expand toggle and the way out', () => {
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 8, challenges: four })],
  }, AT_DESKTOP);
  // Overflow now lives in the FOOTER, so all four row slots stay
  // challenges — the label carries the true total.
  assert.match(html, /home-panel-footer/);
  assert.match(html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(html, /See all 8 challenges/);
  assert.equal((html.match(/home-panel-row\b(?!s)/g) || []).length, 4);
  assert.equal((html.match(/data-challenge-id/g) || []).length, 4);
  assert.doesNotMatch(html, /home-panel-more/, 'the old link ROW is gone');
  // And the separate way out, bottom right. It NAMES its destination — the
  // Challenges TAB, which is not where the title bar's leaderboard link goes
  // (#980), so neither label may say only "leaderboard" or only "open".
  assert.match(html, /home-panel-open[^>]*title="Go to the Challenges tab on the Leaderboard screen"/);
  assert.match(html, /home-panel-open[^>]*aria-label="Open challenges"/);
  assert.doesNotMatch(html, />Open<\/span>/, 'the bare "Open" label is gone');
  assert.match(html, /aria-expanded="false"/);
});

test('render: expanded lifts the cap, shows everything, and flips the toggle', () => {
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  const hosts = ['challenges'].map(makeSlot);
  const { HP } = makeHomePanels({ slots: hosts });
  HP._data = { registry: [], hidden: [], panels: [panel({ total: 9, challenges: nine })] };
  HP._expanded.challenges = true;
  HP.render();
  const html = hosts[0].innerHTML;
  assert.match(html, /home-panel--expanded/, 'the class app.css hangs max-height: none on');
  assert.equal((html.match(/data-challenge-id/g) || []).length, 9,
    'every row the server sent, past the four-slot budget');
  assert.match(html, /Show less/, 'the same control collapses it');
  assert.match(html, /aria-expanded="true"/);
});

test('expanding stops the rows list clipping, and there is no cap left to lift', () => {
  const css = read('public/css/app.css');
  // The rows list must stop clipping, or a list longer than the flex layout
  // budgeted for would be cut instead of drawn.
  assert.match(css, /\.home-panel--expanded \.home-panel-rows \{[^}]*overflow:\s*visible/);
  assert.match(css, /\.home-panel-footer \{/);
  // `.home-panel--expanded { max-height: none }` lifted --home-panel-max-h.
  // Both went when the block became a SECTION that grows to its content —
  // there is no ceiling to lift, and the collapsed size is bounded by the
  // markup (visibleSlots draws at most ROW_SLOTS rows) instead.
  assert.doesNotMatch(css, /\.home-panel--expanded \{/);
  assert.doesNotMatch(css, /--home-panel-max-h:/);
});

test('render: the title bar carries the title, the counter and the ⋮ menu — no extra rows', () => {
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 6, done: 1, points_remaining: 3900 })],
  });
  assert.match(html, /home-panel-bar/);
  assert.match(html, /Challenges/);
  assert.match(html, /1 of 6 · 3,900 pts left/, 'the summary folds into the bar');
  assert.match(html, /home-panel-menu[^>]*data-panel-key="challenges"/);
  // The bar is flex-none so the ROWS list is what the cap compresses.
  assert.match(html, /home-panel-bar flex-none/);
});

test('render: nothing at all when signed out, unloaded, or hidden', () => {
  // Signed out. Every host stays empty AND hidden — an empty <section> with
  // its px-3 pb-3 padding would still be a gap in the stack.
  const out = renderWith({ registry: [], hidden: [], panels: [panel()] },
    { user: null });
  assert.equal(out.html, '');
  for (const host of out.hosts) {
    assert.ok(host._classes.has('hidden'), `${host.dataset.panelSlot} host hidden`);
  }

  // Data not loaded yet — absent, never a skeleton flash.
  const unloaded = renderWith(null);
  assert.equal(unloaded.html, '');

  // Dismissed by this viewer: the server omits it from `panels`.
  const hiddenOut = renderWith({ registry: [{ key: 'challenges', title: 'Challenges' }], hidden: ['challenges'], panels: [] });
  assert.equal(hiddenOut.html, '');
  assert.ok(hiddenOut.host('challenges')._classes.has('hidden'));
});

// #947 reversed the admin-only empty box. It is now a COMPACT block that
// every viewer gets: a widget that silently vanishes between seasons leaves
// the viewer unable to tell "nothing is running" from "this broke", and the
// compact block is not the full-size empty box the old comment argued
// against (it is ~68px — title bar plus one line, no footer).
test('render: the empty state renders for EVERY viewer, compact and footer-less', () => {
  const empty = panel({ total: 0, done: 0, challenges: [] });
  for (const isAdmin of [false, true]) {
    const out = renderWith({ registry: [], hidden: [], panels: [empty] },
      { user: { id: 1, isAdmin } });
    const who = isAdmin ? 'admin' : 'member';
    assert.match(out.html, /No challenges are running right now/,
      `${who}: the block says why it is quiet`);
    assert.ok(!out.host('challenges')._classes.has('hidden'), `${who}: section shown`);
    // Exactly one row, and no footer: nothing to expand, nothing to count.
    assert.equal((out.html.match(/home-panel-row\b/g) || []).length, 1, `${who}: one line`);
    assert.doesNotMatch(out.html, /home-panel-footer/, `${who}: no footer`);
    // The ⋮ menu sits at the right edge, same as the populated branch.
    assert.match(out.html, /home-panel-title[^"]*flex-1/, `${who}: title takes the bar`);
    assert.match(out.html, /data-rows="0"/, `${who}: stamped`);
    // No `panel.leaderboard` in this payload, so there is nothing to fill
    // with — the stamp says so rather than claiming rows nobody drew.
    assert.match(out.html, /data-fill="0"/, `${who}: nothing to preview`);
  }
});

// The empty payload must not leave the expand flag set: ensureLoaded() would
// keep sending ?expand=challenges, which asks for the season's FINISHED
// challenges and would repopulate a block that should read as quiet.
test('render: an empty payload clears the in-place expanded flag', () => {
  const hosts = ['challenges'].map(makeSlot);
  const { HP } = makeHomePanels({ slots: hosts });
  HP._expanded.challenges = true;
  HP._data = {
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [] })],
  };
  HP.render();
  assert.equal(HP._expanded.challenges, false);
  assert.match(hosts[0].innerHTML, /No challenges are running right now/);
});

test('setHidden drops the panel optimistically and restores it on failure', async () => {
  const out = renderWith(
    { registry: [{ key: 'challenges', title: 'Challenges' }], hidden: [], panels: [panel()] });
  assert.match(out.html, /Report a reproducible bug/);

  out.sandbox.fetch = async () => ({ ok: false, json: async () => ({}) });
  const ok = await out.HP.setHidden('challenges', true);
  assert.equal(ok, false);
  assert.deepEqual(out.HP._data.hidden, [], 'a failed write must not look like it stuck');
  assert.match(out.host('challenges').innerHTML, /Report a reproducible bug/,
    'the block is back in its own host, not just in the data');
});

// ── Container shape: one bordered block PER SECTION ───────────────
//
// The core of the per-block-container requirement: each of the three areas
// is its own bordered article in its own host, never rows inside one shared
// card. THE UI OVERHAUL is what made all three renderable at once — before
// it, only `challenges` built a payload, so the multi-block case had to be
// staged with a hypothetical second widget.

test('render: each panel is its own bordered article, in its own host', () => {
  const all = {
    registry: [
      { key: 'discover', title: 'Discover', removable: false },
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: [],
    panels: [
      panel(),
      // A key no renderer knows. renderPanel dispatches on key, so an unknown
      // one renders nothing rather than throwing — that's the degradation
      // path when the server ships a panel the client predates. It also has
      // no host of its own, which is the second half of the same guard.
      { key: 'future-widget', title: 'Rank', total: 1, done: 0, challenges: [] },
    ],
  };
  const out = renderWith(all, { home: { canCreate: () => true } });
  assert.doesNotMatch(out.html, /Rank/, 'an unknown panel key is skipped, not thrown on');

  // Every host draws, and each draws exactly ONE block — never one shared
  // card, never two stacked in the same section. Discover and Challenges are
  // bordered articles with their own title bars; Create is the dashed tile
  // it has always been (its label IS its title, so a bar above it would say
  // "Create app" twice).
  for (const key of ['discover', 'challenges']) {
    const host = out.host(key);
    assert.equal((host.innerHTML.match(/<article class="home-panel /g) || []).length, 1,
      `${key}: one bordered block`);
    assert.equal((host.innerHTML.match(/home-panel-bar/g) || []).length, 1,
      `${key}: its OWN title bar`);
    assert.ok(!host._classes.has('hidden'), `${key}: shown`);
  }
  const create = out.host('create');
  assert.equal((create.innerHTML.match(/home-create-widget/g) || []).length, 1);
  assert.ok(!create._classes.has('hidden'), 'create: shown');

  // Siblings, in the ORDER the sections are declared in — the whole point of
  // the fixed stack. Discover, then Challenges, then Create.
  assert.deepEqual(out.hosts.map((h) => h.dataset.panelSlot),
    ['discover', 'challenges', 'create']);
  assert.equal((out.html.match(/<article/g) || []).length, 2);
  const first = out.html.indexOf('</article>');
  const second = out.html.indexOf('<article', first);
  assert.ok(first > 0 && second > first, 'blocks are siblings, not nested');

  // No stack WRAPPER: each block is a direct child of its own <section>, so
  // there is nothing left for a space-y-2 to space.
  assert.doesNotMatch(out.html, /class="space-y-2"/);
});

// ── Strictly one line per row ──────────────────────────────────────
//
// The row is a FIXED height, which means a wrap is invisible in a
// screenshot: the second line overflows the box and gets clipped by the
// panel. So the constraint has to be pinned in the markup, not eyeballed.
// Every text node in a row is either `truncate` (which carries
// white-space: nowrap) or explicitly `whitespace-nowrap`, and the row
// itself declares nowrap so future children inherit it.

test('every text node in a row is single-line — no wrapping anywhere', () => {
  const p = panel({
    total: 9,
    challenges: [challenge({
      // Real production strings: multi-word goal AND multi-word prose
      // reward, the combination that wraps first.
      goal: 'Produce Every Block - June 2026',
      reward: 'Up to 6,500 pts',
      metric: { kind: 'count', label: 'Blocks produced', target: 720 },
      progress: { done: false, current: 543, target: 720 },
    })],
  });
  const { html } = renderWith({ registry: [], hidden: [], panels: [p] });

  // Pull out every <span> inside a row and require each to opt out of
  // wrapping. A new chip added without nowrap fails here.
  const rowHtml = html.slice(html.indexOf('home-panel-row'));
  const spans = rowHtml.match(/<span class="[^"]*"/g) || [];
  assert.ok(spans.length >= 3, 'goal + count + reward at least');
  for (const span of spans) {
    // The glyph, the bar's track and its fill carry no text; every span
    // that CAN hold text must opt out of wrapping.
    if (/home-panel-glyph|home-panel-bar-(fill|track)/.test(span)) continue;
    assert.match(span, /whitespace-nowrap|truncate/,
      `a row span may not wrap: ${span}`);
  }

  // The goal specifically: truncate (ellipsis) rather than clip-with-no-hint.
  assert.match(html, /home-panel-goal[^"]*min-w-0 truncate whitespace-nowrap/);
  // The reward chip is the one most likely to wrap — multi-word and shrink-0.
  assert.match(html, /shrink-0 whitespace-nowrap text-\[11px\] font-semibold/);
  // The count.
  assert.match(html, /shrink-0 whitespace-nowrap text-\[11px\] tabular-nums/);
});

test('the title bar and the footer controls are single-line too', () => {
  const data = {
    registry: [], hidden: [],
    panels: [panel({ total: 9, done: 2, points_remaining: 24300 })],
  };
  const { html } = renderWith(data, AT_DESKTOP);
  // Title + counter: the counter must not push the title to a second line.
  assert.match(html, /home-panel-title[^"]*truncate whitespace-nowrap/);
  // The summary run appended after the separator. It used to carry
  // `normal-case tracking-normal` to undo the title's small caps; the widget
  // language labels a group in sentence case at reading size, so there is no
  // small caps left to undo. `whitespace-nowrap` is the load-bearing half and
  // is what this line has always been about.
  assert.match(html, /<span class="whitespace-nowrap"> · /);
  // The bar carries the way out BESIDE that title (#968, now the leaderboard
  // link of #980), so it is the one place a long summary and a control
  // compete for the same row: the control is shrink-0 and nowrap, and the
  // title truncates around it. The label used to shorten to "Leaderboard" in
  // the one-cell phone shape; a section's bar fits the full one at every
  // width, so _leaderboardLink no longer takes a flag.
  assert.match(html, /home-panel-lb-browse shrink-0[^"]*whitespace-nowrap/);
  assert.match(html, /<span class="whitespace-nowrap">Open leaderboard<\/span>/);
  // Both footer labels — the expand toggle and the "Open challenges" button.
  // Neither may wrap: the footer is a fixed-height flex row, so a wrap would
  // be clipped exactly like a wrapped row.
  assert.match(html, /<span class="whitespace-nowrap">See all 9 challenges<\/span>/);
  assert.match(html, /<span class="whitespace-nowrap">Open challenges<\/span>/);
  assert.match(html, /home-panel-expand[^>]*whitespace-nowrap/);
  assert.match(html, /home-panel-open[^>]*whitespace-nowrap/);
});

test('the row declares nowrap and clips, so a wrap cannot ship unnoticed', () => {
  const css = read('public/css/app.css');
  const rowRule = css.match(/\.home-panel-row \{[^}]*\}/)[0];
  assert.match(rowRule, /white-space:\s*nowrap/,
    'declared on the row so every child inherits it');
  assert.match(rowRule, /overflow:\s*hidden/,
    'a chip that still overflows is clipped, not spilled onto the next row');
});

// ── The placement is gone ─────────────────────────────────────────
//
// Each block used to be a real item of #app-list: a multi-cell tile the
// viewer could drop anywhere on the launcher canvas, with a per-breakpoint
// footprint table and a persisted cell. THE UI OVERHAUL replaced all of it
// with three fixed sections in a fixed order — so what these pin is that the
// machinery is really gone, on both sides, rather than left half-wired.

test('the placement membership API is gone from the module', () => {
  const { HP } = makeHomePanels();
  HP._data = {
    registry: [
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'discover', title: 'Discover', removable: false },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: [],
    panels: [panel()],
  };
  // `gridSlotKeys()` answered "which widgets does HomeLayout have to place
  // for this viewer", and `hasLayoutRegistry()` told home.js the footprints
  // had arrived so a derived layout was safe to persist. Nothing is placed
  // now and nothing waits on a registry, so both are dead weight — as is
  // `renderAll()`, which joined the blocks into the retired #home-panels
  // stack, and `setPosition()`, which wrote a widget's cell.
  for (const dead of ['gridSlotKeys', 'hasLayoutRegistry', 'setPosition', 'renderAll']) {
    assert.equal(typeof HP[dead], 'undefined', `${dead} should be gone`);
  }
  // The registry itself STAYS — it is still what says a block exists at all,
  // which is how the marker blocks (`discover`, `create`, which build no
  // payload) render.
  assert.ok(HP.panelFor('discover'), 'the registry still makes a marker renderable');
});

// The create block is on EVERY home screen. Quota decides whether it is
// tappable, never whether it exists — this is the regression guard for the
// old "absent for non-creators" behaviour.
test('the create block renders regardless of app quota', () => {
  for (const canCreateApps of [true, false]) {
    const out = renderWith(
      { registry: [{ key: 'create', title: 'Create app', removable: true }],
        hidden: [], panels: [] },
      { home: { canCreate: () => canCreateApps, CREATE_DISABLED_HINT: 'hint' } });
    const host = out.host('create');
    assert.ok(!host._classes.has('hidden'), `quota=${canCreateApps}: shown`);
    assert.match(host.innerHTML, new RegExp(`data-create-enabled="${canCreateApps}"`),
      `quota=${canCreateApps}: the state is the DIFFERENCE, not the presence`);
  }
  // Nothing in the server registry may consult a viewer's quota either.
  const registrySrc = ROUTE.match(/const PANEL_REGISTRY = \[[\s\S]*?\n\];/)[0];
  assert.doesNotMatch(registrySrc, /canCreateApps|app_quota|quota/i,
    'the registry takes no viewer argument — presence is never permission-gated');
});

// A hidden widget is genuinely absent; an un-buildable one still renders if
// the registry knows it (that is how the marker widgets work at all).
test('panelFor prefers a built payload and falls back to the registry', () => {
  const { HP } = makeHomePanels();
  HP._data = {
    registry: [
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: ['challenges'],
    panels: [],
  };
  assert.equal(HP.panelFor('challenges'), null, 'hidden means absent');
  assert.equal(HP.panelFor('create').title, 'Create app', 'marker widget still renders');
  assert.equal(HP.panelFor('nope'), null, 'unknown key renders nothing');
});

test('Discover cannot be hidden, from either end', async () => {
  const { HP, sandbox } = makeHomePanels();
  const calls = [];
  sandbox.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; };
  HP._data = {
    registry: [
      { key: 'discover', title: 'Discover', removable: false },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: [],
    panels: [],
  };
  assert.equal(HP.isRemovable('discover'), false);
  assert.equal(HP.isRemovable('create'), true);
  // The client refuses the write outright — no request is even attempted.
  assert.equal(await HP.setHidden('discover', true), false);
  assert.equal(calls.length, 0);
  // ...and its menu carries no Hide row to reach it with.
  assert.doesNotMatch(labels(HP.menuItems('discover')), /Hide widget/);
  assert.match(labels(HP.menuItems('create')), /Hide widget/);
  // The server refuses it too — the client guard is UX, not the enforcement.
  assert.match(ROUTE, /removable === false && req\.body && req\.body\.hidden === true/);
  assert.match(ROUTE, /This widget cannot be hidden/);
});

test('home.js places every item at an explicit cell, with no flow fallback', () => {
  // Each item carries its own grid-column / grid-row. Inline, because the
  // page's Tailwind is the CDN JIT and a per-cell arbitrary class would be
  // generated at runtime — a tile visibly jumping into place.
  assert.match(HOME, /grid-column:\$\{item\.col \+ 1\}\/span \$\{w\};grid-row:\$\{item\.row \+ 1\}\/span \$\{h\}/);
  // ONE layout array, and it is app tiles all the way down now.
  assert.match(HOME, /HomeLayout\.canvasItems\(layout\)/);
  assert.match(HOME, /HomeLayout\.overflowItems\(layout\)/);
  // The widget HOST the renderer used to plant in a cell is gone — the three
  // sections are in the shell's own markup, outside #app-list.
  assert.doesNotMatch(HOME, /data-panel-slot="\$\{escapeHtml\(item\.key\)\}"/);
  // Class-shaped, not the bare name: the comment explaining what the branch
  // used to resolve is the one mention that should survive.
  assert.doesNotMatch(HOME, /class="home-panel-slot|'\.home-panel-slot'/);
});

test('the placement recognizer owns the grid, and the flow reorder is gone', () => {
  assert.match(HOME, /unNative\.attachGridPlacement\(listEl, \{/);
  // App tiles ALONE are draggable now: a fixed section has no cell to move
  // to, and `.home-panel-slot` went with the hosts that carried it.
  assert.match(HOME, /itemSelector: '\.app-card\[data-yours\]:not\(\[data-demo\]\)'/);
  assert.doesNotMatch(HOME, /data-create-enabled[^\n]*itemSelector/);
  // The flow model and its persistence are gone in their entirety. Matched
  // as DEFINITIONS / call sites rather than as bare names, so the comments
  // that explain why each was removed don't trip the guard.
  for (const dead of [
    /unNative\.attachReorder\(listEl/,
    /^  _onKitCardDrop\(/m,
    /^  classifyCardDrop\(/m,
    /^  buildYoursOrder\(/m,
    /^  _syncPanelSlotPosition\(/m,
    /^  _onCardPointerDown\(/m,
    /fetch\('\/api\/favorites\/order'/,
    /HomePanels\?\.setPosition/,
    // …and the widget half of the placement, retired by THE UI OVERHAUL.
    /HomePanels\?\.gridSlotKeys/,
    /HomePanels\?\.hasLayoutRegistry/,
  ]) {
    assert.doesNotMatch(HOME, dead, `${dead} should be gone from home.js`);
  }
});

test('a drop writes the whole width through PUT /api/home-layout', () => {
  const place = HOME.match(/_onGridPlace\(el, cell, cols\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(place, /HomeLayout\.place\(/);
  assert.match(place, /if \(!next\) return;/, 'an illegal drop persists nothing');
  assert.match(place, /_rerenderPending = true/, 'repaint is deferred to onSettle');
  assert.match(place, /_persistLayout\(cols, next\)/);
  const persist = HOME.match(/async _persistLayout\(cols, layout\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(persist, /'\/api\/home-layout'/);
  assert.match(persist, /method: 'PUT'/);
  assert.match(persist, /HomeLayout\.toWire\(layout\)/);
  // A failed write reverts to server truth rather than leaving the grid
  // showing an arrangement that was never saved.
  assert.match(persist, /_ensureLayoutLoaded\(\{ force: true \}\)/);
});

// A derivation is not a claim: visiting at a width you have never dragged at
// must not silently write a layout for it, or a phone visit would overwrite
// the arrangement the viewer made on their laptop.
test('only a stored layout is repaired in place; a derivation is not persisted', () => {
  const cur = HOME.match(/currentLayout\(cols\) \{[\s\S]*?\n {2}\},/)[0];
  // A pre-overhaul DESKTOP arrangement lived under '5'. Seeding from it is
  // what stops four columns everywhere reading as "my home screen was reset".
  assert.match(cur, /Home\._layouts\['5'\]/, 'the retired 5-column width seeds it');
  assert.match(cur, /HomeLayout\.deriveDefault\(/, 'reading order is the last resort');
  // The `widgetsReady` gate went with the widgets: it existed because a
  // layout load that beat /api/home-panels saw an empty widget list and would
  // have persisted a repair erasing the viewer's widget cells. Nothing on the
  // canvas depends on a second endpoint any more.
  assert.doesNotMatch(cur, /const widgetsReady|hasLayoutRegistry\?\.\(\)/);
  assert.match(cur, /if \(changed && Array\.isArray\(stored\) && stored\.length\)/,
    'only a stored width is repaired in place');
});

test('the drag overlay draws the whole canvas and doubles as the hit-test', () => {
  const show = HOME.match(/_showGridOverlay\(listEl, cols, liftedEl\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(show, /HomeLayout\.MAX_ROWS/, 'every row of the canvas, not just the used ones');
  assert.match(show, /data-cell="\$\{col\},\$\{row\}"/);
  // The cells ARE the hit-test surface — that is why the overlay is real DOM.
  assert.match(HOME, /closest\('\[data-cell\]'\)/);
  // The layer never eats taps; the cells re-enable them.
  assert.match(CSS, /\.home-grid-overlay \{[^}]*pointer-events: none/);
  assert.match(CSS, /\.home-grid-cell \{[^}]*pointer-events: auto/);
  // Tiles paint above it. App tiles ALONE, since THE UI OVERHAUL: the widget
  // hosts that shared these two selectors are fixed sections outside the grid.
  assert.match(CSS, /#app-list > \.app-card \{[^}]*z-index: 1/);

  // ...and are TRANSPARENT TO HIT-TESTING for the duration of a lift. This is
  // the regression guard for the bug that made occupied cells undroppable:
  // the overlay's cells sit below the tiles, so with tiles still taking
  // pointer events elementFromPoint returned a TILE for every occupied cell,
  // cellFromPoint returned null, and both "drop onto another app" and "move a
  // widget over its own footprint" silently sprang back.
  assert.match(CSS,
    /#app-list\.un-reordering > \.app-card \{[^}]*pointer-events: none/);
  // The gap between cells belongs to no cell, so each one's hit area bleeds
  // into it — otherwise a pointer resting on a seam resolves to nothing.
  assert.match(CSS, /\.home-grid-cell::before \{[^}]*inset: -4px/);
});

// A gesture-only surface is invisible to the before/after captures and to
// every declared check, so it needs a URL.
test('the overlay and the locked create tile are both URL-reachable', () => {
  assert.match(HOME, /shot !== 'home-grid'/);
  // Re-painted on EVERY render, unlike ?shot=card-menu's once-only flag: the
  // grid's innerHTML is replaced whenever a payload lands, which wipes the
  // overlay with it. An overlay is idempotent decoration; a menu is not.
  assert.doesNotMatch(HOME, /_shotGridDone/);
  assert.match(HOME, /if \(Home\._dragActive\) return; \/\/ a real gesture owns the overlay/);
  // It also sets .un-reordering, so the link renders the state the CSS keys
  // the tiles' pointer-events:none off — making the hit-test regression
  // (occupied cells undroppable) visible from a URL rather than only from a
  // real gesture nothing can navigate to.
  assert.match(HOME, /listEl\.classList\.add\('un-reordering'\)/);
  const canCreate = HOME.match(/canCreate\(\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(canCreate, /'shot'\) === 'create-disabled'/);
  // Pure UI state: neither link writes anything or is env-gated, so the
  // production "before" side works the moment this ships.
  assert.doesNotMatch(canCreate, /fetch|IS_STAGING/);
});

// ── The title bar is not a handle any more ────────────────────────
//
// It was one, and the affordance was spread over three files: `select-none`
// and a "Drag to move this widget" tooltip in the markup, `cursor: grab` /
// `grabbing` in app.css, and a pointerdown guard in _wire that stopped a
// press on any control inside the block from arming the grid's recognizer
// (which listened on #app-list and saw the event by bubbling). THE UI
// OVERHAUL fixed the blocks into sections outside #app-list, so none of it
// can work — and a bar that advertises a drag it cannot do is worse than one
// that says nothing.

test('the bar no longer advertises a drag it cannot do', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.doesNotMatch(html, /title="Drag to move this widget"/);
  assert.doesNotMatch(html, /home-panel-bar[^>]*select-none/);
  // The ⠿ grip went two rounds earlier, and must not come back with the
  // gesture gone: it would advertise the same lie in a different glyph.
  assert.doesNotMatch(html, /⠿/);
  assert.doesNotMatch(html, /home-panel-grip/);
});

test('the grab cursor is gone from app.css, and stays gone', () => {
  const css = read('public/css/app.css');
  // Declaration-shaped: the comment recording what was removed, and why, is
  // the one mention that should survive.
  assert.doesNotMatch(css, /cursor:\s*grab(bing)?;/,
    'nothing on this screen is grabbable by its title bar any more');
  // user-select: none STAYS — the bar is not a text surface, and a
  // double-click selecting "CHALLENGES · 1 of 6" is noise either way.
  assert.match(css.match(/\.home-panel-bar \{[^}]*\}/)[0], /user-select:\s*none/);
  // A control is still a control.
  assert.match(css, /\.home-panel-bar button \{[^}]*cursor:\s*pointer/);
});

test('the block wires no drag recognizer of its own', () => {
  const wire = SRC.match(/_wire\(section\) \{[\s\S]*?\n {2}\},/)[0];
  assert.doesNotMatch(wire, /'pointerdown'/,
    'no recognizer can see these sections, so nothing has to be stopped from it');
  // …and none was bolted on to replace what was removed. (HTML5
  // `draggable="false"` on an <img> is the opposite of a recognizer — it
  // suppresses the browser's own drag — so it is not what this guards.)
  assert.doesNotMatch(SRC, /attach(Reorder|GridPlacement)\(|draggable="true"|'dragstart'/);
});

// ── The widget menu ───────────────────────────────────────────────
//
// Replaces the bare ✕: a destructive control with no undo, one press away on
// a block whose whole job is to sit quietly on the home screen.

test('the ⋮ button is a real touch target with menu semantics', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  const btn = html.match(/<button[^>]*home-panel-menu[\s\S]*?<\/button>/)[0];
  assert.match(btn, /un-touch-target/, 'the kit pads a small glyph out to a finger');
  assert.match(btn, /aria-haspopup="menu"/);
  assert.match(btn, /aria-label="Widget options"/);
  assert.doesNotMatch(html, /home-panel-hide/, 'the ✕ is gone, not merely restyled');
});

test('the menu offers the destination and a deliberate hide', () => {
  const { HP, sandbox } = makeHomePanels();
  HP._data = { registry: [{ key: 'challenges', title: 'Challenges' }], hidden: [], panels: [panel()] };

  const items = HP.menuItems('challenges');
  // Joined rather than deep-equalled: the module runs in a vm realm, so its
  // arrays fail deepStrictEqual's prototype check. BOTH destinations are here
  // (#980) — the widget has two, and each row names the screen it opens.
  assert.equal(labels(items), 'Open challenges | Open leaderboard | Hide widget');
  assert.equal(items[2].destructive, true, 'hiding is the destructive row');
  assert.ok(!items[0].destructive);
  assert.ok(!items[1].destructive);

  // Both destination rows are real hash navigations, so the device back
  // gesture returns here.
  items[0].handler();
  assert.equal(sandbox.location.hash, '#leaderboard/challenges');
  items[1].handler();
  assert.equal(sandbox.location.hash, '#leaderboard');

  // The last row is exactly what the ✕ did — persisted, and still restorable
  // from Settings → Home screen widgets.
  const calls = [];
  sandbox.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; };
  items[2].handler();
  assert.equal(Array.from(HP._data.hidden).join(), 'challenges');
  assert.deepEqual(calls, ['/api/home-panels/challenges/visibility']);

  // A future widget with no destination still gets a working menu rather
  // than a row that goes nowhere.
  assert.equal(labels(HP.menuItems('future-widget')), 'Hide widget');
});

test('openMenu goes through the kit\'s ADAPTIVE menu — one call site, both idioms', () => {
  const { HP, sandbox } = makeHomePanels();
  HP._data = { registry: [], hidden: [], panels: [panel()] };
  const anchor = { tagName: 'BUTTON' };

  // The repo wrapper is preferred (platform-ui.js: "New menu call sites
  // should use PlatformUI.menu()"), and it is the kit's action-sheet-on-touch
  // / anchored-popover-on-desktop menu underneath — no branching here.
  const seen = [];
  sandbox.PlatformUI = { menu: (o) => { seen.push(o); return Promise.resolve(null); } };
  HP.openMenu('challenges', anchor);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].anchorEl, anchor, 'the anchor is what makes it a popover on desktop');
  assert.equal(seen[0].title, 'Challenges', 'the sheet needs a heading; a popover ignores it');
  assert.equal(labels(seen[0].items), 'Open challenges | Open leaderboard | Hide widget');
  assert.match(read('public/js/platform-ui.js'), /unNative[\s\S]{0,400}?\.menu\(/);

  // Kit but no wrapper (a page that loads native.js directly).
  delete sandbox.PlatformUI;
  const direct = [];
  sandbox.unNative = { menu: (o) => { direct.push(o); return Promise.resolve(null); } };
  HP.openMenu('challenges', anchor);
  assert.equal(direct.length, 1);

  // No kit at all: send the press where the rows go rather than swallowing
  // it. Hiding stays reachable in Settings.
  delete sandbox.unNative;
  sandbox.location.hash = '';
  HP.openMenu('challenges', anchor);
  assert.equal(sandbox.location.hash, '#leaderboard/challenges');
});

// ── Height cap ────────────────────────────────────────────────────

// THE HEIGHT CAP IS GONE, and this is the regression guard for putting one
// back. `--home-panel-max-h` (two app-grid cells plus the gap, 16rem) with
// .home-panel-rows' overflow: hidden made a block CLIP inside the rectangle
// it occupied on the launcher canvas. A section has no rectangle, and the
// collapsed size is bounded by the MARKUP — visibleSlots() draws at most
// ROW_SLOTS challenge rows and the footer's "See all N" is the way past them.
//
// Re-introducing it would clip the standings preview the Challenges area now
// exists to show: four rows plus the chrome plus a three-row fill is ~350px,
// well past the 256px the cap allowed.
test('the block sizes to its content — no height cap to clip the fill', () => {
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /--home-panel-max-h:/);
  const panelRule = css.match(/\.home-panel \{[^}]*\}/)[0];
  assert.doesNotMatch(panelRule, /max-height/);
  assert.match(panelRule, /flex-direction:\s*column/);
  // Uniform rows are what make the slot budgets exact, and the height is a
  // variable so the budget comment beside them has one number to check.
  assert.match(css.match(/\.home-panel-row \{[^}]*\}/)[0],
    /height:\s*var\(--home-panel-row-h\)/);
  assert.match(css, /--home-panel-row-h:\s*2\.5rem/);
  // The collapsed block a viewer actually gets — four challenge rows AND the
  // three-row fill — is what a re-introduced 16rem cap would cut.
  const rowPx = parseFloat(css.match(/--home-panel-row-h:\s*([\d.]+)rem/)[1]) * 16;
  const footerPx = parseFloat(
    css.match(/\.home-panel-footer \{[^}]*min-height:\s*([\d.]+)rem/)[1]) * 16;
  const rowSlots = Number(SRC.match(/ROW_SLOTS:\s*(\d+)/)[1]);
  const fillSlots = Number(SRC.match(/FILL_SLOTS:\s*(\d+)/)[1]);
  const collapsed = 2 + 25.5 + (rowSlots + fillSlots) * rowPx + 16 + footerPx + 1;
  assert.ok(collapsed > 256,
    `the collapsed block is ${collapsed}px — past the 16rem the old cap allowed`);
  // No runtime measurement — #922 deleted that mechanism for the width
  // axis and app.css says not to bring it back.
  assert.doesNotMatch(HOME, /alignSections|--home-section-indent/);
});

// The width cap is GONE. It was --home-panel-max-w, half of .home-column
// (512px of 1024px), and it was right while a block was a WIDGET sharing the
// launcher canvas with app icons: a challenges row is one short line plus two
// small chips, and stretching it to 1024px left a lonely reward chip pinned
// to the far right. These are the screen's AREAS now, stacked under a
// full-width app grid, and a half-width Discover under it reads as a
// rendering fault rather than as restraint.
test('the blocks span the whole column — no half-width cap', () => {
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /--home-panel-max-w:|var\(--home-panel-max-w\)/);
  assert.doesNotMatch(css.match(/\.home-panel \{[^}]*\}/)[0], /max-width/);
  // The column above them is the one width bound, and it is unchanged.
  assert.match(css.match(/\.home-column \{[^}]*\}/)[0], /max-width:\s*64rem/);
  // Still left-aligned, and never centred by auto side margins: the blocks'
  // left edge lines up with the grid's first column above them.
  assert.doesNotMatch(css.match(/\.home-panel \{[^}]*\}/)[0], /margin(-left|-right)?:\s*auto/);
});

// The drag slot's own rules went with it: a max-width so the lift ghost
// matched the widget's real width, and a no-margin rule (a margin adds to a
// grid item's OUTER height, so a row-span-2 slot would have demanded
// 14rem + margin from two 6.75rem rows and stretched every card sharing
// them). Nothing spans rows any more.
test('the grid host and its row-spanning rules are gone', () => {
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /^\.home-panel-slot[\s,{]/m);
  // Rule-shaped and anchored: the comments recording what each rule did, and
  // why it went, are the mentions that should survive.
  assert.doesNotMatch(css, /^#app-list[^{;\n]*\.home-panel-slot[^{;\n]*\{/m);
  // What STAYS is the app tiles' own top-alignment: rows are a fixed height
  // whenever tiles alone define them, so this is a no-op today — and it is
  // still the rule that keeps a card from stretching to a track that is NOT a
  // tile row, which the half-cell blank rows of #975 still are.
  assert.match(css, /#app-list > \.app-card \{[^}]*align-self:\s*start/);
});

test('the cell height still matches the app tile it is derived from', () => {
  // p-3 (0.75rem x 2) + 3.5rem icon + 0.375rem gap + 1.625rem name (two
  // 13px lines, #951) + 0.75rem caption lane = 7.75rem per cell; two cells
  // + the grid's 0.5rem gap = 16rem — the figure the retired height cap was
  // derived from. --home-cell-h still drives the grid's rows and the drag
  // overlay's cells, which is why both sides are pinned here.
  const card = HOME.match(/<div class="app-card app-card-draggable[^"]*"/)[0];
  assert.match(card, /\bp-3\b/, 'app tile padding feeds the 1.5rem term');
  assert.match(card, /\bgap-1\.5\b/, 'app tile gap feeds the 0.375rem term');
  assert.match(HOME, /class="app-icon-tile w-14 h-14/, 'icon feeds the 3.5rem term');
  assert.match(HOME, /class="app-card-title"/, 'name feeds the 1.625rem term');
  // …and the two label lanes are FIXED heights in app.css, so a one-line
  // and a two-line title produce identically sized tiles.
  const titleRule = CSS.match(/\.app-card-title \{[^}]*\}/)[0];
  assert.match(titleRule, /height:\s*1\.625rem/, 'the title lane is exactly two lines');
  assert.match(titleRule, /line-height:\s*0\.8125rem/);
  assert.match(titleRule, /-webkit-line-clamp:\s*2/, 'long names ellipsise at two lines');
  assert.match(CSS.match(/\.app-card-status \{[^}]*\}/)[0], /line-height:\s*0\.75rem/);
  // THE CAPTION LANE IS LOAD-BEARING. The status dot is gone from the tile
  // face, so this line is a tile's only status signal — and rows are a
  // fixed height, so a caption with no budget paints over the tile below
  // instead of growing its own row.
  assert.match(HOME, /warningHtml = statusLabel/);
  assert.match(CSS, /THE CAPTION LANE IS NOT OPTIONAL/);
  const grid = INDEX.match(/<div id="app-list"[^>]*>/)[0];
  assert.match(grid, /\bsm:gap-2\b/, 'the grid gap feeds the between-rows 0.5rem term');
  // The phone variant tightens the tile and shrinks the cell in step —
  // and the tightening has to OUT-SPECIFY Tailwind's own p-3 utility,
  // since tailwind.css is linked after app.css (see the rule's comment).
  assert.match(grid, /\bp-2\b/);
  assert.match(CSS, /\.app-card\.app-card \{ padding: 0\.5rem; \}/);
  assert.match(CSS, /--home-cell-h: 7\.25rem/);
  // …and the phone cap override is GONE with the cap itself (#968 introduced
  // it: a block's phone footprint was a single grid row, so a two-cell cap
  // would have let an oversized text size paint the article over the app
  // tiles below it). The blocks are sections outside the grid now — they
  // overlap nothing and they size to their own content.
  assert.doesNotMatch(CSS, /--home-panel-max-h:/);
});

// ── Source pins ───────────────────────────────────────────────────

// THE FOUR AREAS, in the shell's own markup and in this order: Your apps,
// Discover, Challenges, Create app. That order is the whole shape of the
// screen, so it is pinned against the built document rather than left to the
// island's source.
test('index.html stacks the three section hosts below the grid, in order', () => {
  const grid = INDEX.indexOf('id="app-list"');
  assert.ok(grid > 0, 'the launcher grid is there');
  const at = (id) => INDEX.indexOf(`id="${id}"`);
  const order = ['home-discover-section', 'home-challenges-section', 'home-create-section'];
  let prev = grid;
  for (const id of order) {
    const here = at(id);
    assert.ok(here > 0, `${id} is in the document`);
    assert.ok(here > prev, `${id} sits below what precedes it`);
    prev = here;
  }
  // Outside the grid, or its wholesale re-render would destroy all three.
  assert.ok(INDEX.indexOf('id="app-list"', 0) < at('home-discover-section'));
  assert.doesNotMatch(INDEX.slice(grid, at('home-discover-section')), /<\/section>[\s\S]*<div id="app-list"/);

  // Each host names the block it is for, which is what the dapp.json checks
  // and the screenshot assertions select on.
  for (const key of ['discover', 'challenges', 'create']) {
    assert.match(INDEX, new RegExp(`data-panel-slot="${key}"`), `${key} host is named`);
  }

  // #home-panels — the widgets' stacked FALLBACK host — is gone with the
  // placement it existed for. It caught the moment before the first grid
  // paint and the active-search view, because a widget that lived IN the grid
  // vanished whenever the grid did; the three sections never do.
  assert.equal(INDEX.indexOf('id="home-panels"'), -1);
  // …as are the two trailing sections THOSE replaced, two rounds ago.
  assert.equal(INDEX.indexOf('id="home-find-more"'), -1);
  assert.equal(INDEX.indexOf('id="home-featured-list"'), -1);
  assert.equal(INDEX.indexOf('id="home-create-body"'), -1);
});

// #922 centred the whole feed in a 1024px .home-column and DELETED the
// per-box .home-section-block bound (plus Home.alignSections). Each block
// has to follow that convention: a plain full-width child, no per-box
// width cap — a re-introduced wrapper would render these boxes narrower
// than the "Featured apps" card below them.
test('each block is a full-width child of the section, not separately bounded', () => {
  const populated = renderWith({ registry: [], hidden: [], panels: [panel()] }).html;
  const empty = renderWith(
    { registry: [], hidden: [], panels: [panel({ total: 0, done: 0, challenges: [] })] }
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

test('the module is evaluated before home.js and precached with the bundle', () => {
  // This used to read two <script src> positions out of public/index.html.
  // #1083 chunk F step 4 moved both modules into the React bundle, so the
  // order is the home island's import list and the precached asset is the
  // bundle entry. The contract is the same one: home.js calls into HomePanels.
  const panels = ISLAND.indexOf("'./home-panels.js'");
  const home = ISLAND.indexOf("'./home.js'");
  assert.ok(panels > 0 && home > 0);
  assert.ok(panels < home, 'home.js calls into HomePanels');
  assert.match(SW, /'\/shell\/assets\/shell\.js'/);
  // ...and the retired tag is gone from both halves, not just one.
  assert.doesNotMatch(INDEX, /\/js\/home-panels\.js/);
  assert.doesNotMatch(SW, /\/js\/home-panels\.js/);
});

test('home.js loads the panels once per TTL and paints them on every render', () => {
  assert.match(HOME, /HomePanels\?\.ensureLoaded\(\)/);
  assert.match(HOME, /HomePanels\?\.render\(\)/);
});

// The "Home screen widgets" settings section is GONE. It was a list of
// checkboxes for showing or hiding each widget — an affordance that only made
// sense while the blocks were optional furniture a viewer arranged. They are
// three fixed areas of the screen now, in a fixed order, so there is nothing
// to toggle; the ⋮ menu on a block is still the way to dismiss one.
test('Settings no longer offers the Home screen widgets section', () => {
  // Code-shaped, not the bare name: the comment recording what was removed
  // (and why the endpoint stayed) is the one mention that should survive.
  assert.doesNotMatch(SETTINGS, /key: 'home-panels'/);
  assert.doesNotMatch(SETTINGS, /^\s{4}_renderHomePanelsSection\(/m);
  assert.doesNotMatch(SETTINGS, /^\s{4}async _saveHomePanelVisibility\(/m);
  assert.doesNotMatch(SETTINGS, /settings-home-panels-list/);
  assert.equal(INDEX.indexOf('data-settings-section="home-panels"'), -1);
  assert.equal(INDEX.indexOf('id="settings-home-panels-list"'), -1);
  // The per-user hidden set stays — the ⋮ menu still writes it, and the
  // server still filters `panels` by it (see setHidden above).
  assert.match(ROUTE, /home_panels_hidden/);
});

test('the per-user hidden set defaults to "everything visible"', () => {
  assert.match(SCHEMA, /home_panels_hidden TEXT\[\] NOT NULL DEFAULT '\{\}'/);
});

// ── The widgets can actually SEE Home ─────────────────────────────────
//
// home-panels.js reads the Home module through `window.Home && …` — the
// same defensive shape it uses for `window.App`. `const Home = {…}` at the
// top of a script lands in the global LEXICAL scope, which is NOT `window`,
// so unless home.js publishes itself every one of those guards takes the
// "not loaded" branch — silently, forever. That shipped: the Discover widget
// always drew its empty-state note instead of the curated tiles, and the
// Create widget always drew LOCKED regardless of quota.
//
// Nothing threw and nothing logged, which is exactly why it needs a test.
//
// #1083 chunk F step 4 moved both modules into the React bundle, where the
// hazard is IDENTICAL but the publication is now conditional
// (`if (typeof window !== 'undefined')`, for the prerender pass) — so the
// corpus below has to cover the bundle's feature modules as well as the
// classic scripts, or this test would go quiet the moment a publisher moved.

test('every window.<global> the widgets read is actually published', () => {
  // Derive the list from the source rather than hard-coding it, so a NEW
  // `window.Whatever` guard added later is covered the day it lands.
  const referenced = new Set(
    Array.from(SRC.matchAll(/\bwindow\.([A-Z][A-Za-z0-9_]*)/g), (m) => m[1])
  );
  assert.ok(referenced.has('Home'), 'the module does read window.Home');

  // Every browser module the shell ships — the remaining classic scripts AND
  // the bundle's feature modules — so the publisher can be anywhere.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|ts|tsx)$/.test(e.name) ? [full] : [];
  });
  const shell = [
    ...walk(path.join(__dirname, '..', 'public', 'js')),
    ...walk(path.join(__dirname, '..', 'frontend', 'src')),
  ].map((full) => fs.readFileSync(full, 'utf8')).join('\n');

  for (const name of referenced) {
    assert.match(shell, new RegExp(`window\\.${name}\\s*=`),
      `home-panels.js guards on window.${name}, but nothing assigns it — `
      + 'that guard can only ever take the "missing" branch');
  }
});

test('the Discover widget renders the curated tiles when Home is reachable', () => {
  const featured = [
    { slug: 'alpha', name: 'Alpha', icon_emoji: '🅰', featured: true },
    { slug: 'beta', name: 'Beta', featured: true },
  ];
  const { HP } = makeHomePanels({
    home: { featuredApps: () => featured, isYours: () => false, _apps: featured },
  });
  const html = HP.renderDiscoverPanel({ key: 'discover', title: 'Discover' });
  assert.match(html, /home-discover-tiles/, 'the tile row, not the empty note');
  assert.match(html, /class="app-card home-discover-tile[^"]*" data-slug="alpha"/);
  assert.match(html, /Browse all apps/, 'and the browse control is always there');
  assert.doesNotMatch(html, /Nothing featured right now/);

  // With Home genuinely absent it still renders — the note, not a crash.
  const bare = makeHomePanels().HP
    .renderDiscoverPanel({ key: 'discover', title: 'Discover' });
  assert.match(bare, /Nothing featured right now/);
  assert.match(bare, /Browse all apps/);
});

// ── Discover: ONE shape, at every width ───────────────────────────────
//
// It used to be two (#949). The widget's grid footprint was asymmetric — 4x1
// on a phone, 2x2 on desktop — so the content followed: a phone got the
// curated lane and nothing else, because the second lane would not fit the
// one row it owned. THE UI OVERHAUL made Discover a fixed full-width section,
// so both lanes render everywhere, and the `Home.currentCols()` stub these
// tests used to pick a side no longer decides anything.

const discoverHome = (over = {}) => ({
  featuredApps: () => [{ slug: 'alpha', name: 'Alpha', featured: true }],
  popularApps: () => [{ slug: 'pop', name: 'Popular One', active_users: 9 }],
  isYours: () => false,
  _apps: [],
  ...over,
});

const renderDiscover = (over) => makeHomePanels({ home: discoverHome(over) }).HP
  .renderDiscoverPanel({ key: 'discover', title: 'Discover' });

test('Discover draws the Popular lane at every width', () => {
  const html = renderDiscover();
  assert.match(html, /home-discover-popular/, 'the second lane always renders');
  assert.match(html, /data-slug="pop"/);
  assert.match(html, /home-discover-divider/, 'with a hairline and its caption');
  assert.match(html, />Popular</);
  assert.match(html, /data-slug="alpha"/, 'and the curated lane leads');
  // The lane order is the point of the area: what an admin chose to feature
  // first, then what everyone else is actually using.
  assert.ok(html.indexOf('data-slug="alpha"') < html.indexOf('data-slug="pop"'));

  // Nothing in the renderer consults the column count any more — the whole
  // reason the module's own currentCols() helper is gone.
  assert.doesNotMatch(SRC, /renderDiscoverPanel[\s\S]{0,900}currentCols/);
});

test('Discover never draws a footer; the browse control is in the title bar', () => {
  const html = renderDiscover();
  assert.doesNotMatch(html, /home-panel-footer/);
  // The button is inside the bar. Discover has ONE destination, so it belongs
  // beside the title rather than in 27px of chrome under two lanes.
  assert.match(html, /home-panel-bar[\s\S]*?id="home-browse-btn"[\s\S]*?home-panel-menu/,
    'browse sits between the title and the ⋮');
  // ...and in the empty branch too — it is THE discovery path.
  const empty = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(empty, /home-panel-bar[\s\S]*?id="home-browse-btn"/);
});

test('Discover’s degenerate states: which lane, which note', () => {
  // Featured only: no divider, no second lane.
  const featuredOnly = renderDiscover({ popularApps: () => [] });
  assert.match(featuredOnly, /data-slug="alpha"/);
  assert.doesNotMatch(featuredOnly, /home-discover-divider/,
    'no popular apps means no caption row, not an empty one');
  assert.doesNotMatch(featuredOnly, /Nothing featured right now/);

  // Popular only — the reporter's case: everything featured is already
  // theirs, so the top lane is the note and the second lane fills the box.
  const popularOnly = renderDiscover({ featuredApps: () => [] });
  assert.match(popularOnly, /Nothing featured right now/);
  assert.match(popularOnly, /home-discover-popular/);
  assert.match(popularOnly, /data-slug="pop"/);

  // Neither: one centred line and nothing else.
  const neither = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(neither, /Nothing featured right now/);
  assert.doesNotMatch(neither, /home-discover-tiles/);
  assert.doesNotMatch(neither, /home-discover-divider/);
});

test('Discover stamps both lane counts, and render() mirrors them onto the host', () => {
  assert.match(renderDiscover(), /data-featured="1"/);
  assert.match(renderDiscover(), /data-popular="1"/);
  const empty = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.match(empty, /data-featured="0"/);
  assert.match(empty, /data-popular="0"/);

  // The checks select on [data-panel-slot="discover"][data-featured="0"],
  // so the value has to reach the HOST, not just the article inside it.
  const slot = makeSlot('discover');
  const { HP } = makeHomePanels({
    home: discoverHome({ featuredApps: () => [], popularApps: () => [] }),
    slots: [slot],
  });
  HP._data = { registry: [{ key: 'discover', title: 'Discover', removable: false }],
    hidden: [], panels: [{ key: 'discover', title: 'Discover' }] };
  HP.render();
  assert.equal(slot.getAttribute('data-featured'), '0');
  assert.equal(slot.getAttribute('data-popular'), '0');

  // A widget that stamps neither leaves the host clean rather than keeping a
  // stale value from a previous paint.
  const other = makeSlot('challenges');
  other.setAttribute('data-featured', '3');
  const h2 = makeHomePanels({ slots: [other] });
  h2.HP._data = { registry: [{ key: 'challenges', title: 'Challenges', removable: true }],
    hidden: [], panels: [{ key: 'challenges', title: 'Challenges', challenges: [], total: 0 }] };
  h2.HP.render();
  assert.equal(other.hasAttribute('data-featured'), false);
});

// A lane whose tiles were never wired looks IDENTICAL in a screenshot while
// every tap and every + badge in it is dead — so this is asserted on the
// source, which is where the singular querySelector bug would live.
test('_wire hands EVERY discovery lane to Home._wireDiscoveryCards', () => {
  assert.match(SRC, /querySelectorAll\('\.home-discover-tiles'\)[\s\S]{0,220}?_wireDiscoveryCards\(tiles\)/);
  assert.doesNotMatch(SRC, /querySelector\('\.home-discover-tiles'\)/,
    'singular would wire the featured lane and leave Popular inert');
});

test('the Create widget reads the viewer’s quota through Home', () => {
  const enabled = makeHomePanels({ home: { canCreate: () => true } }).HP
    .renderCreatePanel({ key: 'create' });
  assert.match(enabled, /data-create-enabled="true"/);
  assert.doesNotMatch(enabled, /aria-disabled/);

  const locked = makeHomePanels({ home: { canCreate: () => false } }).HP
    .renderCreatePanel({ key: 'create' });
  assert.match(locked, /data-create-enabled="false"/);
  assert.match(locked, /aria-disabled="true"/);
  assert.doesNotMatch(locked, /\sdisabled[=\s>]/, 'never the disabled ATTRIBUTE');
});

// ONE shape. The block used to be 4x1 below 640px and 1x1 at/above it
// (PANEL_REGISTRY `sizes`), so its CONTENT flipped at the same breakpoint:
// icon beside label in the full-width phone row, icon above label in the
// single desktop cell. THE UI OVERHAUL made it a full-width section at every
// width, so only the row shape is left — the stacked variant existed for a
// ~150px cell that no longer exists.
test('the Create block lays out as a row at every width', () => {
  const html = makeHomePanels({ home: { canCreate: () => true } }).HP
    .renderCreatePanel({ key: 'create' });
  const btn = html.match(/class="home-create-btn[^"]*"/)[0];
  assert.match(btn, /\bflex-row\b/, 'icon beside label');
  assert.doesNotMatch(btn, /\bsm:flex-col\b/, 'and never stacked again at 640px');
  assert.match(btn, /\bitems-center\b/);
  assert.match(btn, /\bjustify-center\b/);
  // The label keeps the wide row's size at every width now, rather than
  // stepping down for the cell.
  assert.match(html, /home-create-label[^"]*\btext-sm\b/);
  assert.doesNotMatch(html, /home-create-label[^"]*sm:text-xs/);
  // `h-full` went with the rectangle: there is nothing to fill, so the block
  // is as tall as its own padding.
  assert.doesNotMatch(btn, /\bh-full\b/);
});

// The state has to end up on the HOST. The widget stamps it on markup that
// is painted INSIDE the [data-panel-slot] host, so a selector written the
// way the spec describes it — and the way the dapp.json checks and the
// screenshot assertions write it —
// `[data-panel-slot="create"][data-create-enabled="true"]` asks for both
// attributes on ONE element and matched nothing at all.
test('render() mirrors the create state onto the [data-panel-slot] host', () => {
  const slot = makeSlot('create');
  const { HP } = makeHomePanels({ home: { canCreate: () => true }, slots: [slot] });
  HP._data = { registry: [{ key: 'create', title: 'Create app', removable: true }],
    hidden: [], panels: [{ key: 'create', title: 'Create app' }] };
  HP.render();
  assert.equal(slot.getAttribute('data-create-enabled'), 'true',
    'the host carries the state the checks select on');
  assert.match(slot.innerHTML, /class="home-create-btn/);

  const locked = makeSlot('create');
  const h2 = makeHomePanels({ home: { canCreate: () => false }, slots: [locked] });
  h2.HP._data = { registry: [{ key: 'create', title: 'Create app', removable: true }],
    hidden: [], panels: [{ key: 'create', title: 'Create app' }] };
  h2.HP.render();
  assert.equal(locked.getAttribute('data-create-enabled'), 'false');

  // A widget with no such state leaves the host clean rather than inheriting
  // a stale value from a previous paint.
  const other = makeSlot('challenges');
  other.setAttribute('data-create-enabled', 'true');
  const h3 = makeHomePanels({ slots: [other] });
  h3.HP._data = { registry: [{ key: 'challenges', title: 'Challenges', removable: true }],
    hidden: [], panels: [{ key: 'challenges', title: 'Challenges', challenges: [], total: 0 }] };
  h3.HP.render();
  assert.equal(other.hasAttribute('data-create-enabled'), false);
});

// The three selectors the checks actually run, asserted against the exact
// strings in dapp.json so a markup change and the check can't drift apart.
test('dapp.json’s home-widget checks describe markup this module emits', () => {
  const declared = JSON.parse(read('dapp.json')).tests || [];
  const find = (frag) => declared.find((t) => (t.expectSelector || '').includes(frag));

  const create = find('[data-panel-slot="create"][data-create-enabled="true"]');
  assert.ok(create, 'the enabled-create check is declared');
  assert.match(create.expectSelector, /\.home-create-btn/);
  assert.match(makeHomePanels({ home: { canCreate: () => true } }).HP
    .renderCreatePanel({ key: 'create' }), /class="home-create-btn/);

  // ONE Discover check covers the populated widget (#949). It selects the
  // SECOND lane, which only exists once the whole block has painted, so it
  // is strictly stronger than the featured-lane selector it replaced — and
  // the checks run at the desktop viewport, which is the breakpoint that
  // draws two lanes at all.
  const discover = find('[data-panel-slot="discover"] .home-panel');
  assert.ok(discover, 'the discover check is declared');
  for (const cls of ['home-panel', 'home-discover-popular', 'app-card']) {
    assert.ok(discover.expectSelector.includes(cls), cls);
  }
  assert.equal(discover.expectText, 'Browse all apps');
  const desktop = renderDiscover();
  assert.ok(desktop.includes('home-discover-popular') && desktop.includes('app-card'),
    'and this module emits both classes that selector chains');
  // The tile-face invariant rides along on this selector rather than having
  // a check of its own — it dates from when the manifest parsed only the
  // first MAX_TESTS entries and a slot was a real cost. #1019 runs every
  // declared check, so a separate entry would be free now; folding it in is
  // still the tighter assertion (one navigation proves both), so it stays.
  assert.match(discover.expectSelector, /:not\(:has\(\.users-badge\)\)/);
  assert.doesNotMatch(desktop, /users-badge/,
    'a discovery tile states popularity by its rank, not by a badge');

  // The empty state's check selects on the mirrored host attribute plus the
  // browse control, and asserts the note's own copy.
  const bare = find('[data-panel-slot="discover"][data-featured="0"]');
  assert.ok(bare, 'the empty-state check is declared');
  assert.match(bare.path, /shot=discover-empty/, 'reached by the deep link, not by luck');
  assert.match(bare.expectSelector, /\.home-panel-browse/);
  const emptyHtml = renderDiscover({ featuredApps: () => [], popularApps: () => [] });
  assert.ok(emptyHtml.includes('data-featured="0"'), 'the widget stamps it');
  assert.ok(emptyHtml.includes('home-panel-browse'), 'and still offers the browse control');
  assert.ok(emptyHtml.includes(bare.expectText), `the note says "${bare.expectText}"`);
});

// The one-cell phone budget and the two-cell desktop budget, derived by hand
// in app.css and pinned here exactly as that comment instructs — a token
// moved on one side without the other mis-sizes the widget silently.
test('the Discover lanes fit the cells their footprint buys', () => {
  const css = read('public/css/app.css');
  // Six explicit tracks, one per tile either lane can produce. auto-fill
  // followed the pixel width and wrapped to a second (clipped) row in a
  // 640-800px window.
  assert.match(css, /\.home-discover-tiles \{[^}]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(HOME, /FEATURED_LIMIT: 6/);
  assert.match(HOME, /POPULAR_LIMIT: 6/, 'the lane cap equals the track count');
  // Both lanes split anything spare instead of the first one taking it — but
  // from a CONTENT basis (`1 1 auto`), not the `1 1 0` a fixed tile could
  // afford. A zero basis in a section is circular: each lane contributed 0 to
  // the height the article asked for, so the article collapsed to its title
  // bar and both lanes clipped their tiles in half.
  assert.match(css, /\.home-discover-lane \{[^}]*flex: 1 1 auto/);
  assert.match(css, /\.home-discover-tiles \{[^}]*align-content: center/);
  // The fluid icon caps at the 40px the tile always drew at — and the CAP
  // is on the WRAPPER. On the icon itself, `width: 100%` resolves against a
  // shrink-to-fit parent (the tile is `flex-col items-center`), which is
  // circular: the icons rendered at whatever their glyph measured — 12px for
  // an emoji, 30px for an image — instead of a uniform 40px.
  assert.match(css, /\.home-discover-icon-wrap \{[^}]*width: 100%/);
  assert.match(css, /\.home-discover-icon-wrap \{[^}]*max-width: 2\.5rem/);
  assert.match(css, /\.home-discover-icon \{[^}]*aspect-ratio: 1 \/ 1/);
  assert.match(SRC, /class="home-discover-icon-wrap relative"/,
    'and the markup gives that wrapper its class');

  // .app-card's own padding must NOT apply to a discovery tile: the lane
  // supplies the inset, and inheriting the launcher tile's 8px added 16px
  // per tile — enough to put the phone widget at 116px of a 116px cell,
  // with no room left for a larger system text size. The selector is two
  // classes deep because .app-card's padding is declared later in the file.
  assert.match(css, /\.home-discover-tiles \.home-discover-tile \{[^}]*padding: 0/);

  // THE HEIGHT IS A SUM, not a budget any more. Both lanes used to have to
  // fit inside a rectangle — one grid cell on a phone, the 16rem height cap
  // on desktop — and this asserted they did. The block is a section that
  // grows to its content now, so the same arithmetic describes what it DRAWS:
  //
  //   border 2 + title bar 27 + lane 72 + divider 19 + lane 72 = 192px
  //
  // Kept because the terms are still real tokens that can drift apart, and
  // because a lane that stops summing (a zero flex basis, say) collapses the
  // article and clips the tiles — which is exactly what shipped once.
  const bar = 27;      // py-1 8 + 18 line + 1px rule
  const lane = 72;     // 8 + 40 icon + 4 gap + 12 caption + 8
  const divider = 19;  // 1px rule + the ~18px "Popular" caption row
  assert.equal(2 + bar + lane + divider + lane, 192);
  assert.match(css, /\+ second lane\s+=\s+72px/, 'and app.css shows the same sum');
  // No ceiling either lane could be clipped by.
  assert.doesNotMatch(css, /--home-panel-max-h:/);
});

// ── The breakpoint split (#947) ────────────────────────────────────
//
// One widget, two renderings. On a PHONE it sizes to content (a CSS-only
// concern, asserted against app.css below). On DESKTOP it keeps its fixed
// two-row tile and spends the leftover on a LEADERBOARD section, which is a
// MARKUP concern and so is decided here.
//
// The harness has no innerWidth, so the column count is injected the way the
// module actually reads it: through Home.currentCols().
function makeDesktop(data, opts = {}) {
  const slot = makeSlot('challenges');
  const { HP, sandbox } = makeHomePanels({
    ...opts,
    slots: [slot],
    home: { currentCols: () => opts.cols || 5, ...(opts.home || {}) },
  });
  HP._data = data;
  HP.render();
  return { HP, html: slot.innerHTML, slot, sandbox };
}

// The board as src/routes/home-panels.js sends it: a `kind`, a `label`, rows
// carrying a display `name` and a server-decided `you` flag. This one is the
// PRIMARY board — the Topochain standings, five-figure points and all.
const fill = (over = {}) => ({
  kind: 'topochain',
  label: 'Leaderboard',
  event: { id: 77, name: 'Block Production Sprint' },
  top: [
    { rank: 1, name: 'ada', score: 59146, you: false },
    { rank: 2, name: 'grace', score: 27515, you: false },
    { rank: 3, name: 'linus', score: 918, you: false },
  ],
  viewer: { rank: 7, name: 'me', score: 640, you: true },
  total: 42,
  ...over,
});

// The FALLBACK board, for a deployment with no public standings at all.
const kudosFill = (over = {}) => fill({
  kind: 'kudos',
  label: 'Kudos',
  event: null,
  top: [
    { rank: 1, name: 'ada', score: 41, you: false },
    { rank: 2, name: 'grace', score: 27, you: false },
    { rank: 3, name: 'linus', score: 18, you: false },
  ],
  viewer: { rank: 7, name: 'me', score: 6, you: true },
  ...over,
});

const withFill = (panelOver = {}) => ({
  registry: [], hidden: [],
  panels: [panel({ leaderboard: fill(), ...panelOver })],
});

// THE FILL'S BUDGET IS A CONSTANT. It was `4 - max(challengeRows, 1)` — the
// leftover of the 201.5px inside a 2x2 tile's height cap, so 3 rows at zero
// or one challenge and 0 at four. THE UI OVERHAUL made the block a section
// that grows and made the standings preview the POINT of the Challenges area
// (the hamburger's Leaderboard row is gone), and four open challenges is the
// ORDINARY case — CHALLENGE_ROW_LIMIT is all the server sends — so
// subtraction meant the standings were usually absent from the one place
// that shows them.
test('fillSlots: a constant, whatever the challenge rows cost', () => {
  const { HP } = makeHomePanels();
  assert.equal(HP.FILL_SLOTS, 3, 'the head of the board plus the viewer');
  assert.equal(HP.fillSlots(), 3);
  // …and it takes no argument now. Called with the old one, it must not go
  // back to subtracting.
  assert.equal(HP.fillSlots(4), 3);
  assert.equal(HP.fillSlots(0), 3);
});

test('the standings preview draws under the rows, at every list length', () => {
  for (const nChallenges of [1, 2, 3, 4]) {
    const rows = Array.from({ length: nChallenges }, (_, i) => challenge({ id: i + 1 }));
    const { html } = makeDesktop(withFill({ challenges: rows, total: nChallenges }));
    const drawn = (html.match(/home-panel-lb-row/g) || []).length;
    assert.equal(drawn, 3, `${nChallenges} challenges → the fill is still 3 rows`);
    assert.match(html, new RegExp(`data-rows="${nChallenges}"`));
    assert.match(html, new RegExp('data-fill="3"'));
    const labels = (html.match(/home-panel-fill-label/g) || []).length;
    assert.equal(labels, 1, 'exactly one label');
  }
});

test('desktop: the zero state leads with the note, then fills the tile', () => {
  const { html } = makeDesktop({
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [], leaderboard: fill() })],
  });
  assert.match(html, /No challenges are running right now/, 'same copy at both widths');
  assert.match(html, /data-rows="0"/);
  assert.match(html, /data-fill="3"/);
  // Nothing to expand or count: one footer control, and it names THE BOARD it
  // is the full version of — the title bar's link is what says "leaderboard"
  // now (#980), so the two must not read as the same door twice.
  assert.doesNotMatch(html, /home-panel-expand/);
  assert.match(html, /home-panel-lb-open/);
  assert.match(html, /See full standings/);
  assert.doesNotMatch(html, /See full leaderboard/);
  // …and the bar carries the widget's leaderboard link in this state too.
  assert.match(html, /home-panel-lb-browse[^>]*aria-label="Open leaderboard"/);
});

test('desktop: the viewer’s own row is last, marked, and never duplicated', () => {
  const { html } = makeDesktop(withFill({ challenges: [challenge()], total: 1 }));
  assert.match(html, /home-panel-lb-you/, 'the viewer is tinted');
  // Names in the FILL block only — the challenge rows above it share the
  // .home-panel-goal lane, which is the point (the two lists line up).
  const namesIn = (h) => [...h.slice(h.indexOf('home-panel-fill-label'))
    .matchAll(/home-panel-goal[^>]*>([^<]+)</g)].map((m) => m[1]);
  // Top 2 then "You" — the last slot belongs to the viewer.
  assert.deepEqual(namesIn(html), ['ada', 'grace', 'You']);
  assert.equal((html.match(/home-panel-lb-you/g) || []).length, 1);

  // Already in the top slice: highlighted in place (the SERVER flags which
  // row is theirs), and the freed slot goes to the next entry down rather
  // than repeating them.
  const base = fill();
  const inTop = makeDesktop(withFill({
    challenges: [challenge()],
    total: 1,
    leaderboard: fill({
      top: base.top.map((r, i) => ({ ...r, you: i === 1 })),
      viewer: { rank: 2, name: 'grace', score: 27515, you: true },
    }),
  }));
  assert.deepEqual(namesIn(inTop.html), ['ada', 'You', 'linus']);
  assert.equal((inTop.html.match(/home-panel-lb-you/g) || []).length, 1);
});

test('desktop: the standings board names itself and shortens its points', () => {
  const { html } = makeDesktop(withFill({ challenges: [challenge()], total: 1 }));
  const block = html.slice(html.indexOf('home-panel-fill-label'));
  assert.match(block, /home-panel-fill-label[^>]*>Leaderboard</, 'labelled from the payload');
  // Five-figure points are shortened so the name lane survives; small ones
  // are left alone.
  assert.match(block, />59\.1k</, '59,146 renders as 59.1k');
  assert.match(block, />640</, 'a three-digit score is not shortened');
  assert.match(block, /by points in Block Production Sprint/, 'the tooltip names the metric');
  assert.match(html, /data-fill-kind="topochain"/);
});

test('desktop: the kudos fallback says Kudos, and keeps the kudos copy', () => {
  const { html } = makeDesktop(withFill({
    challenges: [challenge()], total: 1, leaderboard: kudosFill(),
  }));
  const block = html.slice(html.indexOf('home-panel-fill-label'));
  assert.match(block, /home-panel-fill-label[^>]*>Kudos</,
    'the fallback board must not call itself the Leaderboard');
  assert.match(block, />41</, 'kudos counts are never abbreviated');
  assert.match(block, /by kudos on merged proposals/);
  assert.match(html, /data-fill-kind="kudos"/);
});

// Most viewers have no standings row at all — the slot goes to one more
// participant rather than to an invented rank.
test('desktop: a board with no viewer row spends every slot on the top', () => {
  const namesIn = (h) => [...h.slice(h.indexOf('home-panel-fill-label'))
    .matchAll(/home-panel-goal[^>]*>([^<]+)</g)].map((m) => m[1]);
  const { html } = makeDesktop(withFill({
    challenges: [challenge()], total: 1, leaderboard: fill({ viewer: null }),
  }));
  assert.deepEqual(namesIn(html), ['ada', 'grace', 'linus']);
  assert.equal((html.match(/home-panel-lb-you/g) || []).length, 0);
});

// A podium-excluded row carries no rank; the screen's table draws those as
// an em dash, so the fill does too rather than printing "#0".
test('desktop: a rank-less row renders an em dash, not a zero', () => {
  const { html } = makeDesktop(withFill({
    challenges: [challenge()], total: 1,
    leaderboard: fill({ viewer: { rank: null, name: 'me', score: 99999, you: true } }),
  }));
  const youRow = html.slice(html.indexOf('home-panel-lb-you'));
  assert.match(youRow.slice(0, 700), /home-panel-glyph[^>]*>—</);
  assert.match(youRow, /You are unranked of 42 by points/);
});

test('desktop: a zero-score viewer row is muted, not a violet chip', () => {
  const { html } = makeDesktop(withFill({
    challenges: [challenge()],
    total: 1,
    leaderboard: kudosFill({ viewer: { rank: 300, name: 'me', score: 0, you: true } }),
  }));
  const youRow = html.slice(html.indexOf('home-panel-lb-you'));
  assert.doesNotMatch(youRow.slice(0, 600), /text-violet-600/, '0 is not an accent-coloured shout');
  assert.match(youRow, /You are #300 of 42 by kudos on merged proposals/);
});

// The fill used to be suppressed at three widths and states: on a phone
// (where the block owned one 116px cell), in the #home-panels search-view
// fallback (no fixed-height rectangle to fill), and while expanded. The first
// two went with the placement — the fill IS the point of the Challenges area
// now, at every width — so expansion is the only thing left that stands it
// down, plus the obvious case of a server that sent no board.
test('the fill draws at every width; only expansion and an absent board stop it', () => {
  const data = withFill({ challenges: [challenge()], total: 1 });

  // No Home on the window at all — the width is unknown and it does not
  // matter, because nothing about the block is a width decision any more.
  const anyWidth = renderWith(data);
  assert.equal((anyWidth.html.match(/home-panel-lb-row/g) || []).length, 3);
  assert.match(anyWidth.html, /data-fill="3"/);

  // Expanded is all challenges — a standings preview under thirty rows is
  // not a preview, so the fill steps aside.
  const slot = makeSlot('challenges');
  const { HP } = makeHomePanels({ slots: [slot] });
  HP._expanded.challenges = true;
  HP._data = data;
  HP.render();
  assert.equal((slot.innerHTML.match(/home-panel-lb-row/g) || []).length, 0);

  // And no fill when the server sent no board at all (the block still
  // renders — the challenge rows are its primary content).
  const noBoard = renderWith({
    registry: [], hidden: [],
    panels: [panel({ challenges: [challenge()], total: 1 })],
  });
  assert.equal((noBoard.html.match(/home-panel-lb-row/g) || []).length, 0);
  assert.match(noBoard.html, /data-fill="0"/);
  assert.match(noBoard.html, /Report a reproducible bug/);
});

// `HomePanels.currentCols()` — the module's own read of the grid's column
// count, with a phone fallback for an unknown width — is gone. It existed
// only to choose between the two renderings, and there is one now.
test('the module no longer reads the column count at all', () => {
  const { HP } = makeHomePanels();
  assert.equal(typeof HP.currentCols, 'undefined');
  assert.doesNotMatch(SRC, /^\s*DESKTOP_COLS:/m);
  assert.doesNotMatch(SRC, /^\s*PHONE_ROW_SLOTS:/m);
});

test('fill rows are excluded from the challenges click wiring', () => {
  // The row handler must not sweep up leaderboard rows — they go to the
  // Leaderboard screen, not to the Challenges tab.
  assert.match(SRC, /querySelectorAll\('\.home-panel-row:not\(\.home-panel-lb-row\)'\)/);
  assert.match(SRC, /goToLeaderboard/);
});

// Each board previews a DIFFERENT tab, and every clickable element of the
// fill carries which one on data-lb-kind (that is what _wire reads).
test('the fill navigates to the tab that shows the board it previewed', () => {
  const std = makeDesktop(withFill({ challenges: [challenge()], total: 1 }));
  std.HP.goToLeaderboard('topochain');
  assert.equal(std.sandbox.location.hash, '#leaderboard',
    'the standings ARE the primary tab, so they address as the bare hash');
  std.HP.goToLeaderboard('kudos');
  assert.equal(std.sandbox.location.hash, '#leaderboard/users',
    'the kudos fallback goes to the Kudos tab’s Top users view');
  // An absent kind is the primary board — the same default the renderer uses.
  std.HP.goToLeaderboard(undefined);
  assert.equal(std.sandbox.location.hash, '#leaderboard');

  // Every control the wiring hangs off must carry the kind.
  for (const m of std.html.match(/home-panel-lb-(?:row|open)[^>]*>/g) || []) {
    assert.match(m, /data-lb-kind="topochain"/, m.slice(0, 60));
  }
  const zero = makeDesktop({
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [], leaderboard: kudosFill() })],
  });
  assert.match(zero.html, /home-panel-lb-open[^>]*data-lb-kind="kudos"/,
    'the zero-state footer follows its rows');
  assert.match(SRC,
    /goToLeaderboard\((?:row|btn)\.dataset\.lbKind\)/);
});

// ── The phone shape (#968) is gone ────────────────────────────────
//
// It was a whole second rendering of the Challenges block, and everything in
// it was a concession to ONE 116px grid cell: two rows instead of four, no
// footer (its 27px WAS the second row), the way out moved into the title bar,
// no leaderboard fill, a shortened "Leaderboard" label, and `_expanded`
// forcibly ignored because a lifted height cap in a one-cell footprint would
// have dropped an expanded season on top of the app tiles below.
//
// THE UI OVERHAUL made the block a full-width section that sizes to its own
// content, so there is no cell to fit into and the full shape is right at
// every width. What used to be the desktop-only rendering is now simply the
// rendering — which is what these assert, at no particular width.

test('the block draws all four rows, its footer and its toggle — at any width', () => {
  const four = Array.from({ length: 4 }, (_, i) => challenge({ id: i + 1 }));
  const { html } = renderWith({
    registry: [], hidden: [], panels: [panel({ total: 8, challenges: four })],
  });
  assert.equal((html.match(/data-challenge-id/g) || []).length, 4);
  assert.match(html, /data-rows="4"/, 'data-rows reports what is DRAWN');
  assert.match(html, /home-panel-footer/);
  assert.match(html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(html, /See all 8 challenges/);
  assert.match(html, /home-panel-open[^>]*aria-label="Open challenges"/,
    'the footer keeps the Challenges-tab door; the bar carries the leaderboard');
  // The bar's leaderboard link (#980) with the LONG label — the compact
  // "Leaderboard" existed only for the one-cell bar.
  assert.match(html, /home-panel-bar[\s\S]*?home-panel-lb-browse[\s\S]*?home-panel-menu/,
    'inside the bar, before the ⋮ menu');
  assert.match(html, /home-panel-lb-browse[^>]*title="Open the Leaderboard screen"/);
  assert.match(html, /<span class="whitespace-nowrap">Open leaderboard<\/span>/);
  assert.match(SRC, /querySelectorAll\('\.home-panel-lb-browse'\)/, 'and that class is wired');
  assert.doesNotMatch(SRC, /'Leaderboard' : 'Open leaderboard'/,
    'the two-label branch went with the shape that needed the short one');
});

test('the empty state is the bar, its one note row, and the fill', () => {
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 0, done: 0, challenges: [], leaderboard: fill() })],
  });
  assert.match(html, /No challenges are running right now/, 'it still says why');
  assert.match(html, /data-rows="0"/);
  // Between seasons the standings are the only thing this area has to show,
  // so the fill spends the whole budget on them (fillSlots(0) === 3).
  assert.equal((html.match(/home-panel-lb-row/g) || []).length, 3);
  assert.match(html, /data-fill="3"/);
  // Still no expand toggle — there is nothing to expand — but the fill's own
  // footer offers the board it previewed.
  assert.doesNotMatch(html, /home-panel-expand/);
  assert.match(html, /home-panel-lb-open/);
});

test('an expansion is honoured at every width now', () => {
  // `_expanded` is per-visit CLIENT state and survives a resize. The phone
  // branch had to IGNORE it: a lifted height cap in a 116px cell would have
  // painted an expanded season over the app tiles below. A section grows.
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  const slot = makeSlot('challenges');
  const { HP } = makeHomePanels({ slots: [slot] });
  HP._expanded.challenges = true;
  HP._data = { registry: [], hidden: [], panels: [panel({ total: 9, challenges: nine })] };
  HP.render();
  assert.match(slot.innerHTML, /home-panel--expanded/,
    'the class app.css hangs max-height: none on');
  assert.equal((slot.innerHTML.match(/data-challenge-id/g) || []).length, 9);
});

// The per-cell BUDGETS the phone shape was designed against went with it:
// `PHONE_ROW_SLOTS` (two rows against a 116px cell), the registry `sizes`
// footprint table that made the cell one cell, `FIT_ROW_FLOOR` (the smallest
// block the widget ever drew, reserved as a grid row's floor) and the
// `.home-panel--fit` hook that released the block from its slot's stretch.
// What is left is the collapsed CEILING, which is the same at every width.
test('the per-cell budgets and their hooks are gone', () => {
  const css = read('public/css/app.css');
  // Code-shaped (anchored at the start of a line), so the comments that
  // record what was removed, and why, survive.
  assert.doesNotMatch(SRC, /^\s*PHONE_ROW_SLOTS:/m);
  assert.doesNotMatch(SRC, /'home-panel--fit'/);
  assert.doesNotMatch(css, /^\s*\.home-panel--fit\s*\{/m);
  assert.doesNotMatch(HOME, /FIT_ROW_FLOOR/);
  // The registry keeps the blocks and their titles; the per-breakpoint
  // footprint each one claimed is what went.
  assert.doesNotMatch(ROUTE, /sizes:/);

  // …and so is the collapsed CEILING, which was the last thing in this file
  // still sized against a grid rectangle. See 'the block sizes to its content'
  // above for why re-introducing it would clip the standings preview.
  assert.doesNotMatch(css, /--home-panel-max-h:/);
});

test('app.css: the body wrapper and fill block carry the budget’s geometry', () => {
  const css = read('public/css/app.css');
  // The body takes the article's remaining height and clips...
  const body = css.match(/\.home-panel-body \{[^}]*\}/)[0];
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow:\s*hidden/);
  // ...and both children hold their natural height, so the leftover collects
  // at the BOTTOM of the tile rather than splitting it down the middle.
  assert.match(css, /\.home-panel-body > \.home-panel-rows \{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.home-panel-fill \{[^}]*flex:\s*0 0 auto/);
  // 16px is the figure the fillSlots budget spends on the label.
  assert.match(css, /\.home-panel-fill-label \{[^}]*height:\s*1rem/);
});

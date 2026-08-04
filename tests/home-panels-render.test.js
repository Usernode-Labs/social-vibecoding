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
  });
  // Overflow now lives in the FOOTER, so all four row slots stay
  // challenges — the label carries the true total.
  assert.match(html, /home-panel-footer/);
  assert.match(html, /home-panel-expand[^>]*data-panel-key="challenges"/);
  assert.match(html, /See all 8 challenges/);
  assert.equal((html.match(/home-panel-row\b(?!s)/g) || []).length, 4);
  assert.equal((html.match(/data-challenge-id/g) || []).length, 4);
  assert.doesNotMatch(html, /home-panel-more/, 'the old link ROW is gone');
  // And the separate way out, bottom right. It NAMES its destination:
  // "Open" sat beside a control that also opens something (this block, in
  // place), leaving the reader to work out which one left the home screen.
  assert.match(html, /home-panel-open[^>]*title="Go to the Challenges tab on the Leaderboard screen"/);
  assert.match(html, /home-panel-open[^>]*aria-label="Go to leaderboard"/);
  assert.doesNotMatch(html, />Open<\/span>/, 'the bare "Open" label is gone');
  assert.match(html, /aria-expanded="false"/);
});

test('render: expanded lifts the cap, shows everything, and flips the toggle', () => {
  const nine = Array.from({ length: 9 }, (_, i) => challenge({ id: i + 1 }));
  const { HP, section } = makeHomePanels();
  HP._data = { registry: [], hidden: [], panels: [panel({ total: 9, challenges: nine })] };
  HP._expanded.challenges = true;
  HP.render();
  const html = section.innerHTML;
  assert.match(html, /home-panel--expanded/, 'the class app.css hangs max-height: none on');
  assert.equal((html.match(/data-challenge-id/g) || []).length, 9,
    'every row the server sent, past the four-slot budget');
  assert.match(html, /Show less/, 'the same control collapses it');
  assert.match(html, /aria-expanded="true"/);
});

test('the expanded cap lift and the footer are declared in CSS', () => {
  const css = read('public/css/app.css');
  const rule = css.match(/\.home-panel--expanded \{[^}]*\}/)[0];
  assert.match(rule, /max-height:\s*none/);
  // The rows list must stop clipping too, or expanding would reveal
  // nothing past the old cap.
  assert.match(css, /\.home-panel--expanded \.home-panel-rows \{[^}]*overflow:\s*visible/);
  assert.match(css, /\.home-panel-footer \{/);
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
    'each block carries its OWN title bar and ⋮ menu');
  // Siblings: one article must close before the next opens (no nesting).
  const first = pair.indexOf('</article>');
  const second = pair.indexOf('<article', first);
  assert.ok(first > 0 && second > first, 'blocks are siblings, not nested');
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
  const { html } = renderWith({
    registry: [], hidden: [],
    panels: [panel({ total: 9, done: 2, points_remaining: 24300 })],
  });
  // Title + counter: the counter must not push the title to a second line.
  assert.match(html, /home-panel-title[^"]*truncate whitespace-nowrap/);
  assert.match(html, /normal-case tracking-normal whitespace-nowrap/);
  // Both footer labels — the expand toggle and the "Go to leaderboard"
  // button. Neither may wrap: the footer is a fixed-height flex row, so a
  // wrap would be clipped exactly like a wrapped row. The right-hand label
  // is the longer of the two now, which is why this pin matters more than
  // it did when it read "Open".
  assert.match(html, /<span class="whitespace-nowrap">See all 9 challenges<\/span>/);
  assert.match(html, /<span class="whitespace-nowrap">Go to leaderboard<\/span>/);
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

// ── Drag position within the app grid ─────────────────────────────
//
// The block is a multi-cell item of #app-list — two columns wide, two rows
// tall from md up — so app icons flow around it iOS-widget style and it can
// be dropped BESIDE a card as well as between rows. The kit's existing
// attachReorder carries it; only the persisted index is new.

test('gridSlotKeys places every widget the viewer has not hidden', () => {
  const { HP } = makeHomePanels();
  // The REGISTRY is the authority, not the built payload: `discover` and
  // `create` are marker widgets that build nothing, so a keys list derived
  // from `panels` would never give them a cell.
  HP._data = {
    registry: [
      { key: 'challenges', title: 'Challenges', removable: true },
      { key: 'discover', title: 'Discover', removable: false },
      { key: 'create', title: 'Create app', removable: true },
    ],
    hidden: [],
    panels: [panel()],
  };
  assert.equal(HP.gridSlotKeys().join(','), 'challenges,discover,create');

  HP._data.hidden = ['challenges'];
  assert.equal(HP.gridSlotKeys().join(','), 'discover,create');

  // Nothing loaded → nothing to place, rather than a hole in the grid.
  HP._data = null;
  assert.equal(HP.gridSlotKeys().length, 0);
});

// The create widget is on EVERY home screen. Quota decides whether it is
// tappable, never whether it exists — this is the regression guard for the
// old "absent for non-creators" behaviour.
test('the create widget is placed regardless of app quota', () => {
  const { HP, sandbox } = makeHomePanels();
  const registry = [
    { key: 'discover', title: 'Discover', removable: false },
    { key: 'create', title: 'Create app', removable: true },
  ];
  HP._data = { registry, hidden: [], panels: [] };
  for (const canCreateApps of [true, false]) {
    sandbox.Home = { canCreate: () => canCreateApps, CREATE_DISABLED_HINT: 'hint' };
    assert.ok(HP.gridSlotKeys().includes('create'), `quota=${canCreateApps}`);
    assert.ok(HP.panelFor('create'), 'renderable in both states');
  }
  // Nothing in the server registry may consult a viewer's quota either.
  const registrySrc = ROUTE.match(/const PANEL_REGISTRY = \[[\s\S]*?\n\];/)[0];
  assert.doesNotMatch(registrySrc, /canCreateApps|app_quota|quota/i,
    'the registry takes no viewer argument — placement is never permission-gated');
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
  // Widgets and app tiles are both placed, from ONE layout array.
  assert.match(HOME, /HomeLayout\.canvasItems\(layout\)/);
  assert.match(HOME, /HomeLayout\.overflowItems\(layout\)/);
  assert.match(HOME, /data-panel-slot="\$\{escapeHtml\(item\.key\)\}"/);
});

test('the placement recognizer owns the grid, and the flow reorder is gone', () => {
  assert.match(HOME, /unNative\.attachGridPlacement\(listEl, \{/);
  // Every widget host is draggable — including a create widget rendered in
  // its disabled state, which must not be pinned in place by lacking quota.
  assert.match(HOME, /itemSelector: '\.app-card\[data-yours\]:not\(\[data-demo\]\), \.home-panel-slot'/);
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
  assert.match(cur, /HomeLayout\.reflow\(otherStored, other, cols\)/, 'other width seeds it');
  assert.match(cur, /HomeLayout\.deriveDefault\(/, 'flow order is the last resort');
  assert.match(cur, /if \(changed && Array\.isArray\(stored\) && stored\.length\)/);
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
  // Tiles paint above it.
  assert.match(CSS, /#app-list > \.app-card,\s*\n#app-list > \.home-panel-slot \{[^}]*z-index: 1/);

  // ...and are TRANSPARENT TO HIT-TESTING for the duration of a lift. This is
  // the regression guard for the bug that made occupied cells undroppable:
  // the overlay's cells sit below the tiles, so with tiles still taking
  // pointer events elementFromPoint returned a TILE for every occupied cell,
  // cellFromPoint returned null, and both "drop onto another app" and "move a
  // widget over its own footprint" silently sprang back.
  assert.match(CSS,
    /#app-list\.un-reordering > \.app-card,\s*\n#app-list\.un-reordering > \.home-panel-slot \{[^}]*pointer-events: none/);
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

// ── The whole title bar is the handle ─────────────────────────────
//
// There is no `handle:` option on the attachReorder call and there must not
// be one: `handle` is declared per LIST, and #app-list's other items are the
// app cards, which have to keep drag-from-anywhere on desktop (native.js
// returns early on a non-handle press) and long-press-to-lift on touch. With
// no handle the kit already treats the whole grid item as grabbable, so what
// the bar needed was the AFFORDANCE plus one real gap: nothing stopped a
// press on a control inside the block from arming that drag.

test('the bar advertises the drag it has always had, and carries no ⠿ grip', () => {
  const { html } = renderWith({ registry: [], hidden: [], panels: [panel()] });
  assert.match(html, /home-panel-bar[^"]*select-none"/,
    'a desktop drag must not sweep a text selection across the title instead');
  assert.match(html, /home-panel-bar[^>]*title="Drag to move this widget"/);
  assert.doesNotMatch(html, /⠿/,
    'a grabber beside a bar that is itself grabbable read as "only this glyph moves it"');
  assert.doesNotMatch(html, /home-panel-grip/);
});

test('the grab cursor is scoped to the host that can actually move', () => {
  const css = read('public/css/app.css');
  // Scoped to the IN-GRID hosts (there are several now, one per widget) —
  // the #home-panels fallback section has no drag wiring at all, so a grab
  // cursor there would lie.
  assert.match(css, /\[data-panel-slot\] \.home-panel-bar \{[^}]*cursor:\s*grab/);
  // The kit puts .un-reordering on the LIST (#app-list) for the duration of a
  // lift, and the slots are children of it — so the descendant rule holds.
  assert.match(css, /\.un-reordering \[data-panel-slot\] \.home-panel-bar \{[^}]*cursor:\s*grabbing/);
  const kit = read('public/usernode-native/v1/native.css');
  assert.match(kit, /\.un-reordering[^{]*\{[^}]*cursor:\s*grabbing/,
    'the class the scoping depends on is the kit\'s, not ours');
  // A control is a control, even sitting on the handle.
  assert.match(css, /\.home-panel-bar button \{[^}]*cursor:\s*pointer/);
});

test('a press on a control in the block never arms the grid drag', () => {
  // The kit binds pointerdown on #app-list and it BUBBLES, so stopping the
  // event at the button is what keeps the ⋮ from lifting the widget instead
  // of opening — on desktop (armed → lift past the slop) and on touch (the
  // 400ms long-press timer) alike.
  const wire = SRC.match(/_wire\(section\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(wire, /querySelectorAll\('\.home-panel button'\)[\s\S]*?'pointerdown'[\s\S]*?stopPropagation\(\)/,
    'every control, not just the menu — the footer buttons sit inside the item too');
  const kit = read('public/usernode-native/v1/native.js');
  assert.match(kit, /listEl\.addEventListener\('pointerdown', onPointerDown\)/,
    'bubble-phase on the LIST is what makes stopping it at the button enough');
  // And no second recognizer was bolted on: the placement instance the app
  // tiles use is still the only thing that moves the block. (HTML5
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
  // arrays fail deepStrictEqual's prototype check.
  assert.equal(labels(items), 'Open challenges | Hide widget');
  assert.equal(items[1].destructive, true, 'hiding is the destructive row');
  assert.ok(!items[0].destructive);

  // Row 1 is a real hash navigation, so the device back gesture returns here.
  items[0].handler();
  assert.equal(sandbox.location.hash, '#leaderboard/challenges');

  // Row 2 is exactly what the ✕ did — persisted, and still restorable from
  // Settings → Home screen widgets.
  const calls = [];
  sandbox.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; };
  items[1].handler();
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
  assert.equal(labels(seen[0].items), 'Open challenges | Hide widget');
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

test('the cap is a CSS constant, enforced by flex, and clips rather than grows', () => {
  const css = read('public/css/app.css');
  // The cap is two app-grid CELLS plus the gap between them, and the cell
  // is itself a constant now (--home-cell-h), so the two cannot drift.
  assert.match(css, /--home-panel-max-h:\s*16rem/);
  assert.match(css, /--home-cell-h:\s*7\.75rem/);
  const panelRule = css.match(/\.home-panel \{[^}]*\}/)[0];
  assert.match(panelRule, /max-height:\s*var\(--home-panel-max-h\)/);
  assert.match(panelRule, /flex-direction:\s*column/);
  // min-height: 0 is what lets overflow: hidden clip instead of the flex
  // item refusing to compress and pushing the article past the cap.
  const rowsRule = css.match(/\.home-panel-rows \{[^}]*\}/)[0];
  assert.match(rowsRule, /min-height:\s*0/);
  assert.match(rowsRule, /overflow:\s*hidden/);
  // Uniform rows are what make the 4-slot budget exact, and the height is
  // a variable so the budget comment above it has one number to check.
  assert.match(css.match(/\.home-panel-row \{[^}]*\}/)[0],
    /height:\s*var\(--home-panel-row-h\)/);
  assert.match(css, /--home-panel-row-h:\s*2\.5rem/);
  // 4 rows + the chrome must still clear the cap with room to spare: 2px
  // border + 25.5px title bar + 4 x 40px + 27px footer = 214.5. If a future
  // row height eats the headroom it fails here, rather than clipping the
  // fourth row in a browser nobody opened.
  const rowPx = parseFloat(css.match(/--home-panel-row-h:\s*([\d.]+)rem/)[1]) * 16;
  const capPx = parseFloat(css.match(/--home-panel-max-h:\s*([\d.]+)rem/)[1]) * 16;
  const footerPx = parseFloat(
    css.match(/\.home-panel-footer \{[^}]*min-height:\s*([\d.]+)rem/)[1]) * 16;
  const collapsed = 2 + 25.5 + 4 * rowPx + footerPx + 1;
  assert.ok(collapsed <= capPx - 5,
    `the collapsed block (${collapsed}px) must stay clear of the ${capPx}px cap`);
  // No runtime measurement — #922 deleted that mechanism for the width
  // axis and app.css says not to bring it back.
  assert.doesNotMatch(HOME, /alignSections|--home-section-indent/);
});

test('the width cap is half the home column, left-aligned, on both hosts', () => {
  const css = read('public/css/app.css');
  // Half of .home-column's 64rem. Pinning both sides means a change to the
  // column width fails here rather than silently leaving the widget at
  // some fraction nobody chose.
  assert.match(css, /--home-panel-max-w:\s*32rem/);
  assert.match(css.match(/\.home-column \{[^}]*\}/)[0], /max-width:\s*64rem/);
  // On the article, so BOTH hosts are covered by one rule: the in-grid
  // slot and the #home-panels section fallback.
  assert.match(css.match(/\.home-panel \{[^}]*\}/)[0], /max-width:\s*var\(--home-panel-max-w\)/);
  // And on the drag slot, so the lift ghost and drop indicator match the
  // widget's real width instead of the full column.
  assert.match(css.match(/\.home-panel-slot \{[^}]*\}/)[0], /max-width:\s*var\(--home-panel-max-w\)/);
  // Left-aligned: the block is a grid member and its left edge has to line
  // up with the first app icon. Auto side margins would centre it.
  assert.doesNotMatch(css.match(/\.home-panel \{[^}]*\}/)[0], /margin(-left|-right)?:\s*auto/);
  assert.doesNotMatch(css.match(/\.home-panel-slot \{[^}]*\}/)[0], /margin(-left|-right)?:\s*auto/);
});

// Two consequences of the slot spanning real ROWS rather than breaking one.
test('the multi-row slot neither inflates its rows nor stretches its neighbours', () => {
  const css = read('public/css/app.css');
  const slotRule = css.match(/\.home-panel-slot \{[^}]*\}/)[0];
  // A margin adds to the item's OUTER height, so a row-span-2 slot would
  // demand 14rem + margin from two 6.75rem rows and stretch every card
  // sharing them. The grid's own gap-2 is the spacing.
  assert.doesNotMatch(slotRule, /margin/,
    'the grid gap spaces the slot; a margin would inflate the rows it spans');
  // And the cards in those rows sit at the top instead of growing a pool of
  // dead space under their titles when an expanded widget makes the row tall.
  assert.match(css.match(/#app-list > \.app-card \{[^}]*\}/)[0], /align-self:\s*start/);
});

test('the cell height still matches the app tile it is derived from', () => {
  // p-3 (0.75rem x 2) + 3.5rem icon + 0.5rem gap + 1.25rem name + 1rem
  // caption lane = 7.75rem per cell; two cells + the grid's 0.5rem gap =
  // 16rem. If any of these tokens moves, --home-cell-h and
  // --home-panel-max-h have to move with it — that is the point of pinning
  // both sides here.
  const card = HOME.match(/<div class="app-card app-card-draggable[^"]*"/)[0];
  assert.match(card, /\bp-3\b/, 'app tile padding feeds the 1.5rem term');
  assert.match(card, /\bgap-2\b/, 'app tile gap feeds the 0.5rem term');
  assert.match(HOME, /class="app-icon-tile w-14 h-14/, 'icon feeds the 3.5rem term');
  assert.match(HOME, /class="font-medium text-sm truncate/, 'name feeds the 1.25rem term');
  // THE CAPTION LANE IS LOAD-BEARING. The status dot is gone from the tile
  // face, so this line is a tile's only status signal — and rows are a
  // fixed height, so a caption with no budget paints over the tile below
  // instead of growing its own row.
  assert.match(HOME, /warningHtml = statusLabel/);
  assert.match(CSS, /THE CAPTION LANE IS NOT OPTIONAL/);
  const grid = INDEX.match(/<div id="app-list"[^>]*>/)[0];
  assert.match(grid, /\bsm:gap-2\b/, 'the grid gap feeds the between-rows 0.5rem term');
  // The phone variant tightens the tile and shrinks the cell in step.
  assert.match(grid, /\bp-2\b/);
  assert.match(CSS, /--home-cell-h: 7\.25rem/);
  assert.match(CSS, /--home-panel-max-h: 14\.875rem/);
});

// ── Source pins ───────────────────────────────────────────────────

test('index.html keeps #home-panels as the fallback host below the grid', () => {
  const grid = INDEX.indexOf('id="app-list"');
  const panels = INDEX.indexOf('id="home-panels"');
  assert.ok(grid > 0 && panels > 0);
  assert.ok(panels > grid, 'the fallback host sits below the grid');
  // Outside the grid, or the grid's wholesale re-render would destroy it.
  assert.ok(INDEX.indexOf('id="app-list"></div>', 0) < panels);

  // The two trailing sections it used to sit between are GONE — both are
  // widgets in the grid now, placeable anywhere rather than pinned below
  // everything.
  assert.equal(INDEX.indexOf('id="home-find-more"'), -1);
  assert.equal(INDEX.indexOf('id="home-create-section"'), -1);
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

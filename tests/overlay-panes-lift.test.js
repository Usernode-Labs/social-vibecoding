'use strict';

// THE SHELL'S THREE FLOATING PANES ARE ONE SURFACE, AND IT IS OPAQUE.
//
// The bell's rail, the Improve rail and the app chip's menu are the three
// things in the shell that present OVER A SCRIM. They had drifted into three
// different surfaces: the bell wore `.dc-lift dc-lift-session` (the dev
// screen's glass), and the other two wore `bg-white dark:bg-zinc-900` with a
// zinc hairline and Tailwind's `shadow-2xl` — the pre-lift panel look.
//
// The glass was the actual bug. `.dc-lift-session` is 50% white over a 24px
// backdrop blur, which reads as frost when the thing behind it is the page
// wallpaper — the cream, the three washes, the star. Behind these three it is
// not: each raises its own `bg-black/40` backdrop first, so the fill was
// compositing over a page already dimmed 40%. The arithmetic is in the
// `.dc-lift-panel` comment in app.css: #f4f2e4 → #929189 under the scrim →
// #c8c8c4 under the pane. The brightest surface on the screen rendered a
// fifth of the way to black, which is what "it looks dull" was.
//
// So there is a third lift surface. `.dc-lift` still supplies the geometry —
// the 1.75rem radius, the hairline, the two-layer shadow — and
// `.dc-lift-panel` fills it with the opaque `--dc-sheet` instead of the
// translucent `--dc-sheet-fill`. What this file pins is that the three panes
// keep reading it, that it stays opaque, and that the dev screen's two glass
// planes are untouched by it.
//
// Run with: node --test tests/overlay-panes-lift.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');

const NOTIFICATIONS = read('frontend/src/features/notifications/notifications-sheet.tsx');
const IMPROVE = read('frontend/src/features/improve/improve-panel.tsx');
const SWITCHER = read('frontend/src/features/app-context/app-context-sheet.tsx');

/** The three panes, by the id each one's root carries. */
const PANES = [
  { id: 'notifications-sheet', src: NOTIFICATIONS, overlay: 'notifications-sheet-overlay' },
  { id: 'improve-panel', src: IMPROVE, overlay: 'improve-overlay' },
  { id: 'apps-switcher-sheet', src: SWITCHER, overlay: 'apps-switcher-overlay' },
];

const rule = (sel) => {
  const at = APP_CSS.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} must exist`);
  return APP_CSS.slice(at, APP_CSS.indexOf('\n}', at + 1));
};

/**
 * The `max-width: 639px` rule for a pane — the one nested block declaring
 * `#<id>` whose body slides the panel up from the floor. Selected by content
 * rather than by counting occurrences: every one of these ids is declared in
 * three or four places (a base rule, a dropdown or rail rule, a kit-adopted
 * rule), and an index-based pick silently follows the wrong one the next time
 * a block is added above it.
 */
const bottomSheetRule = (id) => {
  // The selector may be grouped — the bell's block still carries the retired
  // #messages-sheet alongside it — so the head runs to the brace.
  const re = new RegExp(`\\n  #${id}[,\\s][^{]*\\{`, 'g');
  const hits = [];
  for (let m = re.exec(APP_CSS); m; m = re.exec(APP_CSS)) {
    const body = APP_CSS.slice(m.index, APP_CSS.indexOf('\n  }', m.index));
    if (body.includes('translateY(100%)')) hits.push(body);
  }
  assert.equal(hits.length, 1, `#${id} must have exactly one bottom-sheet rule`);
  return hits[0];
};

/** The class string on the root element carrying `id`. */
const rootClass = (src, id) => {
  const m = new RegExp(`id="${id}"[\\s\\S]{0,800}?className=\\{?'?"?([^"']*)`).exec(src);
  assert.ok(m, `located the class string on #${id}`);
  return m[1];
};

// ── The surface ────────────────────────────────────────────────────────

test('all three panes wear the lift and its opaque panel fill', () => {
  for (const { id, src } of PANES) {
    const cls = rootClass(src, id);
    assert.match(cls, /\bdc-lift\b/, `#${id} takes the lift's geometry`);
    assert.match(cls, /\bdc-lift-panel\b/, `#${id} takes the opaque panel fill`);
    assert.doesNotMatch(cls, /\bdc-lift-session\b/,
      `#${id} must not wear the dev screen's glass — it is over a scrim`);
  }
});

test('the panel fill is opaque, and has no backdrop-filter to be opaque about', () => {
  const panel = rule('.dc-lift-panel');
  assert.match(panel, /background-color: var\(--dc-sheet\)/,
    'the panel takes the opaque surface token, not --dc-sheet-fill');
  assert.doesNotMatch(panel, /--dc-sheet-fill|rgba\(/,
    'nothing translucent may creep back into this rule');
  // An opaque fill has nothing behind it to blur, so the filter would cost a
  // compositing layer on three always-mounted elements and buy no pixels.
  assert.doesNotMatch(panel, /backdrop-filter/,
    'an opaque surface must not pay for a blur it cannot show');
});

test('the panes are opaque BECAUSE each one raises a scrim', () => {
  // This is the whole argument for a third surface rather than a fourth
  // token. If a pane ever loses its backdrop it is over the wallpaper like
  // the dev screen, and glass becomes the right answer for it again.
  for (const { src, overlay } of PANES) {
    const m = new RegExp(`id="${overlay}"[\\s\\S]{0,400}?bg-black/40`).exec(src);
    assert.ok(m, `#${overlay} must still dim the page behind its pane`);
  }
});

test('the dev screen keeps its glass — this change does not reach it', () => {
  // .dc-lift-session and .dc-lift-strip sit over the page wallpaper, which is
  // something worth seeing through. Flattening them was never the ask.
  for (const sel of ['.dc-lift-strip', '.dc-lift-session']) {
    const r = rule(sel);
    assert.match(r, /background-color: var\(--dc-(strip|sheet)-fill\)/,
      `${sel} keeps its translucent fill`);
    assert.match(r, /backdrop-filter: var\(--dc-frost\)/, `${sel} keeps its blur`);
  }
});

test('no pane keeps the pre-lift panel look', () => {
  for (const { id, src } of PANES) {
    const cls = rootClass(src, id);
    for (const dead of [/\bbg-white\b/, /\bdark:bg-zinc-900\b/, /\bshadow-2xl\b/,
      /\bborder-zinc-200\b/, /\bdark:border-zinc-700\b/]) {
      assert.doesNotMatch(cls, dead,
        `#${id} still carries ${dead} — the lift supplies fill, hairline and shadow`);
    }
  }
});

// ── The shape, which differs by how each pane docks ────────────────────

test('the two rails round the one corner that is a corner of anything', () => {
  // A right-edge rail runs floor to ceiling against the right of the display,
  // so three of its four corners sit on an edge. `.dc-lift` ships the
  // floor-docked shape (1.75rem 1.75rem 0 0) and each rail restates its own.
  for (const id of ['notifications-sheet', 'improve-panel']) {
    const r = rule(`#${id}`);
    assert.match(r, /border-radius: 1\.75rem 0 0 0/,
      `#${id}'s desktop shape is the top-LEFT corner only`);
    assert.match(r, /border-(left|color)/, `#${id} draws its left hairline`);
  }
});

test('the app menu keeps the menu shape it earned, and only takes the surface', () => {
  // It hangs off the chip that opens it rather than docking to an edge, so
  // all four of its corners are real and none of them is the lift's 28px.
  // --un-radius-card and --brand-line tie it to the chip's own ring; the
  // pane style is the fill and the shadow here, not the outline.
  const at = APP_CSS.indexOf('#apps-switcher-sheet {', APP_CSS.indexOf('@media (min-width: 640px)'));
  assert.ok(at > 0, 'located the dropdown rule');
  const dropdown = APP_CSS.slice(at, APP_CSS.indexOf('\n  }', at));
  assert.match(dropdown, /border-radius: 0\.75rem/, 'the kit menu radius stays');
  assert.match(dropdown, /border-color: var\(--brand-line\)/, 'the brand hairline stays');
  assert.doesNotMatch(dropdown, /1\.75rem/, 'it must not adopt the docked radius');
});

test('all three bottom sheets round to the same 1.75rem, by reading it', () => {
  // Below sm every one of these is a bottom sheet docked to the floor, which
  // is the shape `.dc-lift` itself ships — so the three agree on the number.
  // The bell used to restate it with `!important` to beat a stale `1rem` in
  // its own geometry block; that block says 1.75rem now, so the override is
  // gone and there is one declaration per pane rather than two.
  for (const id of ['improve-panel', 'apps-switcher-sheet', 'notifications-sheet']) {
    const sheet = bottomSheetRule(id);
    assert.match(sheet, /border-top-left-radius: 1\.75rem/, `#${id}'s left corner`);
    assert.match(sheet, /border-top-right-radius: 1\.75rem/, `#${id}'s right corner`);
    assert.match(sheet, /transform: translateY\(100%\)/,
      `#${id} is the bottom-sheet rule, not some other block that mentions it`);
  }
  assert.doesNotMatch(APP_CSS, /border-top-left-radius: [^;]*!important/,
    'no pane needs an !important to win its own top corner any more');
});

// ── The kit path ───────────────────────────────────────────────────────

test('an adopted pane lets the kit own the surface', () => {
  // On touch the native kit presents these elements inside its own sheet and
  // `.platform-sheet-adopted` flattens the fixed chrome. That rule carries
  // `!important`, so nothing here may out-rank it with an `!important` of its
  // own — which the bell's desktop radius used to do.
  const adopted = rule('.platform-sheet-adopted');
  for (const prop of ['border', 'border-radius', 'box-shadow', 'background']) {
    assert.match(adopted, new RegExp(`${prop}: [^;]*!important`),
      `the kit sheet owns ${prop}`);
  }
  const desktop = APP_CSS.slice(APP_CSS.indexOf('#notifications-sheet { border-color'));
  const block = desktop.slice(0, desktop.indexOf('.notifications-row'));
  assert.doesNotMatch(block, /!important/,
    'the bell no longer overrides the kit with !important');
});

'use strict';

// Shared frosted material, bounded shadows and delayed closed-pane visibility.
// Executable animation, stacking and hit-testing coverage is in
// browser/overlay-scrim.mjs.

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

test('all three panes wear the lift and the one shared pane surface', () => {
  for (const { id, src } of PANES) {
    const cls = rootClass(src, id);
    assert.match(cls, /\bdc-lift\b/, `#${id} takes the lift's geometry`);
    assert.match(cls, /\bdc-lift-panel\b/, `#${id} takes the shared pane surface`);
    assert.doesNotMatch(cls, /\bdc-lift-session\b/,
      `#${id} reads .dc-lift-panel, which is that glass PLUS the cast dim`);
  }
});

test('the pane surface is GLASS, the same the dev screen wears', () => {
  const panel = rule('.dc-lift-panel');
  assert.match(panel, /background-color: var\(--dc-sheet-fill\)/,
    'the translucent fill, not the opaque --dc-sheet');
  assert.match(panel, /backdrop-filter: var\(--dc-frost\)/, 'and it frosts');
  // Safari has shipped this prefixed for years; dropping it turns the glass
  // into an unblurred wash there, which is worse than either end state.
  assert.match(panel, /-webkit-backdrop-filter: var\(--dc-frost\)/);
});

test('panes keep bounded lift shadows and an owned cutout decoration', () => {
  assert.match(rule('.dc-lift-panel'), /box-shadow: var\(--dc-lift-shadow\);/);
  assert.doesNotMatch(APP_CSS, /100vmax/);
  assert.match(rule('.overlay-scrim'), /pointer-events: none/);
  for (const { id, overlay, src } of PANES) {
    assert.ok(src.includes(`<OverlayScrim panelId="${id}" backdropId="${overlay}" />`));
  }
});

test('closed panes hide only after exit and kit adoption owns its own lifetime', () => {
  const shut = rule('.dc-lift-panel:not([data-open]):not(.platform-sheet-adopted)');
  assert.match(shut, /visibility: hidden/);
  assert.match(shut, /visibility 0s linear 200ms/);
  assert.match(shut, /opacity 0s linear 200ms/);
  assert.match(shut, /transform 200ms/);
  assert.match(rule('.dc-lift-panel'), /visibility: visible/);
});

test('the declared feedback text check opens its pane before reading it', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find(t => t.name.startsWith('Improve panel leads'));
  assert.match(check.path, /shot=improve/);
  assert.match(check.expectSelector, /#improve-panel\[data-open\]/);
});

test('the backdrops stay, transparent — they are the click target', () => {
  // They own pointer-events and dismiss-on-click, which the shadow does not
  // take over. What they no longer do is paint, because painting is what put
  // the dim inside the pane's backdrop.
  for (const { id, src: file, overlay } of PANES) {
    const m = new RegExp(`id="${overlay}"[\\s\\S]{0,400}?className="([^"]*)"`).exec(file);
    assert.ok(m, `#${overlay} must still be rendered`);
    assert.match(m[1], /fixed inset-0 z-40/, `#${overlay} still covers the page`);
    assert.doesNotMatch(m[1], /bg-black/,
      `#${overlay} must not paint the dim — #${id} casts it instead`);
    assert.match(file, new RegExp(`id="${overlay}"[\\s\\S]{0,400}?onClick=\\{close\\}|`
      + `id="${overlay}"[\\s\\S]{0,400}?onClick=`), 'and still dismisses on click');
  }
});

test('without backdrop-filter the pane goes opaque and the dim survives', () => {
  // The scrim is a shadow, not a filter, so only the fill falls back — the
  // same admission `.dc-lift-session` already makes: the effect is the blur.
  const at = APP_CSS.indexOf('@supports not ((backdrop-filter', APP_CSS.indexOf('.dc-lift-panel {'));
  assert.ok(at > 0, 'the panel needs its own no-filter fallback');
  const block = APP_CSS.slice(at, APP_CSS.indexOf('\n}\n', at));
  assert.match(block, /\.dc-lift-panel \{ background-color: var\(--dc-sheet\); \}/);
  assert.doesNotMatch(block, /box-shadow/, 'the dim is not part of the fallback');
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

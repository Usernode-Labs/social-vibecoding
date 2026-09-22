'use strict';

// Shell-only kit material; browser/overlay-scrim.mjs exercises the
// replacement paint layer against the actual animation and dismissal lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');
const NATIVE_CSS = read('public/usernode-native/v1/native.css');
const NATIVE_JS = read('public/usernode-native/v1/native.js');

const rule = (sel, css = APP_CSS) => {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} must exist`);
  return css.slice(at, css.indexOf('\n}', at + 1));
};

const SURFACES = ['.un-modal', '.un-sheet', '.un-panel'];
// ── The surface ────────────────────────────────────────────────────────

test('the kit modal, sheet and panel wear the pane glass in the shell', () => {
  for (const sel of SURFACES) {
    const body = rule(sel);
    assert.match(body, /background-color: var\(--dc-sheet-fill\)/, `${sel} takes the translucent fill`);
    assert.match(body, /backdrop-filter: var\(--dc-frost\)/, `${sel} frosts`);
    assert.match(body, /-webkit-backdrop-filter: var\(--dc-frost\)/, `${sel} frosts in Safari`);
  }
});

test('the overscroll extensions are more surface, so they are the same glass', () => {
  // `.un-sheet::after` / `.un-panel::after` continue the surface past the
  // screen edge (native.css, issue #789); an opaque strip there would show
  // through on every bounce.
  for (const sel of ['.un-sheet::after', '.un-panel::after']) {
    const body = rule(sel);
    assert.match(body, /background-color: var\(--dc-sheet-fill\)/, `${sel}`);
    assert.match(body, /backdrop-filter: var\(--dc-frost\)/, `${sel}`);
  }
});

test('native.css is NOT restyled — the frost is the shell\'s alone', () => {
  // The kit is centrally hosted to every app. Its own modal, sheet and
  // panel keep their opaque surface; only the shell document, which loads
  // app.css after native.css, sees the glass.
  for (const sel of SURFACES) {
    const body = rule(sel, NATIVE_CSS);
    assert.match(body, /background: var\(--un-(sheet|panel)-bg\)/, `${sel} keeps its opaque ground in the kit`);
    assert.doesNotMatch(body, /backdrop-filter/, `${sel} does not frost in the kit`);
  }
  assert.doesNotMatch(NATIVE_CSS, /--pane-scrim|--dc-sheet-fill|--un-presence/,
    'the kit stylesheet reads none of the shell\'s tokens');
});

test('without backdrop-filter the surfaces go opaque and keep the dim', () => {
  const fallback = APP_CSS.slice(
    APP_CSS.indexOf('.un-modal, .un-sheet, .un-sheet::after, .un-panel, .un-panel::after {'),
  ).slice(0, 200);
  assert.match(fallback, /background-color: var\(--dc-sheet\)/, 'the opaque sheet colour');
  const before = APP_CSS.slice(0, APP_CSS.indexOf('.un-modal, .un-sheet, .un-sheet::after, .un-panel, .un-panel::after {'));
  assert.match(before.slice(-200), /@supports not \(\(backdrop-filter: blur\(1px\)\)/,
    'inside the no-backdrop-filter block');
});

// ── The dim ────────────────────────────────────────────────────────────

test('the kit backdrop goes transparent only where a frosted surface follows it', () => {
  const body = rule('.un-backdrop:has(+ .un-modal),\n.un-backdrop:has(+ .un-sheet),\n.un-backdrop:has(+ .un-panel)');
  assert.match(body, /background: transparent/);
  // presentModal / presentSheet / presentPanel each append the backdrop and
  // then the surface, so the surface is the backdrop's next sibling. The
  // alert and the action sheet are not in the list and keep the kit's dim.
  for (const fn of ['presentModal', 'presentSheet', 'presentPanel']) {
    const at = NATIVE_JS.indexOf(`function ${fn}(`);
    assert.ok(at > 0, fn);
    const src = NATIVE_JS.slice(at, at + 2500);
    assert.match(src, /document\.body\.appendChild\(backdrop\);\s*document\.body\.appendChild\((card|sheet|panel)\);/,
      `${fn} appends the surface right after its backdrop`);
  }
  // It is the backdrop's ELEMENT that stays: dapp.json reads its inline
  // opacity to know a modal has entered.
  const DAPP = read('dapp.json');
  assert.match(DAPP, /\.un-backdrop\[style\*=\\"opacity: 1\\"\]/);
});

test('kit surfaces retain their bounded shadows without viewport-sized spread', () => {
  assert.match(rule('.un-modal'), /box-shadow: var\(--dc-lift-shadow\);/);
  assert.match(rule('.un-sheet'), /box-shadow: 0 -8px 32px rgba\(0, 0, 0, 0\.22\);/);
  assert.match(rule('.un-panel[data-un-side="right"]'), /box-shadow: -8px 0 32px rgba\(0, 0, 0, 0\.22\);/);
  assert.match(rule('.un-panel[data-un-side="left"]'), /box-shadow: 8px 0 32px rgba\(0, 0, 0, 0\.22\);/);
  assert.doesNotMatch(APP_CSS, /100vmax/);
});

test('native.js publishes --un-presence from the render that drives the backdrop', () => {
  for (const [fn, el, extent] of [['presentSheet', 'sheet', 'height'], ['presentPanel', 'panel', 'width']]) {
    const at = NATIVE_JS.indexOf(`function ${fn}(`);
    const src = NATIVE_JS.slice(at, NATIVE_JS.indexOf('\n  }\n', at));
    const render = src.slice(src.indexOf('function render(val)'), src.indexOf('function springTo'));
    // One number, computed once, written to both: the backdrop's opacity
    // and the surface's custom property can never disagree.
    assert.match(render, new RegExp(`var presence = String\\(Math\\.max\\(0, Math\\.min\\(1, 1 - val / ${extent}\\)\\)\\);`), fn);
    assert.match(render, /backdrop\.style\.opacity = presence;/, fn);
    assert.match(render, new RegExp(`${el}\\.style\\.setProperty\\('--un-presence', presence\\);`), fn);
  }
  assert.doesNotMatch(NATIVE_CSS, /--un-presence/, 'the kit\'s own styles ignore it; apps render as before');
});

test('the scrim tokens are split into ink and alpha in both themes', () => {
  for (const tok of ['--pane-scrim-ink: 0 0 0;', '--pane-scrim-alpha: 0.4;',
    '--pane-scrim: rgb(var(--pane-scrim-ink) / var(--pane-scrim-alpha));']) {
    assert.equal((APP_CSS.match(new RegExp(tok.replace(/[()*.+/]/g, '\\$&'), 'g')) || []).length, 2,
      `${tok} declared once per theme`);
  }
});

// ── The create dialog ──────────────────────────────────────────────────

test('the create dialog sits on the strip\'s frosted tint, opaque strip as fallback', () => {
  const body = rule('.un-modal:has(> #create-card)');
  assert.match(body, /--un-sheet-bg: var\(--dc-strip\)/, 'the kit variable stays for whatever still reads it');
  assert.match(body, /background-color: var\(--dc-strip-fill\)/);
  assert.match(APP_CSS, /\.un-modal:has\(> #create-card\) \{ background-color: var\(--dc-strip\); \}/);
});

// ── The adopted panes hand the surface to the kit ──────────────────────

test('an adopted pane still lets the kit own the surface, so the frost is not doubled', () => {
  // `.platform-sheet-adopted` (tests/overlay-panes-lift.test.js pins the
  // !important) flattens the pane's own background and shadow while it rides
  // the kit sheet: the sheet's glass and the sheet's scrim are the only ones.
  const adopted = rule('.platform-sheet-adopted');
  assert.match(adopted, /background: transparent !important/);
  assert.match(adopted, /box-shadow: none !important/);
});

'use strict';

// Mobile 01 (24 Nov 2026): on a phone the header on the top-level screens is
// the tab bar's blue, flat, with white words and icons. It was the faked
// glass, the wallpaper under a pale wash with a rounded foot, so the top of
// the screen and the solid blue tab bar at its foot did not read as one frame.
//
// What this file pins, in public/css/app.css ("THE PHONE'S TOP BAR IS THE TAB
// BAR'S BLUE, FLAT"):
//   - the colour is the tab bar's own token, never a hex, so the two bars
//     cannot drift apart and dark mode follows;
//   - it covers exactly the routes the glass covers, plus a project page the
//     platform draws while it has no tint;
//   - its conditions add no weight, so a project's tinted bar still wins;
//   - only under 768px, and never under a look, the Duo's side strip or (for
//     the row's padding) the Duo's top band;
//   - the phone drawer's untint, laid over a project's bar, is the same blue.
// The clock half is tests/native-status-bar-tone.test.js; Safari's strip is
// tests/safari-status-strip.test.js.
//
// Run with: node --test tests/phone-header-blue.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
const START = "/* ── THE PHONE'S TOP BAR IS THE TAB BAR'S BLUE, FLAT";

function block() {
  const at = CSS.indexOf(START);
  assert.ok(at > 0, 'the rule is found by its heading');
  return CSS.slice(at, CSS.indexOf('/* THE BAND: the place bar', at));
}

const routesOf = (selector) => /body:has\(:is\(([^)]*)\):not\(\.hidden\)\) #platform-header/
  .exec(selector)[1].split(',').map((id) => id.trim());

test('the bar is the tab bar\'s token, flat and white-inked, on a phone only', () => {
  const b = block();
  const media = /\*\/\n@media \(max-width: 767\.98px\) \{\n/.exec(b);
  assert.ok(media, 'every rule of it is inside the phone query, so 768px and up are untouched');
  const rule = /\{\n    --fake-glass-tint: var\(--wip-nav-bg\);([^}]*)\}/.exec(b);
  assert.ok(rule, 'the faked layer is tinted with the tab bar\'s own token, so it is opaque and flat');
  const body = rule[1];
  for (const decl of [
    '--platform-header-solid: var(--wip-nav-bg);',
    'background-color: var(--wip-nav-bg);',
    '--brand-ink: #fff;',
    '--text-primary: #fff;',
    '--lit-ink: #fff;',
    'color: #fff;',
    'clip-path: inset(0);',
    'border-end-start-radius: 0;',
    'border-end-end-radius: 0;',
    'box-shadow: none;',
  ]) assert.ok(body.includes(decl), decl);
  assert.doesNotMatch(b.slice(b.indexOf('@media')), /#3c7bd8|#122a52/i, 'the token, not its hex');
  // The token's two values are the tab bar's, light and dark.
  assert.match(CSS, /html:not\(\[data-skin\]\) \{[\s\S]*?--wip-nav-bg: #3c7bd8;/);
  assert.match(CSS, /html:not\(\[data-skin\]\)\.dark \{\n  --wip-nav-bg: #122a52;\n\}/);
});

test('it covers the glass bar\'s routes, and a project page the platform draws only without its tint', () => {
  const b = block();
  const selectors = /@media \(max-width: 767\.98px\) \{\n([^{]*)\{/.exec(b)[1].split(/,\n(?=  html)/).map((s) => s.trim());
  assert.equal(selectors.length, 2);
  const glass = CSS.slice(CSS.indexOf('/* …AND THE HEADER, faked the same way as the tab bar'));
  assert.deepEqual(routesOf(selectors[0]), routesOf(glass), 'the same screens the glass is drawn on');
  assert.ok(selectors[0].startsWith('html:where(:not([data-skin]):not([data-side-strip])) body:has('),
    'the standard look, off the Duo\'s side strip; inside :where(), so no weight is added');
  assert.equal(selectors[1],
    'html:where(:not([data-skin]):not([data-side-strip]):not([data-community-tint])) body:has(#app-view:not(.hidden)[data-app-surface="platform"]) #platform-header');
  // Weighing less than the project's bar, which therefore wins wherever the
  // two meet (a project's page zooming out to Home keeps both on show).
  assert.match(CSS, /\nhtml\[data-community-tint\] body:has\(#app-view:not\(\.hidden\)\) #platform-header \{\n  --fake-glass-tint: var\(--community-tint\);/);
  // A running app's surface is "app": never matched.
  assert.doesNotMatch(b, /data-app-surface="app"/);
});

test('the row is centred in the same 52px, except under the Duo\'s top band', () => {
  const b = block();
  assert.match(b, /:not\(\[data-top-band\]\):not\(\[data-community-tint\]\)\) body:has\(#app-view:not\(\.hidden\)\[data-app-surface="platform"\]\) #platform-header \{\n    padding-bottom: 0\.75rem;\n  \}/);
  assert.match(b, /padding-top: calc\(0\.75rem \+ var\(--un-safe-inset-top, env\(safe-area-inset-top, 0px\)\)\) !important;/);
  assert.ok(b.includes('    html.web-browser-chrome:where(:not([data-skin]):not([data-side-strip]):not([data-top-band])) body:has('),
    'a browser tab keeps its zero inset (#2509)');
  assert.match(b, /#platform-header\.un-safe-top-extend \{\n      padding-top: 0\.75rem !important;\n    \}/);
  // 12 + 28 + 12: the 8 + 28 + 16 of pt-2/pb-4 (tests/header-height-parity.test.js).
  const header = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/header/platform-header.tsx'), 'utf8');
  assert.match(header, /'un-safe-top-extend relative z-10 flex items-center gap-4 px-4 pt-2 pb-4 shrink-0'/, 'the markup is unchanged');
});

test('the phone drawer\'s untint is the same blue, with the same white ink', () => {
  const b = block();
  assert.match(b, /html:not\(\[data-skin\]\):not\(\[data-side-strip\]\) \.nav-drawer-untint \{\n    background: var\(--wip-nav-bg\);\n  \}/);
  assert.match(b, /html:not\(\[data-skin\]\):not\(\[data-side-strip\]\)\[data-nav-drawer\] body \{\n    --nav-brand-ink: #fff;[\s\S]*?--nav-ink: #fff;\n  \}/);
});

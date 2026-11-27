'use strict';

// A Needs you sheet is drawn ABOVE the tab bar and the Resume strip, scrolls
// when it is taller than the screen, and keeps the vote's buttons on screen
// (run-through in the Homeroom iOS app, 5 October 2026).
//
// What was seen: on a project's Needs you, Vote opened its sheet, and its
// action row (Cancel, Vote yes / Vote no) could not be pressed. With the
// keyboard closed the Resume strip (#platform-parked) and the tab bar
// (#platform-tabs) were drawn over it; at 375x812 in a browser,
// elementFromPoint at Vote yes's centre was #platform-tab-me, so the tap
// opened Me. With the keyboard up (No focuses the line box) the row hung
// below the page's edge, behind the keys. Swiping the sheet scrolled
// nothing.
//
// Why, three ways:
//   1. `.dev-ws-sheet-modal` was z-index 30, the tab bar's own number, and
//      the bar comes later in <body>, so the tie went to the bar.
//   2. The vote sheet is rendered INSIDE the rail (a popover on the rail's
//      button on a wide window), and the rail is `z-index: 3`, a stacking
//      context, so the sheet painted at the rail's level whatever its own
//      z-index said.
//   3. The card was capped (two thirds of the screen) and its content was
//      not, with no overflow of its own: past the cap the form ran out of the
//      card's foot. In the app the cap never lifted for the keyboard, because
//      `un-kb` never comes on there (the web view is resized to end at the
//      keys; lib/keyboard-open.ts publishes `platform-kb-open` instead).
//
// These pin the rules that fix each. The geometry itself, the action
// button's box inside the visible viewport and elementFromPoint at its centre
// returning the button with the bars and the strip up, at 375x812 and
// 402x874, keyboard up and down, is checked in a real browser by
// tests/browser/needs-sheet-above-bars.mjs (a selector cannot read a
// computed position, so no declared check can).
//
// Run with: node --test tests/needs-sheet-above-bars.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CSS = read('public/css/app.css');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const KB_OPEN = read('frontend/src/lib/keyboard-open.ts');

/** The z-index a single-line or block rule for `selector` declares. */
function zIndexOf(selectorRe) {
  const m = new RegExp(`(?:^|\\n)${selectorRe} \\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `a rule for ${selectorRe}`);
  const z = /z-index:\s*(\d+)/.exec(m[1]);
  assert.ok(z, `${selectorRe} declares a z-index`);
  return Number(z[1]);
}

/** The phone block that makes the cards scroll (the first one that does). */
function phoneBlock() {
  const at = CSS.indexOf('.dev-ws-sheet-card { overflow-y: auto;');
  assert.ok(at > 0, 'the card scrolls somewhere');
  const open = CSS.lastIndexOf('@media (max-width: 699.98px) {', at);
  assert.ok(open > 0 && CSS.slice(open, at).split('\n}').length === 1, 'inside a phone-only block');
  return CSS.slice(open, CSS.indexOf('\n}', at));
}

test('the sheets sit above the tab bar and the Resume strip', () => {
  const sheet = zIndexOf('\\.dev-ws-sheet-modal');
  const bar = zIndexOf('\\.platform-tabs');
  const strip = zIndexOf('\\.platform-parked');
  assert.equal(sheet, 40, 'the sheet tier `.platform-tabs` leaves for panels, sheets and dialogs');
  assert.ok(sheet > bar, `over the tab bar (${sheet} > ${bar}); a tie goes to the bar, later in <body>`);
  assert.ok(sheet > strip, `over the Resume strip (${sheet} > ${strip})`);
  // The tab bar says where that tier is; keep the two in step.
  assert.match(CSS, /UNDER the panels, sheets and dialogs \(which sit at 40 and above\)/);
});


test('the wide layout keeps its own stacking: the 40 is the phone sheet\'s alone', () => {
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS)[1];
  assert.match(wide, /\.dev-ws-sheet-talk \{\n\s*position: relative; inset: auto; flex: 0 1 380px; min-width: 300px; z-index: auto;/);
  assert.match(wide, /\.dev-ws-sheet-vote \{ position: absolute;[^}]*z-index: 6;/);
  assert.match(wide, /\.dev-ws-rail \{\n\s*position: relative; inset-inline-end: auto; bottom: auto; z-index: auto;/);
});

test('on a phone a tall sheet scrolls', () => {
  const phone = phoneBlock();
  assert.match(phone, /\.dev-ws-sheet-card \{ overflow-y: auto; overscroll-behavior: contain; \}/, 'the card scrolls, and the page behind it does not');
});

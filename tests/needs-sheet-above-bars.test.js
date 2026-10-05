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

test('the vote sheet is not held at the rail\'s level while it is up', () => {
  // It is rendered inside the rail...
  const rail = WORKSHOP.slice(WORKSHOP.indexOf('<aside className="dev-ws-rail" data-ws-rail=""'), WORKSHOP.indexOf('</aside>'));
  assert.match(rail, /className="dev-ws-sheet-modal dev-ws-sheet-vote" data-ws-sheet="vote"/, 'the vote sheet lives in the rail');
  // ...the rail is a stacking context on a phone...
  assert.match(CSS, /\.dev-ws-rail \{\n  position: absolute; right: 8px; bottom: 10px; z-index: 3;/);
  // ...so while the vote sheet is shown the rail lets go of it. `data-ws-sheet`
  // is the feed root's, set for as long as a sheet is shown or leaving.
  assert.match(WORKSHOP, /className="dev-ws-needs"\n\s*data-ws-needs=""\n\s*data-ws-sheet=\{shown \|\| undefined\}/);
  assert.match(CSS, /\n\.dev-ws-needs\[data-ws-sheet="vote"\] > \.dev-ws-rail \{ z-index: auto; \}/);
});

test('the wide layout keeps its own stacking: the 40 is the phone sheet\'s alone', () => {
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS)[1];
  assert.match(wide, /\.dev-ws-sheet-ask, \.dev-ws-sheet-comments, \.dev-ws-sheet-description \{\n\s*position: relative; inset: auto; flex: 0 0 400px; z-index: auto;/);
  assert.match(wide, /\.dev-ws-sheet-vote \{ position: absolute;[^}]*z-index: 6;/);
  assert.match(wide, /\.dev-ws-rail \{\n\s*position: relative; right: auto; bottom: auto; z-index: auto;/);
});

test('on a phone a tall sheet scrolls and the vote keeps its buttons on screen', () => {
  const phone = phoneBlock();
  assert.match(phone, /\.dev-ws-sheet-card \{ overflow-y: auto; overscroll-behavior: contain; \}/, 'the card scrolls, and the page behind it does not');
  // The action row is sticky at the card's foot and carries the clearance the
  // card's foot had, on the sheet's own fill.
  assert.match(phone, /\.dev-ws-sheet-vote \.dev-ws-vote-form > \.dev-vote-reason-actions \{\n\s*position: sticky; bottom: 0; z-index: 1;\n\s*padding-bottom: var\(--ws-vote-foot\);\n\s*background-color: var\(--dc-sheet\);/);
  assert.match(phone, /\.dev-ws-sheet-vote \.dev-ws-sheet-card:has\(> \.dev-ws-vote-form\) \{\n\s*--ws-vote-foot: calc\(22px \+ var\(--platform-safe-bottom, 0px\)\);\n\s*padding-bottom: 0;\n\s*scroll-padding-bottom: calc\(54px \+ var\(--ws-vote-foot\)\);/,
    'the foot is the home indicator, and a focused field scrolls in above the row, not under it');
  assert.match(phone, /\.dev-ws-needs\[data-ws-kb\] \.dev-ws-sheet-vote \.dev-ws-sheet-card:has\(> \.dev-ws-vote-form\) \{ --ws-vote-foot: 12px; \}/,
    'with the keys up the indicator is behind them');
  // 54px is the row above its foot: the form's 10px top padding and a 44px button.
  assert.match(CSS, /\.dev-ws-vote-form \.dev-vote-reason-actions \{ padding-top: 10px; gap: 8px; \}/);
  assert.match(CSS, /\.dev-ws-vote-form \.dev-vote-reason-cancel, \.dev-ws-vote-form \.dev-vote-reason-send \{ height: 44px;/);
});

test('the sticky row is a child of the form, so it can ride anywhere over the form', () => {
  // A sticky box moves only within its containing block. The row is the
  // picker's last child, directly in `.dev-ws-vote-form`, which spans the
  // switch, the line and the row: it can pin to the card's foot whatever
  // the form's height.
  const { reelRows } = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const { NeedsVoteForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const row = reelRows([{
    kind: 'proposal', id: 7, title: 'A change', summary: null, author: 'ada', number: 3, epoch: 1,
    at: null, yes: 0, no: 0, app: { slug: 'demo', name: 'Demo', icon_url: null, icon_emoji: null },
  }])[0];
  const noop = () => {};
  for (const side of ['yes', 'no']) {
    const html = renderToHtml(createElement(NeedsVoteForm, {
      row, side, line: '', onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
    }));
    assert.match(html, /^<div class="dev-ws-vote-form"[^>]*>/);
    assert.match(html, /<div class="dev-vote-reason-actions">(?:(?!<div)[\s\S])*<\/div><\/div>$/, `the action row closes the form (${side})`);
  }
});

test('the keyboard counts in the Homeroom app too', () => {
  // `[data-ws-kb]` lifts the cap and drops the indicator's clearance. It is
  // set from the kit's `un-kb` (Safari, Chrome: the keys cover the page) and
  // from the page's own `platform-kb-open` (the app: the page ends at them).
  assert.match(WORKSHOP, /const up = docEl\.classList\.contains\('un-kb'\) \|\| docEl\.classList\.contains\('platform-kb-open'\);/);
  assert.match(KB_OPEN, /export const KB_OPEN_CLASS = 'platform-kb-open';/, 'the class workshop.tsx names is the one keyboard-open.ts writes');
  assert.match(WORKSHOP, /data-ws-kb=\{kbUp \? '' : undefined\}/);
  assert.match(CSS, /\n\.dev-ws-needs\[data-ws-kb\] \.dev-ws-sheet-card \{ max-height: calc\(100% - var\(--platform-safe-top, 0px\)\); padding-bottom: 12px; \}/,
    'the whole strip above the keys, short of the status bar');
});

'use strict';

// #4554: THE FEEDBACK DIALOG AS A BOTTOM SHEET ON A PHONE.
//
// The form half of "Suggest an improvement" used to be the kit's centred
// modal on every screen. On a phone that meant a floating card over a page
// the keyboard was already covering, and the keyboard's own reveal panned
// the page under it. Now `useStaticModal` takes a `phoneSheet` option: when
// the keyboard handling's own phone test (`PHONE_QUERY`,
// lib/keyboard-open.ts) matches at open, the card is NOT lifted into the
// kit shell at all — it stays in its root, is named as a dialog (the same
// accessible name the kit shell would have carried), and `app.css`'s
// `[data-dialog-sheet]` rules bottom-anchor it and slide it up, with
// `.platform-kb-sheet`'s arithmetic keeping it clear of the keys.
//
// What is pinned here, each a way it can be quietly wrong:
//
//   1. The sheet is decided at open and only when the option is set AND the
//      phone test matches — a narrow desktop window keeps the kit modal.
//   2. Skipping the kit is real: `present(root` (the lift) is guarded, so
//      the card never leaves its root and nothing has to be restored.
//   3. The close waits for the slide-down before it hides the root and runs
//      `onExited` — teardown must not blank the card mid-slide — and is cut
//      short under reduced motion. A reopen inside the wait retires it.
//   4. The feedback dialog opts in, carries the grabber, and rides the
//      keyboard on its card.
//
// Run with: node --test tests/feedback-phone-sheet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const STATIC_MODAL = read('frontend/src/lib/static-modal.ts');
const USE_DIALOG = read('frontend/src/features/dialogs/use-dialog.ts');
const FEEDBACK = read('frontend/src/features/dialogs/feedback.tsx');
const APP_CSS = read('public/css/app.css');

test('the sheet is the phone test at open, and only for a dialog that opted in', () => {
  assert.match(STATIC_MODAL, /phoneSheet\?: boolean;/, 'the option exists');
  // The phone test is the keyboard handling's own, inlined rather than
  // imported — importing keyboard-open would run its keyboard tracker on
  // load, which a dialog presenting has no business starting.
  const kb = read('frontend/src/lib/keyboard-open.ts');
  const query = kb.match(/export const PHONE_QUERY = '([^']+)'/);
  assert.ok(query, 'keyboard-open publishes its phone test');
  assert.ok(STATIC_MODAL.includes(query[1]), 'static-modal asks the very same question');
  assert.match(STATIC_MODAL, /inlined rather than imported/);
  assert.match(STATIC_MODAL, /if \(opts\.current\.phoneSheet && isPhoneViewport\(\)\) \{\s*sheetRef\.current = true;\s*presentSheet\(root, stillOwns\);/,
    'decided at open, from the option and the screen together');
  // A matchMedia-less window (the suspend-exit test's, and old browsers)
  // reads as not-a-phone rather than throwing.
  assert.match(STATIC_MODAL, /typeof window\.matchMedia !== 'function'\) return false;/);
});

test('a sheet skips the kit lift entirely; without it the lift is unchanged', () => {
  const at = STATIC_MODAL.indexOf('if (!adoptionRef.current) {');
  assert.ok(at > 0, 'the presentation is still the one-time adoption');
  const open = STATIC_MODAL.slice(at, STATIC_MODAL.indexOf('} else {', at));
  assert.match(open, /if \(!sheetRef\.current\) \{\s*adoptionRef\.current = present\(root, dismissFromKit, stillOwns\);/,
    'the lift runs only when the presentation is not a sheet');
  assert.doesNotMatch(open, /\} else \{/, 'no else: the sheet path falls through to the guarded lift');
  assert.match(open, /presentSheet\(root, stillOwns\);\s*\}\s*if \(!sheetRef\.current\)/,
    'the sheet decision lands before the lift check');
});

test('the sheet card is named as a dialog the way the kit shell would', () => {
  const at = STATIC_MODAL.indexOf('function presentSheet(');
  const fn = STATIC_MODAL.slice(at, STATIC_MODAL.indexOf('\n}', at));
  assert.match(fn, /root\.dataset\.dialogSheet = '';/, 'the attribute app.css keys on');
  assert.match(fn, /card\.setAttribute\('role', 'dialog'\);/);
  assert.match(fn, /card\.setAttribute\('aria-modal', 'true'\);/);
  assert.match(fn, /aria-labelledby/, 'named from the card\'s heading when it has one');
  assert.match(fn, /aria-label/, 'or from its heading text when it has no id');
  assert.match(fn, /stillOwns\(\)\) root\.dataset\.dialogSheetShown = '';/,
    'the slide-up attribute lands a frame later, retired if the presentation was replaced');
});

test('the close waits for the slide-down, then hides and tears down', () => {
  const at = STATIC_MODAL.indexOf('} else {\n      if (sheetRef.current) {');
  assert.ok(at > 0, 'the close branch knows it was a sheet');
  const close = STATIC_MODAL.slice(at, STATIC_MODAL.indexOf('\n    }\n', at));
  assert.match(close, /delete root\.dataset\.dialogSheetShown;/,
    'the slide-down starts by taking `-shown` back');
  assert.match(close, /setTimeout\(\(\) => \{\s*if \(!stillOwns\(\)\) return;\s*root\.classList\.add\('hidden'\);/,
    'the hide waits for the slide (200ms), and a reopen inside the wait retires it');
  assert.match(close, /delete root\.dataset\.dialogSheet;\s*unnameSheet\(root\);\s*opts\.current\.onExited\?\.\(\);/,
    'teardown runs only after the card is off screen');
  assert.match(close, /reduced \? 0 : SHEET_TRANSITION_MS/,
    'cut short under reduced motion');
  // The sheet takes its own branch, so the no-kit exit in the else below —
  // gated on everOpenRef alone — is never a sheet's: its exit is the
  // slide-down, not the close tick.
  const sheetElse = close.indexOf('} else {', 10); // past the branch opener itself
  assert.ok(sheetElse > 0, 'the sheet close has its own branch');
  assert.match(close.slice(0, sheetElse), /setTimeout\(/,
    'the slide-down wait lives inside the sheet branch, before the else');
  assert.match(close.slice(sheetElse), /\} else if \(everOpenRef\.current\) \{/,
    'the no-kit exit keeps its pinned gate, untouched by the sheet');
});

test('app.css bottoms the card, slides it, and clears the keyboard', () => {
  const at = APP_CSS.indexOf('[data-dialog-sheet] { overflow: hidden; }');
  assert.ok(at > 0, 'the sheet rules exist');
  const block = APP_CSS.slice(at, APP_CSS.indexOf('/* THE COMMENT SHEET', at));
  assert.match(block, /\[data-dialog-sheet\] \[data-modal-backdrop\] > div \{[\s\S]*?transform: translateY\(100%\)/,
    'the card starts below the screen');
  assert.match(block, /\[data-dialog-sheet\]\[data-dialog-sheet-shown\] \[data-modal-backdrop\] > div \{[\s\S]*?transform: translateY\(0\)/,
    'and slides up once `-shown` lands');
  assert.match(block, /html\.platform-kb-open \[data-dialog-sheet\] \[data-modal-backdrop\] > div \{[\s\S]*?var\(--platform-kb-cover/,
    'the keyboard\'s band is cleared, the same arithmetic .platform-kb-sheet uses');
  assert.match(block, /max-height: calc\(100% - var\(--platform-vv-top, 0px\) - var\(--platform-kb-cover, 0px\) - 12px\)/,
    'and so is its height');
  assert.match(block, /\[data-dialog-sheet\] \.feedback-sheet-grabber \{[\s\S]*?display: block;/,
    'the grabber shows on a phone only');
  assert.match(block, /\[data-dialog-sheet\] \.feedback-actions \{[\s\S]*?position: sticky;/,
    'the actions row stays at the foot while the form scrolls');
});

test('the feedback dialog opts in and rides the keyboard on its card', () => {
  assert.match(FEEDBACK, /phoneSheet: true,/);
  assert.match(FEEDBACK, /<div aria-hidden="true" className="feedback-sheet-grabber" \/>/);
  assert.match(FEEDBACK, /useKeyboardSurface\(cardRef, \{ ride: true \}\);/);
  // The option travels through useDialog to useStaticModal.
  assert.match(USE_DIALOG, /phoneSheet\?: boolean;/);
  assert.match(USE_DIALOG, /phoneSheet: opts\.current\.phoneSheet,/);
});
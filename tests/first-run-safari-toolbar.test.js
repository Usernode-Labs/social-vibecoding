// The first run's sheet and full-screen steps meet Safari's toolbar the way
// a page does (Evan, 10 Oct 2026, iPhone 13 mini in Safari).
//
// 1. The sign-in sheet stood on the small viewport's foot (#4593), so it
//    ended over a band of the dim, with the page undimmed beneath the
//    toolbar under that. Its fill now carries on below it, past the foot of
//    the screen, with nothing in it moved.
// 2. The make and made screens are fixed boxes that ended above the
//    toolbar, cutting off what scrolled (Make it in half). They now run on
//    past the foot of the screen, with as much kept after the last line, so
//    the end scrolls up to where it stopped before.
//
// Run with: node --test tests/first-run-safari-toolbar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const APP_CSS = read('public/css/app.css');

test('the sign-in sheet\'s fill runs on to the foot of the screen', () => {
  const block = APP_CSS.slice(APP_CSS.indexOf('/* THE SIGN-IN SHEET RUNS TO THE FOOT OF THE SCREEN'));
  const rule = /@media \(max-width: 767px\) \{\s+\[data-sign-in-sheet\] > \.platform-kb-sheet \{\s+box-shadow: ([^;]+);\s+\}\s+\}/.exec(block);
  assert.ok(rule, 'phone only, on the sign-in sheet\'s own panel');
  // The hairline along the top only, then the fill: 20px down so the rounded
  // corners stay round, spread to clear the screen below and at the sides,
  // in the panel's own colour (PLANE_FILL).
  assert.equal(rule[1], 'inset 0 1px 0 var(--app-sheet-line), 0 calc(50vh + 20px) 0 50vh var(--dc-sheet-solid)');
  assert.match(read('frontend/@/components/ui/grouped-list.tsx'), /export const PLANE_FILL = 'bg-\[color:var\(--dc-sheet-solid\)\]';/);
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.match(sheet, /<div data-sign-in-sheet=\{step\}[^>]*className="fixed inset-0 z-50">/);
  assert.match(sheet, /className=\{`platform-kb-sheet absolute inset-x-0 bottom-0 [^`]*\$\{PLANE_FILL\}/);
  // Where the panel stands is #4593's, unchanged.
  assert.match(APP_CSS, /html \.platform-kb-sheet \{\s+bottom: max\(0px, calc\(100% - 100svh\)\);\s+max-height: 92svh;\s+\}/);
});

test('the make and made screens run on under the toolbar and scroll clear of it', () => {
  const block = APP_CSS.slice(APP_CSS.indexOf('/* THE MAKE AND MADE SCREENS RUN ON UNDER SAFARI\'S TOOLBAR'));
  const rules = block.slice(block.indexOf('@media (max-width: 767px) {'), block.indexOf('\n}\n') + 2);
  // In a phone browser on iOS, with the keys down (the keyboard surface
  // measures against the box as it was): 200px past its foot, a fixed
  // length, since on a 13 mini in Safari 26 `100lvh` came out shorter than
  // the box and `100% - 100lvh` extended nothing (#4691's first try).
  const scope = 'html.un-ios.web-browser-chrome:not(.platform-kb-open)';
  assert.ok(rules.includes(`${scope} :is([data-first-session-make], [data-first-session-made]) {\n    bottom: -200px;\n  }`));
  // The same 200px after the last line, in whatever scrolls, so the end
  // scrolls up to where it stopped before.
  assert.ok(rules.includes(`${scope} :is([data-first-session-make-scroll], [data-first-session-made]) {\n    padding-bottom: 200px;\n  }`));
  assert.doesNotMatch(rules, /lvh|svh/);
  // Those are the boxes: the make screen's root and scroller, the made
  // screen's root (which scrolls itself).
  const make = read('frontend/src/features/first-session/make.tsx');
  assert.match(make, /data-first-session-make=""/);
  assert.match(make, /<div ref=\{scrollerRef\} data-first-session-make-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto">/);
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /export const MADE_ROOT = 'fixed inset-0 z-\[9000\] flex flex-col overflow-y-auto /);
  assert.match(made, /data-first-session-made=""/);
});

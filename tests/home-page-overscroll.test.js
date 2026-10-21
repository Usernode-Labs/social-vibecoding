// The foot of Home gives on a phone (#3566).
//
// On iOS a scroll container only rubber-bands when it has scrollable RANGE.
// In the installed app and the native WebView #home-screen is the scroller
// (`overflow-y: auto`, features/home/index.tsx), and a short Home — a new
// account's — has none: the drag went to the document, which the bounded
// shell holds still, so the bottom edge refused to move at all. A project
// page already gives at its foot through one invisible pixel of absolute
// overflow (the "A SHORT TAB STILL HAS SOMETHING TO SCROLL" block in
// app.css); Home is the same trick.
//
// Three things have to be true at once, and each is pinned below:
//
//   1. The root carries the opt-in, so the pixel belongs to Home and not to
//      every scroller in the shell.
//   2. The pixel is OUT OF FLOW (position: absolute, 1px, below the root's
//      bottom edge) so nothing on the page shifts or resizes — and Home's
//      launcher grid, whose drag geometry is measured off #app-list, is
//      unmoved. `pointer-events: none` keeps it from taking a tap.
//   3. It is scoped to a touch screen and to where #home-screen is the
//      SCROLLER. In a phone browser `data-browser-scroller` on <html> makes
//      the root `overflow-y: visible`; the document scrolls and already
//      bounces, so the pixel would only lengthen the page. A mouse-driven
//      window would get a scrollbar out of it.
//
// Run with: node --test tests/home-page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const HOME = read('frontend/src/features/home/index.tsx');

const SEL = 'html:not([data-browser-scroller]) #home-screen[data-page-bounce]';

/** Every `@media (pointer: coarse)` block's body. */
function coarseBlocks() {
  const blocks = [];
  let i = CSS.indexOf('@media (pointer: coarse)');
  assert.ok(i >= 0, 'expected an `@media (pointer: coarse)` block in app.css');
  while (i >= 0) {
    // The block's own closing brace: count depth from the opening brace.
    const open = CSS.indexOf('{', i);
    let depth = 0;
    let end = -1;
    for (let j = open; j < CSS.length; j += 1) {
      if (CSS[j] === '{') depth += 1;
      else if (CSS[j] === '}') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    assert.ok(end > open, 'unterminated `@media (pointer: coarse)` block');
    blocks.push(CSS.slice(open + 1, end));
    i = CSS.indexOf('@media (pointer: coarse)', end);
  }
  return blocks;
}

/** The one `@media (pointer: coarse)` block the pixel lives in. */
function coarseBlock() {
  const found = coarseBlocks().filter((b) => b.includes('#home-screen[data-page-bounce]'));
  assert.equal(found.length, 1,
    'expected exactly one coarse-pointer block carrying the Home pixel rules');
  return found[0];
}

/** A rule's body, by exact selector text, inside a given scope. */
function ruleIn(scope, selector) {
  const i = scope.indexOf(`\n  ${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule inside \`@media (pointer: coarse)\``);
  return scope.slice(i, scope.indexOf('\n  }', i));
}

const COARSE = coarseBlock();
const ROOT_RULE = ruleIn(COARSE, SEL);
const PIXEL_RULE = ruleIn(COARSE, `${SEL}::after`);

// ── 1. The opt-in ──────────────────────────────────────────────────────

test('the home screen root opts in to the foot bounce', () => {
  const tag = HOME.match(/<main[^>]*id="home-screen"[^>]*>/);
  assert.ok(tag, 'expected the <main id="home-screen"> opening tag');
  assert.match(tag[0], /\bdata-page-bounce(=|>| )/,
    '#home-screen must carry data-page-bounce, or the scoped pixel never matches it');
  assert.match(tag[0], /style=\{\{\s*position:\s*'relative'\s*\}\}/,
    "Home's root states position: relative inline, which is the containing "
    + "block the pixel's absolute offsets resolve against");
});

// ── 2. The pixel, and what it must not do ──────────────────────────────

test('the pixel is an out-of-flow 1px box hung below the root', () => {
  assert.match(PIXEL_RULE, /content:\s*''/, 'the pseudo-element must have content to paint');
  assert.match(PIXEL_RULE, /position:\s*absolute/,
    'the pixel must be out of flow, or it reserves layout space and moves the page');
  assert.match(PIXEL_RULE, /left:\s*0/, 'flush with the root’s left edge');
  assert.match(PIXEL_RULE, /bottom:\s*-1px/,
    'hung 1px below the bottom edge: one pixel of scrollable overflow, invisible');
  assert.match(PIXEL_RULE, /width:\s*1px/);
  assert.match(PIXEL_RULE, /height:\s*1px/);
  assert.match(PIXEL_RULE, /pointer-events:\s*none/,
    'the pixel must take no taps, or it lands on the launcher grid');
});

test('the root is the containing block for the pixel', () => {
  assert.match(ROOT_RULE, /position:\s*relative/,
    'the absolute pixel offsets against the root’s padding box, so the root must be positioned');
});

// ── 3. The scope ───────────────────────────────────────────────────────

test('the pixel is scoped to a touch screen and to #home-screen being the scroller', () => {
  // ruleIn() above proves both selectors start with `html:not([data-browser-scroller])`,
  // which is the phone-browser exemption: there the root is not the scroller.
  // This proves the media scope: every copy of the selector is inside the
  // coarse-pointer block, so a mouse-driven window never gets the pixel.
  const all = [...CSS.matchAll(/#home-screen\[data-page-bounce\]/g)];
  const inside = [...COARSE.matchAll(/#home-screen\[data-page-bounce\]/g)];
  assert.ok(all.length >= 2, 'expected the root rule and the ::after rule');
  assert.equal(all.length, inside.length,
    'an unscoped copy of the rule would give a mouse-driven window a scrollbar');
});

// The home feed scrolls one way, and CSS does not give you that for free.
//
// ── The bug ────────────────────────────────────────────────────────────
//
// On a phone the home screen could be dragged left and right as well as up
// and down: a swipe sideways slid the whole feed a couple of pixels and
// rubber-banded it back. Two things had to be true at once.
//
//   1. #home-screen is `flex-1 overflow-y-auto` and nothing else, and CSS
//      turns that into a scroller on BOTH axes — `overflow` computes
//      `visible` to `auto` on one axis the moment the other stops being
//      `visible`. So the feed had always been a horizontal scroll container
//      by accident, waiting for something inside it to be a pixel too wide.
//
//   2. On a phone something is. `.un-touch-target` (native.css) grows any
//      control to a 44px hit box with an absolutely positioned ::after
//      CENTRED on it, so the ⋮ that opens an area's menu — `w-4`, 16px, and
//      the last thing in its row — reaches 14px past itself on each side.
//      The section's gutter is `px-3`, i.e. 12px. 12 < 14, so the box landed
//      2px beyond a 390px viewport and the screen measured 392px of
//      scrollWidth.
//
// ── What is pinned, and what is deliberately not ───────────────────────
//
// The FIX is the container: a vertical feed says so, rather than being one
// as long as nothing inside it happens to overhang. That is what these
// assert. The overhang itself is not a bug and is not pinned — it is a hit
// area, it is meant to hang off its control, and clipping costs 2px from the
// outside of a target that still extends 12px past a 16px button on that
// side.
//
// The arithmetic IS pinned, though, because it is the reason the rule cannot
// be dropped as belt and braces: as long as the kit's target is wider than
// twice the feed's gutter, the overhang is off-viewport by construction on
// every phone.
//
// Run with: node --test tests/home-vertical-scroll-only.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const NATIVE_CSS = read('public/usernode-native/v1/native.css');
const HOME = read('frontend/src/features/home/index.tsx');
const PANEL_UI = read('frontend/src/features/home/panels/ui.tsx');

/** A rule's body, by exact selector text (multi-line selectors included). */
function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector.replace(/\n/g, ' ')}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

const FEED = rule('#home-screen,\n#auth-landing-scroll');

// ── The fix ────────────────────────────────────────────────────────────

test('the home feed is not a horizontal scroll container', () => {
  assert.match(FEED, /overflow-x:\s*hidden/,
    '#home-screen and #auth-landing-scroll must state overflow-x, because '
    + 'overflow-y alone silently makes them scrollable sideways too');

  // Not `clip`, and the comment beside it says why: CSS Overflow 3 computes a
  // `clip` beside an `auto` on the other axis to `hidden` anyway, so writing
  // it would be a longer way to say the same thing. If a future edit does
  // reach for it, this is the note that saves the experiment.
  assert.doesNotMatch(FEED, /overflow-x:\s*clip/,
    'clip computes to hidden next to a scrolling axis — it buys nothing here');

  // The y axis is the point of the element and must not be touched.
  assert.doesNotMatch(FEED, /overflow-y:\s*hidden/, 'the feed still scrolls');
  assert.match(FEED, /overscroll-behavior-y:\s*contain/,
    'and it keeps the pull-to-refresh containment it already had');
});

test('the screen root still declares only its vertical scroll in markup', () => {
  // The fix lives in app.css beside the gesture rule it belongs with, not as
  // a utility on the island — so the class list is the one it always was.
  // If someone later adds `overflow-x-hidden` here too, that is fine, but the
  // root must never be left with overflow-y alone and no rule behind it.
  assert.match(HOME, /id="home-screen"[\s\S]{0,120}?overflow-y-auto/,
    '#home-screen is still the y-axis scroller');
});

// ── The arithmetic that makes the rule load-bearing ────────────────────

test('a 44px tap target on a 16px control cannot fit the feed gutter', () => {
  // The kit's hit box: centred on the control, at least 44px each way.
  const target = NATIVE_CSS.slice(NATIVE_CSS.indexOf('.un-touch-target::after'));
  const body = target.slice(0, target.indexOf('\n}'));
  const min = body.match(/width:\s*max\(100%,\s*(\d+)px\)/);
  assert.ok(min, '.un-touch-target::after states a minimum width');
  assert.match(body, /left:\s*50%/, 'and it is centred on the control…');
  assert.match(body, /transform:\s*translate\(-50%/, '…so it overhangs both sides');
  const hit = Number(min[1]);

  // The control: the ⋮ in a home area label.
  const btn = PANEL_UI.slice(PANEL_UI.indexOf('home-panel-menu'));
  const w = btn.match(/\bw-(\d+)\b/);
  assert.ok(w, 'the ⋮ states its width in Tailwind steps');
  const controlPx = Number(w[1]) * 4;

  // The gutter: the sections are px-3 inside the feed.
  const overhang = (hit - controlPx) / 2;
  const gutterPx = 3 * 4;
  assert.ok(overhang > gutterPx,
    `the hit box overhangs ${overhang}px and the gutter is ${gutterPx}px — `
    + 'if this ever stops being true the overflow-x rule is still correct, '
    + 'but this test no longer explains why it is load-bearing');
});

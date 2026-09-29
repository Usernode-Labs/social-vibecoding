// lib/anchor-popover.ts — where a popover goes under the button that opened
// it. Two callers share it: the dev board's vote popover and, on desktop, the
// Homeroom mark's menu (#2784). The vote popover's numbers are the ones this
// pins, because it was an inline copy of exactly this arithmetic until the
// menu needed the same placement.
//
// Run with: node --test tests/anchor-popover.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const { placeUnderAnchor } = loadTsx('frontend/src/lib/anchor-popover.ts');

const VIEW = { width: 1280, height: 800 };

test('right edges aligned, 6px below the button', () => {
  const rect = { top: 8, bottom: 36, right: 1264 };
  assert.deepEqual(placeUnderAnchor(rect, { width: 384, height: 400 }, VIEW),
    { top: 42, left: 880 });
});

test('clamped 8px inside the viewport on both sides', () => {
  assert.equal(placeUnderAnchor({ top: 8, bottom: 36, right: 100 },
    { width: 312, height: 190 }, VIEW).left, 8, 'a button near the left edge');
  assert.equal(placeUnderAnchor({ top: 8, bottom: 36, right: 1300 },
    { width: 312, height: 190 }, VIEW).left, 1280 - 312 - 8, 'and past the right one');
});

test('flips above when there is no room below — unless told not to', () => {
  const low = { top: 700, bottom: 728, right: 600 };
  const size = { width: 312, height: 190 };
  assert.equal(placeUnderAnchor(low, size, VIEW).top, 700 - 190 - 6,
    'the vote popover goes above a card near the fold');
  assert.equal(placeUnderAnchor(low, size, VIEW, { flip: false }).top, 734,
    'the header menu stays under its mark and caps its own height instead');
});

test('rounds to whole pixels', () => {
  const p = placeUnderAnchor({ top: 8.4, bottom: 36.4, right: 1263.6 },
    { width: 384, height: 100 }, VIEW);
  assert.ok(Number.isInteger(p.top) && Number.isInteger(p.left));
});

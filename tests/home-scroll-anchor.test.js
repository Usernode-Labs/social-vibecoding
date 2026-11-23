'use strict';
// Home keeps its place when the screen changes width (phone review, 23 Nov
// 2026, item 141): frontend/src/features/home/scroll-anchor.ts remembers the
// section at the top of the view and scrolls it back there after a width
// change, which WebKit (no overflow-anchor) did not do on the iPhone Duo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const mod = loadTsx('frontend/src/features/home/scroll-anchor.ts');
const part = (name, top, height) => ({ el: { name }, box: { top, bottom: top + height, height } });

test('the anchor is the first part still in view, with how far its top is from the view\'s', () => {
  const parts = [part('pinned', -900, 400), part('threads', -500, 450), part('challenges', -40, 160), part('featured', 140, 300)];
  const a = mod.pickAnchor(parts, 0);
  assert.equal(a.el.name, 'challenges');
  assert.equal(a.offset, -40);
  // A part with no height (hidden) is passed over.
  assert.equal(mod.pickAnchor([part('aside', 10, 0), part('featured', 20, 100)], 0).el.name, 'featured');
  assert.equal(mod.pickAnchor([part('pinned', -500, 100)], 0), null, 'nothing below the top edge');
});

test('after a width change the anchor goes back where it stood, and an anchor already there moves nothing', () => {
  const anchor = { el: {}, offset: -40 };
  // Unfolded, the same scroll offset left the challenges 520px further up.
  assert.equal(mod.anchorShift(anchor, -560, 0), -520);
  // The browser anchored it itself (Chromium): no second correction.
  assert.equal(mod.anchorShift(anchor, -40, 0), 0);
  assert.equal(mod.anchorShift(anchor, -40.4, 0), 0, 'less than a pixel is no move');
});

test('Home watches its scroller, and the sections it can anchor to are Home\'s own', () => {
  const index = fs.readFileSync(path.join(ROOT, 'frontend/src/features/home/index.tsx'), 'utf8');
  assert.match(index, /useEffect\(\(\) => keepHomeAnchor\(screenRef\.current,/);
  for (const sel of ['#home-apps-section', '#home-challenges-section', '[data-home-join-featured]']) {
    assert.ok(mod.ANCHORS.includes(sel), sel);
  }
});

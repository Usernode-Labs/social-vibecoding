'use strict';

// services/shots-closeups.js: the close-ups a run's after screens want (the
// New Needs you card's pieces too small for their still's density), and the
// check that keeps only a close-up of the after screen at that place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const closeups = require('../src/services/shots-closeups');

const root = path.join(__dirname, '..');
const screen = (regions, { width = 390, height = 844, shot = 'invite', viewport = 'phone' } = {}) => ({
  viewport, shot, stories: [shot], width, heightBefore: height, heightAfter: height,
  regions: regions.map(([x, y, w, h, story = shot]) => ({ story, b: [x, y, w, h], a: [x, y, w, h], bMark: null, aMark: null })),
});

test('the card\'s own rules: the same constants the New Needs you card draws with', () => {
  const model = fs.readFileSync(path.join(root, 'frontend/src/features/review-flow/model.ts'), 'utf8');
  const flow = fs.readFileSync(path.join(root, 'frontend/src/features/review-flow/review-flow.tsx'), 'utf8');
  const cover = /const COVER = \{ share: ([0-9.]+), wide: ([0-9.]+), pad: (\d+),/.exec(model);
  assert.ok(cover, 'model.ts COVER');
  assert.deepEqual([Number(cover[1]), Number(cover[2]), Number(cover[3])],
    [closeups.COVER.share, closeups.COVER.wide, closeups.COVER.pad]);
  assert.match(flow, new RegExp(`const height = Math\\.round\\(width \\* ${closeups.TITLE_SHAPE}\\);`), 'the title shot\'s shape');
  assert.deepEqual(closeups.CARDS.map((card) => [card.w, card.dpr]), [[358, 3], [488, 2]]);
});

test('a piece too small for its still\'s density is wanted at the density the card needs, its 16 px framed', () => {
  const asked = closeups.wanted([screen([[60, 200, 40, 40]])], () => 3);
  assert.equal(asked.length, 1);
  const [ask] = asked;
  assert.deepEqual([ask.change, ask.screen, ask.part], ['invite', 'phone', 1]);
  // 40 x 40 widened to the lines around it (56 tall), then 16 px all round.
  assert.deepEqual(ask.rect, { x: 44, y: 176, w: 72, h: 88 });
  assert.equal(ask.scale, closeups.neededDensity(ask.rect));
  assert.ok(ask.scale > 3 && ask.scale <= closeups.MAX_SCALE);
  assert.equal(Math.round(ask.scale * 10), ask.scale * 10, 'one decimal');
  // A piece the still is dense enough for wants nothing, and a 1x still
  // wants close-ups only where the card zooms past 1x.
  assert.deepEqual(closeups.wanted([screen([[0, 0, 380, 700]])], () => 3), []);
  assert.ok(closeups.wanted([screen([[60, 200, 40, 40]])], () => 1).length === 1);
});

test('at most 2 a screen, the most wanted first, at most 6 a run, and never past 4 MP', () => {
  const crowded = screen([[10, 10, 20, 20], [200, 300, 30, 30], [100, 600, 60, 40]]);
  const asked = closeups.wanted([crowded], () => 3);
  assert.equal(asked.length, closeups.MAX_PER_SCREEN);
  assert.deepEqual(asked.map((ask) => ask.part), [1, 2]);
  assert.ok(asked[0].scale >= asked[1].scale);
  const many = Array.from({ length: 5 }, (_, i) => screen([[10, 10, 20, 20], [200, 300, 30, 30]], { shot: `c${i}` }));
  assert.equal(closeups.wanted(many, () => 3).length, closeups.MAX_PER_RUN);
  // The density is held to the pixel cap.
  assert.equal(closeups.captureScale({ w: 1000, h: 1000 }, 9), 2);
  assert.equal(closeups.captureScale({ w: 46, h: 72 }, 7), 7);
  assert.equal(closeups.captureScale({ w: 10, h: 10 }, 40), closeups.MAX_SCALE);
  for (const ask of closeups.wanted(many, () => 3)) {
    assert.ok(ask.rect.w * ask.rect.h * ask.scale ** 2 <= closeups.MAX_PIXELS);
  }
});

test('the pieces are the card\'s: unnumbered areas only when no change claims one, near ones merged, specks dropped', () => {
  const pieces = closeups.piecesOf(screen([
    [50, 100, 100, 60], [160, 110, 20, 20], [300, 700, 4, 4], [10, 400, 200, 80, null],
  ]));
  // The two near areas are one piece; the 4 x 4 speck and the unnumbered one are not pieces.
  assert.deepEqual(pieces, [{ x: 50, y: 100, w: 130, h: 60 }]);
  assert.deepEqual(closeups.piecesOf(screen([[10, 400, 200, 80, null]])), [{ x: 10, y: 400, w: 200, h: 80 }]);
});

// A scene of solid blocks, drawn at any density.
const BLOCKS = [[50, 40, 30, 12, [37, 99, 235]], [90, 44, 14, 14, [220, 38, 38]], [60, 60, 50, 6, [30, 30, 40]]];
function drawn(w, h, k, blocks = BLOCKS, ox = 0, oy = 0) {
  const png = new PNG({ width: Math.round(w * k), height: Math.round(h * k) });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const cx = ox + x / k; const cy = oy + y / k;
      const hit = blocks.find(([bx, by, bw, bh]) => cx >= bx && cx < bx + bw && cy >= by && cy < by + bh);
      const c = hit ? hit[4] : [250, 250, 252];
      const i = (y * png.width + x) * 4;
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test('a close-up is kept only when, averaged down, it is the after screen at that place', () => {
  const still = drawn(200, 120, 1);
  const rect = { x: 40, y: 30, w: 80, h: 44 };
  assert.equal(closeups.matches(still, drawn(rect.w, rect.h, 6.4, BLOCKS, rect.x, rect.y), rect), true);
  // A page that moved a little still matches within the slack.
  assert.equal(closeups.matches(still, drawn(rect.w, rect.h, 6.4, BLOCKS, rect.x + 2, rect.y - 1), rect), true);
  // Another place, or another page, does not.
  assert.equal(closeups.matches(still, drawn(rect.w, rect.h, 6.4, BLOCKS, rect.x + 30, rect.y), rect), false);
  assert.equal(closeups.matches(still, drawn(rect.w, rect.h, 6.4, [[40, 30, 80, 44, [0, 160, 0]]], rect.x, rect.y), rect), false);
});

test('averaging down keeps a block\'s mean colour at any ratio', () => {
  const png = PNG.sync.read(drawn(10, 10, 3.3));
  const small = closeups.resample(png, 10, 10);
  assert.deepEqual([small.w, small.h, small.d.length], [10, 10, 400]);
  assert.deepEqual([...small.d.subarray(0, 4)], [250, 250, 252, 255]);
});

test('a close-up of the before state is refused even when the change is a speck of its frame', () => {
  const dot = [[100, 50, 6, 6, [220, 38, 38]]];
  const rect = { x: 80, y: 30, w: 70, h: 56 };
  const after = drawn(200, 120, 1, [...BLOCKS, ...dot]);
  const before = drawn(200, 120, 1, BLOCKS);
  const ofBefore = drawn(rect.w, rect.h, 7, BLOCKS, rect.x, rect.y);
  const ofAfter = drawn(rect.w, rect.h, 7, [...BLOCKS, ...dot], rect.x, rect.y);
  // The dot is under 1% of the frame: the share alone would let the before through.
  assert.equal(closeups.matches(after, ofBefore, rect), true);
  assert.equal(closeups.matches(after, ofBefore, rect, { beforeStill: before }), false);
  assert.equal(closeups.matches(after, ofAfter, rect, { beforeStill: before }), true);
});

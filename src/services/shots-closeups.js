'use strict';

// Close-ups: a change too small for its screen still's density, captured
// again on its own at the density the New Needs you card zooms it to.
//
// The card (frontend/src/features/review-flow/model.ts piecesOf,
// composeTitle) shows each changed area of a screen's after still as a
// piece, as large as fits, but never past the pixels the still has
// (densityOf). A badge or a count 50 px wide wants 8-9 device pixels per CSS
// pixel; a screen still has 3. The close-up capture design (2026-10-21)
// measured that on 21 production runs, and Lukas chose: platform-directed
// close-ups of the after side only, at most 2 a screen, 6 a run, 4 MP each.
//
// Only in a run taken at device density (services/shots-density.js): once a
// change's before and after screen shots are both saved, this works out the
// card's pieces on that screen and the density each needs (`wanted`); the
// shots bridge takes each in the browser, through Chrome's own
// Page.captureScreenshot clip.scale (worker/patch-playwright-mcp-
// screenshot.js), and the platform keeps one only when, averaged down, it is
// the after still at that place (`matches`): a close-up of anything else, the
// page having moved on, is refused.
//
// Pure apart from PNG decoding. Everything is CSS pixels of the after screen.

const { PNG } = require('pngjs');
const diff = require('./shots-diff');

const MAX_PER_SCREEN = 2;
const MAX_PER_RUN = 6;
const MAX_PIXELS = 4_000_000;
const MAX_SCALE = 16;
// The card's own rules (model.ts COVER: a single piece's binding side gets
// 62% of the card, or its real size when that fits within 92%; 16 px of real
// surroundings), the title shot's shape (review-flow.tsx TitleShot: width x
// 0.75), and the two cards it is drawn on: 358 wide on a phone (3 device
// pixels per CSS pixel), 488 on a desktop (2). tests/shots-closeups.test.js
// holds these to the client's source.
const COVER = Object.freeze({ share: 0.62, wide: 0.92, pad: 16 });
const TITLE_SHAPE = 0.75;
const CARDS = Object.freeze([
  Object.freeze({ w: 358, h: 358 * TITLE_SHAPE, dpr: 3 }),
  Object.freeze({ w: 488, h: 488 * TITLE_SHAPE, dpr: 2 }),
]);
// A close-up at this density or less is no better than the screen still.
const NEAR = 0.05;
// How far a close-up may sit from where it was asked for (CSS px), and the
// share of its pixels that may differ from the after still there: text
// edges average a little differently from 3x and from 8x (measured
// 2026-10-21 on real text: 0.4% to 3.8%).
const SLACK = 2;
const MAX_DIFFERING = 0.06;
const TOLERANCE = 28;

const area = (b) => b.w * Math.max(b.h, 2);
const near = (a, b, gap) => a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
const union = (a, b) => {
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

// model.ts piecesOf, for one screen of shots-diff.screensFor: the areas
// that belong to a declared change, near ones merged, specks dropped, a thin
// strip widened to the lines around it.
function piecesOf(screen) {
  const W = screen.width;
  const H = screen.heightAfter;
  const all = (screen.regions || []).filter((r) => Array.isArray(r.a))
    .map((r) => ({ named: r.story !== null && r.story !== undefined, b: { x: r.a[0], y: r.a[1], w: r.a[2], h: r.a[3] } }))
    .filter((x) => x.b.w > 2);
  const named = all.filter((x) => x.named);
  const merged = [];
  for (const b of (named.length ? named : all).map((x) => x.b).sort((p, q) => area(q) - area(p))) {
    const hit = merged.findIndex((m) => near(m, b, 24));
    if (hit >= 0) merged[hit] = union(merged[hit], b);
    else merged.push(b);
  }
  const biggest = merged.length ? area(merged[0]) : 0;
  return merged.filter((b) => area(b) >= biggest * 0.04).slice(0, 6).map((b) => {
    let { y, h } = b;
    const minH = Math.min(H, Math.max(56, b.w / 3.2));
    if (h < minH) { y = Math.max(0, Math.min(H - minH, y - (minH - h) / 2)); h = minH; }
    const x = Math.max(0, b.x);
    return { x, y, w: Math.min(W - x, b.w), h };
  });
}

// The piece with its 16 px of surroundings, kept on the screen, in whole
// pixels: what the camera frames.
function framed(piece, screen) {
  const x0 = Math.max(0, Math.floor(piece.x - COVER.pad));
  const y0 = Math.max(0, Math.floor(piece.y - COVER.pad));
  const x1 = Math.min(screen.width, Math.ceil(piece.x + piece.w + COVER.pad));
  const y1 = Math.min(screen.heightAfter, Math.ceil(piece.y + piece.h + COVER.pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// model.ts singleScale with nothing capping it: card points per CSS pixel.
function cardScale(box, card) {
  const framedS = COVER.share * Math.min(card.w / box.w, card.h / box.h);
  const real = Math.min(1, COVER.wide * card.w / box.w, COVER.wide * card.h / box.h);
  return Math.min(Math.max(framedS, real), COVER.wide * card.w / box.w, COVER.wide * card.h / box.h);
}

// Device pixels per CSS pixel the card needs to draw `box` sharp, on the
// card that needs the most, to one decimal, rounded up.
function neededDensity(box) {
  return Math.max(...CARDS.map((card) => Math.ceil(cardScale(box, card) * card.dpr * 10 - 1e-9) / 10));
}

// What to capture of `box` at `need`: no more than MAX_PIXELS and
// MAX_SCALE, to one decimal, rounded down.
function captureScale(box, need) {
  const fit = Math.sqrt(MAX_PIXELS / (box.w * box.h));
  return Math.floor(Math.min(need, fit, MAX_SCALE) * 10) / 10;
}

/**
 * The close-ups a run's after screens want, in the order they are worth
 * taking: per screen (a change and screen size whose after still the card
 * shows), the pieces whose needed density is above the still's, the most
 * wanted first, at most MAX_PER_SCREEN, and at most MAX_PER_RUN in all.
 * `screens` are shots-diff.screensFor's; `stillDensity(screen)` is the
 * after still's density.
 */
function wanted(screens, stillDensity) {
  const out = [];
  for (const screen of screens || []) {
    const have = Number(stillDensity(screen)) || 1;
    const asks = piecesOf(screen).map((piece) => {
      const rect = framed(piece, screen);
      return { rect, need: neededDensity(rect) };
    }).filter((ask) => ask.rect.w >= 4 && ask.rect.h >= 4)
      .map((ask) => ({ ...ask, scale: captureScale(ask.rect, ask.need) }))
      .filter((ask) => ask.scale > have + NEAR)
      .sort((a, b) => b.need - a.need)
      .slice(0, MAX_PER_SCREEN);
    asks.forEach((ask, index) => out.push({
      change: screen.shot, screen: screen.viewport, part: index + 1, rect: ask.rect, scale: ask.scale,
    }));
  }
  return out.sort((a, b) => b.scale - a.scale).slice(0, MAX_PER_RUN);
}

// A PNG averaged down to `w` x `h` (each output pixel the mean of the
// source pixels it covers).
function resample(png, w, h) {
  const fx = png.width / w;
  const fy = png.height / h;
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * fy); const y1 = Math.max(y0 + 1, Math.min(png.height, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * fx); const x1 = Math.max(x0 + 1, Math.min(png.width, Math.floor((x + 1) * fx)));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let i = (sy * png.width + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1, i += 4) { r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n += 1; }
      }
      const o = (y * w + x) * 4;
      d[o] = Math.round(r / n); d[o + 1] = Math.round(g / n); d[o + 2] = Math.round(b / n); d[o + 3] = 255;
    }
  }
  return { w, h, d };
}

// The least share of `crop`'s pixels that differ from `still` at `rect`,
// within SLACK pixels of it; 1 where the rect does not fit the still.
function differing(still, crop, rect) {
  const screen = diff.decode(still, 1);
  let best = 1;
  for (let dy = -SLACK; dy <= SLACK; dy += 1) {
    for (let dx = -SLACK; dx <= SLACK; dx += 1) {
      const ox = rect.x + dx; const oy = rect.y + dy;
      if (ox < 0 || oy < 0 || ox + rect.w > screen.w || oy + rect.h > screen.h) continue;
      let off = 0;
      for (let y = 0; y < rect.h; y += 1) {
        for (let x = 0; x < rect.w; x += 1) {
          const i = ((oy + y) * screen.w + ox + x) * 4; const j = (y * rect.w + x) * 4;
          if (Math.max(Math.abs(screen.d[i] - crop.d[j]), Math.abs(screen.d[i + 1] - crop.d[j + 1]),
            Math.abs(screen.d[i + 2] - crop.d[j + 2])) > TOLERANCE) off += 1;
        }
      }
      best = Math.min(best, off / (rect.w * rect.h));
    }
  }
  return best;
}

/**
 * Whether `closeup`, a PNG of `rect`, is the after still (`afterStill`, its
 * 1x copy) at that place: averaged down to the rect's size, at most
 * MAX_DIFFERING of its pixels differ from it, and it is closer to it than to
 * the before still there (`beforeStill`), which a close-up taken after the
 * page went back to the before state, or of a small change gone, is not.
 */
function matches(afterStill, closeup, rect, { beforeStill = null } = {}) {
  const crop = resample(PNG.sync.read(closeup), rect.w, rect.h);
  const after = differing(afterStill, crop, rect);
  if (after > MAX_DIFFERING) return false;
  return !beforeStill || after < differing(beforeStill, crop, rect);
}

module.exports = {
  MAX_PER_SCREEN, MAX_PER_RUN, MAX_PIXELS, MAX_SCALE, COVER, TITLE_SHAPE, CARDS,
  piecesOf, framed, cardScale, neededDensity, captureScale, wanted, resample, matches,
};

'use strict';

// 20 Nov: how a before/after picture loads, from the copies a saved still
// keeps to the slots that draw it, on a realistic shots row.
//
// - The screen copy is a progressive JPEG at most 1200 px WIDE
//   (src/services/shots-sized.js). It was 1200 on the long side, so a phone
//   screen's copy came out 554 px wide and every phone and Retina screen
//   fell through to the whole PNG.
// - A slot draws the thumbnail over the 20 px preview until the picture
//   arrives: blur, then soft, then sharp (frontend/src/lib/shot-img.ts,
//   public/js/app-view.js).
// - A copy as wide as the original takes its place in srcset, so the PNG is
//   only ever the fallback.
// - The review page's plates and the change page's tiles load a copy their
//   own size, not the whole PNG (review-flow/model.ts, thread-picture.tsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const sized = require('../src/services/shots-sized');
const view = require('../src/services/shots-view');
const AppView = require('../public/js/app-view.js');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const compare = loadTsx('frontend/src/features/review-flow/compare.tsx');
const model = loadTsx('frontend/src/features/review-flow/model.ts');
const picture = loadTsx('frontend/src/features/dev-board/topic/thread-picture.tsx');
const shotImg = loadTsx('frontend/src/lib/shot-img.ts');

// A screen-like PNG: a header band, rows of "text" and margins (as
// tests/shots-sized.test.js draws one), and a picture across the middle, a
// soft gradient with grain, as a screen with a photo or an avatar has. A
// screen of flat colour alone compresses so well as a PNG that no JPEG is
// smaller, and then no screen copy is kept, rightly.
function screenPng(width, height, { alpha = 255 } = {}) {
  const png = new PNG({ width, height });
  let seed = 7;
  const grain = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 24;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) << 2;
      const row = Math.floor(y / 24);
      let [r, g, b] = y < height * 0.08 ? [244, 244, 245]
        : (x < width * 0.08 || x > width * 0.92) ? [250, 250, 250]
          : (row % 3 === 1 && y % 24 < 8) ? [113, 113, 122] : [255, 255, 255];
      if (y > height * 0.3 && y < height * 0.6) {
        const n = grain();
        [r, g, b] = [clamp(90 + 120 * x / width + n), clamp(140 + 60 * y / height + n), clamp(180 - 80 * x / width + n)];
      }
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = alpha;
    }
  }
  return PNG.sync.write(png);
}

// The JPEG's frame type and each component's sampling: SOF2 is progressive,
// and 0x11 for all three components is 4:4:4.
function jpegFrame(data) {
  for (let i = 2; i < data.length - 9; i++) {
    if (data[i] !== 0xFF) continue;
    const marker = data[i + 1];
    if (marker === 0xC0 || marker === 0xC2) {
      const count = data[i + 9];
      const sampling = [];
      for (let c = 0; c < count; c++) sampling.push(data[i + 11 + c * 3]);
      return { progressive: marker === 0xC2, sampling };
    }
  }
  return null;
}

test('a phone still\'s screen copy is a progressive 4:4:4 JPEG as wide as the screen', async () => {
  const source = screenPng(1170, 2532);
  const copies = await sized.sizedCopies(source);
  assert.equal(copies.screen.contentType, 'image/jpeg');
  assert.equal(copies.screen.data[0], 0xFF);
  assert.equal(copies.screen.data[1], 0xD8, 'a JPEG');
  assert.deepEqual(jpegFrame(copies.screen.data), { progressive: true, sampling: [0x11, 0x11, 0x11] },
    'progressive, with no chroma halved');
  // 1200 px wide at most, never enlarged: a 3x phone screen keeps its 1170.
  assert.equal(copies.screen.width, 1170);
  assert.equal(copies.screen.height, 2532);
  assert.ok(copies.screen.bytes < source.length, 'smaller than the PNG');
  // The thumbnail and the preview are as they were.
  assert.equal(copies.thumb.contentType, 'image/webp');
  assert.equal(Math.max(copies.thumb.width, copies.thumb.height), sized.THUMB_EDGE);
  assert.match(copies.placeholder, /^data:image\/webp;base64,/);

  // A screen of flat colour alone is smaller as its PNG than as any JPEG:
  // no screen copy, so a slot takes the thumbnail or the PNG.
  const flat = new PNG({ width: 1170, height: 2532 });
  flat.data.fill(255);
  assert.equal((await sized.sizedCopies(PNG.sync.write(flat))).screen, null);

  // A desktop still at 2x is cut to 1200 px wide.
  const desktop = await sized.sizedCopies(screenPng(2560, 1600));
  assert.equal(desktop.screen.width, sized.SCREEN_EDGE);
  assert.equal(desktop.screen.height, 750);
  assert.equal(desktop.screen.contentType, 'image/jpeg');
});

test('a still with transparent pixels keeps a WebP screen copy, since a JPEG has none', async () => {
  const copies = await sized.sizedCopies(screenPng(1170, 2532, { alpha: 128 }));
  assert.equal(copies.screen.contentType, 'image/webp');
  assert.equal(copies.screen.data.subarray(8, 12).toString('latin1'), 'WEBP');
  // An alpha channel that is all opaque is still a JPEG.
  const opaque = await sized.sizedCopies(screenPng(1170, 2532, { alpha: 255 }));
  assert.equal(opaque.screen.contentType, 'image/jpeg');
});

// A shots row as the shots view sends it (services/shots-view.js), for one
// phone screen saved with this change's copies.
async function shotsRow({ copies = true, oldScreen = false } = {}) {
  const made = await sized.sizedCopies(screenPng(1170, 2532));
  const artifact = (side, char) => ({
    id: char.repeat(32), storyId: 'join', viewport: 'mobile', side, variant: 'context', media: 'png',
    contentType: 'image/png', width: 1170, height: 2532, density: 3, denseWidth: 1170, denseHeight: 2532,
    ...(copies ? {
      thumbWidth: made.thumb.width, thumbHeight: made.thumb.height,
      // A still saved before this change: its screen copy is 555 px wide.
      screenWidth: oldScreen ? 555 : made.screen.width, screenHeight: oldScreen ? 1200 : made.screen.height,
      placeholder: made.placeholder,
    } : {}),
  });
  const artifacts = view.cleanArtifacts([artifact('base', 'a'), artifact('head', 'b')],
    { slug: 'plant-pal', sessionId: 7, verified: true, dense: true });
  return {
    made,
    shots: {
      state: 'verified',
      claims: [{ id: 'join', claim: 'The join button says who is in.', viewports: ['mobile'] }],
      artifacts,
      screens: [{
        viewport: 'mobile', shot: 'join', stories: ['join'], width: 390, heightBefore: 844, heightAfter: 844, density: 3,
        regions: [{ story: 'join', b: [16, 500, 358, 44], a: [16, 500, 358, 60], bMark: null, aMark: null }],
      }],
    },
  };
}

const base = (char) => `/api/apps/plant-pal/proposals/7/shots/${char.repeat(32)}`;

test('a review screen carries the copies, and the PNG only as the fallback', async () => {
  const { made, shots } = await shotsRow();
  const v = AppView._workshopVisuals(null, shots);
  const after = v.screens[0].after;
  assert.equal(after.url, `${base('b')}?density=device`, 'the PNG stays the url');
  assert.equal(after.srcSet, `${base('b')}?size=thumb ${made.thumb.width}w, ${base('b')}?size=screen 1170w`,
    'the screen copy is as wide as the PNG, so the PNG is not listed');
  assert.equal(after.thumb, `${base('b')}?size=thumb`);
  assert.equal(after.placeholder, made.placeholder);
  // The React side's helper makes the same list from the same row.
  const artifact = shots.artifacts.find((a) => a.side === 'head');
  assert.equal(shotImg.shotSrcSet(artifact), after.srcSet);

  // A still saved before this change keeps its 555 px WebP copy, which is
  // narrower than the PNG, so the PNG is still listed for a sharp slot.
  const old = AppView._workshopVisuals(null, (await shotsRow({ oldScreen: true })).shots).screens[0].after;
  assert.equal(old.srcSet, `${base('b')}?size=thumb ${made.thumb.width}w, ${base('b')}?size=screen 555w, ${base('b')}?density=device 1170w`);
  // And one from before the copies existed lists nothing and loads its url.
  const none = AppView._workshopVisuals(null, (await shotsRow({ copies: false })).shots).screens[0].after;
  assert.equal(none.srcSet, undefined);
  assert.equal(none.thumb, undefined);
});

test('the change page\'s picture draws the thumbnail over the preview until it is sharp', async () => {
  const { made, shots } = await shotsRow();
  const screen = AppView._workshopVisuals(null, shots).screens[0];
  const html = renderToHtml(createElement(compare.CompareSlider, {
    screen, ground: model.GROUNDS.quiet, width: 390, height: 600, marks: false,
    place: { scale: 1, tx: 0, ty: -200 },
  }));
  const imgs = html.match(/<img[^>]*class="rf-shot-img"[^>]*>/g) || [];
  assert.equal(imgs.length, 2, 'both sides are drawn');
  const after = imgs.find((img) => img.includes(base('b')));
  assert.match(after, new RegExp(`srcSet="${base('b')}\\?size=thumb ${made.thumb.width}w, ${base('b')}\\?size=screen 1170w"`.replace(/\//g, '\\/')));
  assert.match(after, /sizes="390px"/);
  // Two layers: the thumbnail first (on top), the 20 px preview under it,
  // each stretched to the whole screen's box.
  assert.match(after, new RegExp(`background-image:url\\(&quot;${base('b').replace(/\//g, '\\/')}\\?size=thumb&quot;\\), url\\(&quot;data:image\\/webp;base64,`));
  assert.match(after, /background-size:100% 100%, 100% 100%/);
  assert.match(after, /background-position:0 0, 0 0/);
});

test('the review page\'s plates take a copy their own size, not the PNG', async () => {
  const { made, shots } = await shotsRow();
  const screens = AppView._workshopVisuals(null, shots).screens;
  const plates = model.composeSheet(screens, { w: 390, h: 560 });
  const plate = plates.find((p) => p.img);
  assert.ok(plate, 'the sheet draws the screen');
  assert.equal(plate.img.url, `${base('b')}?density=device`, 'the PNG stays the fallback');
  assert.equal(plate.img.srcSet, `${base('b')}?size=thumb ${made.thumb.width}w, ${base('b')}?size=screen 1170w`);
  assert.equal(plate.img.sizes, `${Math.round(plate.img.width)}px`, 'sized at the width the plate draws the screen');
  // The review page renders those onto the plate's <img>.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend/src/features/review-flow/review-flow.tsx'), 'utf8');
  assert.match(src, /<img src=\{p\.img\.url\} srcSet=\{p\.img\.srcSet\} sizes=\{p\.img\.sizes\}/);
});

test('the change page\'s tiles load the thumbnail, not the PNG', async () => {
  const { shots } = await shotsRow();
  const screens = AppView._workshopVisuals(null, shots).screens;
  const two = [screens[0], { ...screens[0], viewport: 'mobile-2' }];
  const html = renderToHtml(createElement(picture.ThreadPicture, { s: { screens: two, changes: [] } }));
  const tiles = html.match(/<button[^>]*class="dev-thread-tile"[^>]*>\s*<img[^>]*>/g) || [];
  assert.equal(tiles.length, 2);
  for (const tile of tiles) {
    assert.match(tile, new RegExp(`src="${base('b').replace(/\//g, '\\/')}\\?size=thumb"`));
  }
});

test('the full viewer draws the same layers', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  assert.match(src, /const layers = \[AppView\._shotThumb\(artifact\), AppView\._shotPlaceholder\(artifact\)\]\.filter\(Boolean\);/);
  assert.equal(AppView._shotThumb({ sizes: [{ size: 'thumb', url: `${base('c')}?size=thumb`, width: 277 }] }), `${base('c')}?size=thumb`);
  assert.equal(AppView._shotThumb({ sizes: [{ size: 'thumb', url: 'https://example.com/x.webp', width: 277 }] }), '');
  assert.equal(AppView._shotThumb({}), '');
});

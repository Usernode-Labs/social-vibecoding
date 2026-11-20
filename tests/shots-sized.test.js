'use strict';

// services/shots-sized.js (#6825): a still's two smaller copies and its
// blurred preview. A card's slot used to load the whole screen shot (a 1170
// x 2532 PNG of several hundred KB); it now loads a WebP its own size, and
// draws a 20 px preview while that arrives. The screen copy is a progressive
// JPEG since 20 Nov: tests/shot-loading.test.js covers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const sized = require('../src/services/shots-sized');

// A screen-like PNG: a header band, rows of "text", a picture block — what a
// screen shot compresses like, rather than noise, which no image format
// shrinks.
function screenPng(width, height) {
  const png = new PNG({ width, height });
  const put = (x, y, [r, g, b]) => {
    const i = (y * width + x) << 2;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const row = Math.floor(y / 24);
      if (y < height * 0.08) put(x, y, [244, 244, 245]);
      else if (x < width * 0.08 || x > width * 0.92) put(x, y, [250, 250, 250]);
      else if (row % 3 === 1 && y % 24 < 8) put(x, y, [113, 113, 122]);
      else put(x, y, [255, 255, 255]);
    }
  }
  return PNG.sync.write(png);
}

test('a 3x phone still gets a thumbnail and a preview', async () => {
  const source = screenPng(1170, 2532);
  const copies = await sized.sizedCopies(source);
  assert.ok(copies.thumb, 'a thumbnail is made');
  // This flat drawing is smaller as its PNG than as any JPEG, so it keeps no
  // screen copy (tests/shot-loading.test.js draws one that does).
  assert.equal(copies.screen, null);
  // WebP: RIFF....WEBP.
  for (const copy of [copies.thumb]) {
    assert.equal(copy.data.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(copy.data.subarray(8, 12).toString('latin1'), 'WEBP');
    assert.equal(copy.bytes, copy.data.length);
    assert.match(copy.sha256, /^[a-f0-9]{64}$/);
    assert.ok(copy.bytes < source.length, 'a copy is smaller than the original');
  }
  // The thumbnail is 600 px on its long side.
  assert.equal(Math.max(copies.thumb.width, copies.thumb.height), sized.THUMB_EDGE);
  assert.equal(copies.thumb.contentType, 'image/webp');
  // The preview travels inside the shots view: a 20 px wide WebP, under 1.4 KB.
  assert.match(copies.placeholder, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(copies.placeholder.length <= sized.MAX_PLACEHOLDER);
  assert.ok(copies.placeholder.length < 1024, 'the preview is under 1 KB');
});

test('a Needs you card\'s two pictures come to well under 80 KB', async () => {
  const before = screenPng(1170, 2532);
  const after = screenPng(1170, 2532);
  // The card's slot is about 84 CSS px wide: it takes the thumbnail.
  const one = await sized.sizedCopies(before);
  const two = await sized.sizedCopies(after);
  assert.ok(one.thumb && two.thumb);
  assert.ok(one.thumb.bytes + two.thumb.bytes < 80 * 1024,
    `${one.thumb.bytes + two.thumb.bytes} bytes for the pair`);
});

test('a still already small enough is not copied, and a failure saves nothing', async () => {
  const tiny = screenPng(300, 400);
  const copies = await sized.sizedCopies(tiny);
  assert.equal(copies.thumb, null, 'no thumbnail of a still smaller than one');
  assert.equal(copies.screen, null, 'no screen copy of a still smaller than one');
  assert.ok(copies.placeholder, 'its preview is still made');

  const broken = await sized.sizedCopies(Buffer.from('not a PNG at all'));
  assert.deepEqual(broken, { thumb: null, screen: null, placeholder: null });
  assert.deepEqual(await sized.sizedCopies(null), { thumb: null, screen: null, placeholder: null });
});

test('the widths the view lists are the copies\' own pixels', async () => {
  const copies = await sized.sizedCopies(screenPng(1170, 2532));
  const view = require('../src/services/shots-view');
  const artifact = {
    id: 'a'.repeat(32), storyId: 'claim', viewport: 'mobile', side: 'head', variant: 'context',
    media: 'png', contentType: 'image/png', width: 1170, height: 2532, density: 3,
    denseWidth: 1170, denseHeight: 2532,
    thumbWidth: copies.thumb.width, thumbHeight: copies.thumb.height,
    screenWidth: 1170, screenHeight: 2532,
    placeholder: copies.placeholder,
  };
  const [clean] = view.cleanArtifacts([artifact], { slug: 'plant-pal', sessionId: 7, verified: true, dense: true });
  assert.deepEqual(clean.sizes.map((size) => size.size), ['thumb', 'screen']);
  assert.deepEqual(clean.sizes.map((size) => size.url), [
    `/api/apps/plant-pal/proposals/7/shots/${'a'.repeat(32)}?size=thumb`,
    `/api/apps/plant-pal/proposals/7/shots/${'a'.repeat(32)}?size=screen`,
  ]);
  assert.equal(clean.sizes[0].width, copies.thumb.width);
  assert.equal(clean.placeholder, copies.placeholder);
  // The still's own address is unchanged: zoom and the full view keep it.
  assert.equal(clean.url, `/api/apps/plant-pal/proposals/7/shots/${'a'.repeat(32)}?density=device`);
});

test('a still saved before the copies lists none, and a malformed preview is dropped', () => {
  const view = require('../src/services/shots-view');
  const artifact = (extra = {}) => ({
    id: 'b'.repeat(32), storyId: 'claim', viewport: 'mobile', side: 'base', variant: 'context',
    media: 'png', contentType: 'image/png', width: 1170, height: 2532, ...extra,
  });
  const [old] = view.cleanArtifacts([artifact()], { slug: 'demo', sessionId: 3, verified: true, dense: false });
  assert.deepEqual(old.sizes, []);
  assert.equal(old.placeholder, null);
  assert.equal(old.url, `/api/apps/demo/proposals/3/shots/${'b'.repeat(32)}`);
  // A preview that is not this proposal's own 20 px WebP is not sent on.
  for (const bad of ['https://example.com/x.png', 'data:image/png;base64,AAAA', `data:image/webp;base64,${'A'.repeat(1500)}`]) {
    const [clean] = view.cleanArtifacts([artifact({ thumbWidth: 277, thumbHeight: 600, placeholder: bad })],
      { slug: 'demo', sessionId: 3, verified: true, dense: false });
    assert.equal(clean.placeholder, null, bad.slice(0, 20));
    assert.deepEqual(clean.sizes, [{ size: 'thumb', url: `/api/apps/demo/proposals/3/shots/${'b'.repeat(32)}?size=thumb`, width: 277, height: 600 }]);
  }
});

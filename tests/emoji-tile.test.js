'use strict';

// An invite link's preview thumbnail is the project's icon (Evan, 20 Oct
// 2026). Most projects have an emoji icon and no image file, and chat apps
// draw only a raster picture, so services/emoji-tile.js draws the emoji on
// the project's colour as a PNG, from Noto Emoji's 512px picture of it.
// These pin the drawing, the cache and the route that serves it, with the
// fetch faked: nothing here goes to the network.
//
// Run with: node --test tests/emoji-tile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const tile = require('../src/services/emoji-tile');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** A fake fetch answering one solid square PNG, counting its calls. */
function fakeFetch({ ok = true, rgba = [255, 0, 0, 255], size = 8 } = {}) {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i += 1) png.data.set(rgba, i * 4);
  const bytes = PNG.sync.write(png);
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return { ok, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  return { fn, calls };
}

const pixel = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test('an emoji is named by its code points, as Noto names its pictures', () => {
  assert.equal(tile.codepointsOf('📊'), '1f4ca');
  assert.equal(tile.codepointsOf('🗳️'), '1f5f3', 'without the variation selector');
  assert.equal(tile.codepointsOf('🇨🇭'), '1f1e8_1f1ed');
  assert.equal(tile.codepointsOf('👩‍💻'), '1f469_200d_1f4bb');
  assert.equal(tile.codepointsOf(' '), '');
  assert.equal(tile.codepointsOf(null), '');
  assert.equal(tile.SOURCE('1f4ca'), 'https://fonts.gstatic.com/s/e/notoemoji/latest/1f4ca/512.png');
});

test('a colour is #rgb or #rrggbb, nothing else', () => {
  assert.deepEqual(tile.parseColor('#7c3aed'), [0x7c, 0x3a, 0xed]);
  assert.deepEqual(tile.parseColor('#FFF'), [255, 255, 255]);
  for (const bad of ['red', '#12345', 'rgb(1,2,3)', '', null, '#7c3aed; x']) assert.equal(tile.parseColor(bad), null, String(bad));
});

test('the tile: the emoji in the middle, on the project\'s colour or the cream ground', async () => {
  tile.clearCache();
  const red = fakeFetch();
  const bytes = await tile.tilePng({ emoji: '📊', fetchImpl: red.fn });
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, tile.SIZE);
  assert.equal(png.height, tile.SIZE);
  assert.deepEqual(pixel(png, tile.SIZE / 2, tile.SIZE / 2), [255, 0, 0, 255], 'the emoji');
  assert.deepEqual(pixel(png, 2, 2), [0xf4, 0xf2, 0xe4, 255], 'the shell\'s cream with no colour');
  assert.deepEqual(red.calls, ['https://fonts.gstatic.com/s/e/notoemoji/latest/1f4ca/512.png']);
  const violet = PNG.sync.read(await tile.tilePng({ emoji: '📊', color: '#7c3aed', fetchImpl: red.fn }));
  assert.deepEqual(pixel(violet, 2, 2), [0x7c, 0x3a, 0xed, 255]);
  // A see-through emoji leaves the ground showing through.
  tile.clearCache();
  const clear = PNG.sync.read(await tile.tilePng({ emoji: '📊', fetchImpl: fakeFetch({ rgba: [0, 0, 0, 0] }).fn }));
  assert.deepEqual(pixel(clear, tile.SIZE / 2, tile.SIZE / 2), [0xf4, 0xf2, 0xe4, 255]);
});

test('a picture is fetched once per emoji, and a missing one is not asked for again for a while', async () => {
  tile.clearCache();
  const red = fakeFetch();
  await tile.tilePng({ emoji: '🎲', fetchImpl: red.fn });
  await tile.tilePng({ emoji: '🎲', fetchImpl: red.fn });
  assert.equal(red.calls.length, 1, 'kept');
  const missing = fakeFetch({ ok: false });
  assert.equal(await tile.tilePng({ emoji: '🧩', fetchImpl: missing.fn, now: 0 }), null);
  assert.equal(await tile.tilePng({ emoji: '🧩', fetchImpl: missing.fn, now: 60 * 1000 }), null);
  assert.equal(missing.calls.length, 1, 'remembered as missing');
  await tile.tilePng({ emoji: '🧩', fetchImpl: missing.fn, now: 11 * 60 * 1000 });
  assert.equal(missing.calls.length, 2, 'asked again after ten minutes');
  // A fetch that throws is a missing picture too, and so is no emoji.
  assert.equal(await tile.tilePng({ emoji: '🪁', fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await tile.tilePng({ emoji: '', fetchImpl: red.fn }), null);
  tile.clearCache();
});

test('the route: an image icon is its own file, an emoji its tile, a missing picture Homeroom\'s icon', () => {
  const route = read('src/routes/community-invites.js');
  assert.match(route, /router\.get\('\/api\/public\/invites\/:token\/icon\.png', invitePreviewLimiter,/);
  assert.match(route, /if \(icon\.imageId\) return res\.redirect\(302, `\/app-icons\/\$\{encodeURIComponent\(icon\.imageId\)\}`\);/);
  assert.match(route, /const png = await emojiTile\.tilePng\(\{ emoji: icon\.emoji, color: icon\.color \}\);\s+if \(!png\) return res\.redirect\(302, '\/apple-touch-icon\.png'\);/);
  assert.match(route, /'Content-Type': 'image\/png',/);
  // Only a live link has an icon to show (services/community-invites.js).
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /async function previewIcon\(pool, token\) \{\s+const invite = await loadInvite\(pool, token\);\s+if \(deadReason\(invite\)\) return null;/);
  assert.match(svc, /a\.icon_emoji, a\.icon_image_id, a\.icon_color,/);
  // Anonymous, as the rest of an invite's preview is.
  assert.match(read('src/middleware/auth.js'), /'\/api\/public\/',/);
});

'use strict';

// An invite link's preview thumbnail is the project's icon (Evan, 20 Oct
// 2026). Most projects have an emoji icon and no image file, and chat apps
// draw only a raster picture, so services/emoji-tile.js draws the emoji on
// the project's colour as a PNG, from the Noto Emoji pictures committed in
// src/assets/noto-emoji/. These pin the drawing, that every ready-made
// idea's emoji has its picture, and the route that serves it.
//
// Run with: node --test tests/emoji-tile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');

const tile = require('../src/services/emoji-tile');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A directory holding one solid square picture for `emoji`. */
function glyphDir(emoji, rgba = [255, 0, 0, 255], size = 8) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emoji-tile-'));
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i += 1) png.data.set(rgba, i * 4);
  fs.writeFileSync(path.join(dir, `${tile.codepointsOf(emoji)}.png`), PNG.sync.write(png));
  return dir;
}

const pixel = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

test('an emoji is named by its code points, as its picture\'s file is', () => {
  assert.equal(tile.codepointsOf('📊'), '1f4ca');
  assert.equal(tile.codepointsOf('🗳️'), '1f5f3', 'without the variation selector');
  assert.equal(tile.codepointsOf('🇨🇭'), '1f1e8_1f1ed');
  assert.equal(tile.codepointsOf('👩‍💻'), '1f469_200d_1f4bb');
  assert.equal(tile.codepointsOf(' '), '');
  assert.equal(tile.codepointsOf(null), '');
});

test('a colour is #rgb or #rrggbb, nothing else', () => {
  assert.deepEqual(tile.parseColor('#7c3aed'), [0x7c, 0x3a, 0xed]);
  assert.deepEqual(tile.parseColor('#FFF'), [255, 255, 255]);
  for (const bad of ['red', '#12345', 'rgb(1,2,3)', '', null, '#7c3aed; x']) assert.equal(tile.parseColor(bad), null, String(bad));
});

test('the tile: the emoji in the middle, on the project\'s colour or the cream ground', () => {
  tile.clearCache();
  const dir = glyphDir('📊');
  const png = PNG.sync.read(tile.tilePng({ emoji: '📊', dir }));
  assert.equal(png.width, tile.SIZE);
  assert.equal(png.height, tile.SIZE);
  assert.deepEqual(pixel(png, tile.SIZE / 2, tile.SIZE / 2), [255, 0, 0, 255], 'the emoji');
  assert.deepEqual(pixel(png, 2, 2), [0xf4, 0xf2, 0xe4, 255], 'the shell\'s cream with no colour');
  const violet = PNG.sync.read(tile.tilePng({ emoji: '📊', color: '#7c3aed', dir }));
  assert.deepEqual(pixel(violet, 2, 2), [0x7c, 0x3a, 0xed, 255]);
  // A see-through picture leaves the ground showing through.
  tile.clearCache();
  const clear = PNG.sync.read(tile.tilePng({ emoji: '📊', dir: glyphDir('📊', [0, 0, 0, 0]) }));
  assert.deepEqual(pixel(clear, tile.SIZE / 2, tile.SIZE / 2), [0xf4, 0xf2, 0xe4, 255]);
  // No picture, or no emoji: nothing, and the route falls back.
  assert.equal(tile.tilePng({ emoji: '🪁', dir }), null);
  assert.equal(tile.tilePng({ emoji: '', dir }), null);
  assert.equal(tile.tilePng({ emoji: '../x', dir }), null, 'a name outside the code points reads no file');
  tile.clearCache();
});

test('the pictures are on disk, one for every emoji a ready-made idea gives its project', () => {
  const src = read('src/services/emoji-tile.js');
  assert.doesNotMatch(src, /fetch\(|https?:\/\//, 'read from disk: nothing is fetched from another site');
  const wanted = new Set([
    ...[...read('src/services/app-templates.js').matchAll(/\bicon: '([^']+)'/g)].map((m) => m[1]),
    ...[...read('frontend/src/features/first-session/examples.ts').matchAll(/\bemoji: '([^']+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(wanted.size >= 15, `found the ideas' emoji (${wanted.size})`);
  for (const emoji of wanted) {
    assert.ok(tile.hasGlyph(emoji), `${emoji} (${tile.codepointsOf(emoji)}.png) has its picture in src/assets/noto-emoji/`);
  }
  // Each is the glyph size, and the real tile is drawn from it.
  for (const file of fs.readdirSync(tile.GLYPH_DIR).filter((f) => f.endsWith('.png'))) {
    const png = PNG.sync.read(fs.readFileSync(path.join(tile.GLYPH_DIR, file)));
    assert.deepEqual([png.width, png.height], [tile.GLYPH, tile.GLYPH], file);
  }
  tile.clearCache();
  assert.equal(PNG.sync.read(tile.tilePng({ emoji: '📊' })).width, tile.SIZE);
  // Where they come from, and under which licence.
  const readme = read('src/assets/noto-emoji/README.md');
  assert.match(readme, /Noto Emoji/);
  assert.match(readme, /Apache License 2\.0/);
});

test('the route: an image icon is its own file, an emoji its tile, none Homeroom\'s icon', () => {
  const route = read('src/routes/community-invites.js');
  assert.match(route, /router\.get\('\/api\/public\/invites\/:token\/icon\.png', invitePreviewLimiter,/);
  assert.match(route, /if \(icon\.imageId\) return res\.redirect\(302, `\/app-icons\/\$\{encodeURIComponent\(icon\.imageId\)\}`\);/);
  assert.match(route, /const png = emojiTile\.tilePng\(\{ emoji: icon\.emoji, color: icon\.color \}\);\s+if \(!png\) return res\.redirect\(302, '\/apple-touch-icon\.png'\);/);
  assert.match(route, /'Content-Type': 'image\/png',/);
  // Only a live link has an icon to show (services/community-invites.js).
  const svc = read('src/services/community-invites.js');
  assert.match(svc, /async function previewIcon\(pool, token\) \{\s+const invite = await loadInvite\(pool, token\);\s+if \(deadReason\(invite\)\) return null;/);
  assert.match(svc, /a\.icon_emoji, a\.icon_image_id, a\.icon_color,/);
  // Anonymous, as the rest of an invite's preview is.
  assert.match(read('src/middleware/auth.js'), /'\/api\/public\/',/);
});

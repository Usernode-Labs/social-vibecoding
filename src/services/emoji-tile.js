'use strict';
// A project's emoji icon as a PNG, for the places that take only a raster
// picture: an invite link's preview (og:image), which WhatsApp, iMessage and
// Slack draw as the card's thumbnail (routes/community-invites.js). Most
// projects have an emoji icon and no image file, and a chat app will not
// draw an SVG or a font, so the preview used to fall back to the site's own
// home-screen icon: Homeroom's mark on every project's card.
//
// The tile is the project's colour (dapp.json's `icon.color`), else the
// shell's cream ground, square to the edges (each chat app rounds or crops
// the thumbnail its own way), with the emoji in the middle. The emoji's
// picture comes from src/assets/noto-emoji/ (Noto Emoji, committed; its
// README says where from), read from disk: nothing is fetched from another
// site. It holds every emoji a ready-made idea gives its project
// (tests/emoji-tile.test.js keeps it so). An emoji without one answers null,
// and the caller falls back to Homeroom's icon, as the card showed before.
//
//   codepointsOf(emoji)   '📊' → '1f4ca', the picture's file name (lower-
//                         case hex joined by '_', without U+FE0F).
//   parseColor(value)     '#rgb' / '#rrggbb' → [r, g, b], else null.
//   hasGlyph(emoji)       whether there is a picture for it.
//   tilePng({ emoji, color })  the PNG bytes, or null.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SIZE = 480;
// The emoji's share of the tile: as large as the shell's icon tiles draw
// theirs, with room around it for a round crop. The committed pictures are
// this size.
const GLYPH = Math.round(SIZE * 0.6);
const GROUND = [0xf4, 0xf2, 0xe4];
const GLYPH_DIR = path.join(__dirname, '..', 'assets', 'noto-emoji');
const CACHE_MAX = 200;

// Composed tiles by emoji and colour; the oldest goes first past CACHE_MAX.
const tiles = new Map();
// Decoded pictures by code points, null for none.
const glyphs = new Map();

function codepointsOf(emoji) {
  const points = [];
  for (const ch of String(emoji || '').trim()) {
    const cp = ch.codePointAt(0);
    if (cp !== 0xfe0f) points.push(cp.toString(16));
  }
  return points.join('_');
}

function parseColor(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function glyphFor(code, dir) {
  const key = `${dir}|${code}`;
  if (glyphs.has(key)) return glyphs.get(key);
  let png = null;
  // Code points are hex and '_' only, so the name stays inside `dir`.
  if (/^[0-9a-f_]+$/.test(code)) {
    try {
      png = PNG.sync.read(fs.readFileSync(path.join(dir, `${code}.png`)));
    } catch {
      png = null;
    }
  }
  glyphs.set(key, png);
  return png;
}

function hasGlyph(emoji, dir = GLYPH_DIR) {
  const code = codepointsOf(emoji);
  return !!code && !!glyphFor(code, dir);
}

// The picture laid on the ground, centred, at its own size when it is the
// glyph size (the committed ones are), else scaled to it by sampling.
function compose(src, ground) {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    png.data[i * 4] = ground[0];
    png.data[i * 4 + 1] = ground[1];
    png.data[i * 4 + 2] = ground[2];
    png.data[i * 4 + 3] = 255;
  }
  const offset = Math.round((SIZE - GLYPH) / 2);
  for (let y = 0; y < GLYPH; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / GLYPH));
    for (let x = 0; x < GLYPH; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / GLYPH));
      const s = (sy * src.width + sx) * 4;
      const a = src.data[s + 3] / 255;
      if (a <= 0) continue;
      const o = ((y + offset) * SIZE + (x + offset)) * 4;
      for (let c = 0; c < 3; c += 1) {
        png.data[o + c] = Math.round(src.data[s + c] * a + png.data[o + c] * (1 - a));
      }
    }
  }
  return PNG.sync.write(png);
}

function tilePng({ emoji, color = null, dir = GLYPH_DIR } = {}) {
  const code = codepointsOf(emoji);
  if (!code) return null;
  const ground = parseColor(color) || GROUND;
  const key = `${dir}|${code}|${ground.join(',')}`;
  if (tiles.has(key)) return tiles.get(key);
  const src = glyphFor(code, dir);
  if (!src) return null;
  const bytes = compose(src, ground);
  tiles.set(key, bytes);
  if (tiles.size > CACHE_MAX) tiles.delete(tiles.keys().next().value);
  return bytes;
}

function clearCache() {
  tiles.clear();
  glyphs.clear();
}

module.exports = { codepointsOf, parseColor, hasGlyph, tilePng, clearCache, SIZE, GLYPH, GLYPH_DIR };

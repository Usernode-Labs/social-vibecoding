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
// picture is Google's Noto Emoji at 512px, fetched by its code points from
// fonts.gstatic.com once per emoji and kept in memory, then scaled down and
// laid on the tile with pngjs. A fetch that fails is remembered for a while
// and answered with null, and the caller falls back to Homeroom's icon.
//
//   codepointsOf(emoji)   'f09f939a…' → '1f4ca', the Noto file name (lower-
//                         case hex joined by '_', without U+FE0F).
//   parseColor(value)     '#rgb' / '#rrggbb' → [r, g, b], else null.
//   tilePng({ emoji, color, fetchImpl })  the PNG bytes, or null.
const { PNG } = require('pngjs');

const SIZE = 480;
// The emoji's share of the tile: as large as the shell's icon tiles draw
// theirs, with room around it for a round crop.
const GLYPH = Math.round(SIZE * 0.6);
const GROUND = [0xf4, 0xf2, 0xe4];
const SOURCE = (code) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${code}/512.png`;
const FETCH_TIMEOUT_MS = 4000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const CACHE_MAX = 200;
const MISS_TTL_MS = 10 * 60 * 1000;

// Composed tiles by emoji and colour; the oldest goes first past CACHE_MAX.
const tiles = new Map();
// Emoji whose picture could not be fetched, and when, so a missing one is
// not asked for on every unfurl.
const misses = new Map();

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

async function fetchSource(code, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(SOURCE(code), { signal: controller.signal });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) return null;
    return PNG.sync.read(bytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The source scaled to `size` square by averaging the pixels each target
// pixel covers, in premultiplied alpha so the edges do not darken.
function scaled(src, size) {
  const out = new Float64Array(size * size * 4);
  const sx = src.width / size;
  const sy = src.height / size;
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy += 1) {
        for (let xx = x0; xx < x1 && xx < src.width; xx += 1) {
          const i = (yy * src.width + xx) * 4;
          const al = src.data[i + 3] / 255;
          r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al; a += al;
          n += 1;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

function compose(src, ground) {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    png.data[i * 4] = ground[0];
    png.data[i * 4 + 1] = ground[1];
    png.data[i * 4 + 2] = ground[2];
    png.data[i * 4 + 3] = 255;
  }
  const glyph = scaled(src, GLYPH);
  const offset = Math.round((SIZE - GLYPH) / 2);
  for (let y = 0; y < GLYPH; y += 1) {
    for (let x = 0; x < GLYPH; x += 1) {
      const g = (y * GLYPH + x) * 4;
      const a = glyph[g + 3];
      if (a <= 0) continue;
      const o = ((y + offset) * SIZE + (x + offset)) * 4;
      for (let c = 0; c < 3; c += 1) {
        png.data[o + c] = Math.round(glyph[g + c] + png.data[o + c] * (1 - a));
      }
    }
  }
  return PNG.sync.write(png);
}

async function tilePng({ emoji, color = null, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const code = codepointsOf(emoji);
  if (!code || typeof fetchImpl !== 'function') return null;
  const ground = parseColor(color) || GROUND;
  const key = `${code}|${ground.join(',')}`;
  if (tiles.has(key)) return tiles.get(key);
  const missedAt = misses.get(code);
  if (missedAt != null && now - missedAt < MISS_TTL_MS) return null;
  const src = await fetchSource(code, fetchImpl);
  if (!src) {
    misses.set(code, now);
    return null;
  }
  misses.delete(code);
  const bytes = compose(src, ground);
  tiles.set(key, bytes);
  if (tiles.size > CACHE_MAX) tiles.delete(tiles.keys().next().value);
  return bytes;
}

function clearCache() {
  tiles.clear();
  misses.clear();
}

module.exports = { codepointsOf, parseColor, tilePng, clearCache, SIZE, SOURCE };

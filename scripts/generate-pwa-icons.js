#!/usr/bin/env node
// Generates the platform's PWA icons (public/icons/*.png) — a white "U"
// lettermark on WeOS brand blue (#3090E1, pinned at `violet-500` in
// tailwind.config.js). Brand blue is a FILL colour, which is exactly the job
// here; the accent ink sibling #086bb3 is for type and strokes, not for a
// homescreen tile.
// The repo has no logo artwork, so the icons are generated rather than
// designed. THE PNGS ARE COMMITTED AND NO BUILD REGENERATES THEM, so a change
// to the colour below only reaches a homescreen after you re-run this script
// and commit the output.
//
//   node scripts/generate-pwa-icons.js
//
// Zero dependencies: writes PNGs by hand (zlib IDAT + manual chunks).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BRAND = [0x30, 0x90, 0xe1];
const WHITE = [255, 255, 255];

// CRC32 (PNG variant).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed-distance-ish coverage test for one point (x, y) in icon space
// [0, 1): inside the "U" glyph? The U is two vertical bars joined by a
// bottom half-annulus.
function inU(x, y) {
  const cx = 0.5;
  const cy = 0.54;        // arc center — glyph sits slightly low-centered
  const outerR = 0.26;    // outer half-width of the U
  const stroke = 0.115;   // bar/arc thickness
  const top = 0.26;       // top of the bars
  const innerR = outerR - stroke;

  if (y < top) return false;
  if (y <= cy) {
    // Bars: |x - cx| within [innerR, outerR].
    const dx = Math.abs(x - cx);
    return dx >= innerR && dx <= outerR;
  }
  // Bottom arc: ring segment below the center line.
  const d = Math.hypot(x - cx, y - cy);
  return d >= innerR && d <= outerR;
}

// Rounded-square background coverage (radius as a fraction of size).
function inRoundedSquare(x, y, radiusFrac) {
  const r = radiusFrac;
  const nx = Math.min(x, 1 - x);
  const ny = Math.min(y, 1 - y);
  if (nx >= r || ny >= r) return true;
  return Math.hypot(r - nx, r - ny) <= r;
}

// 4x supersampled render. `maskable` fills the full square (the OS applies
// its own mask; glyph shrinks into the 80% safe zone), non-maskable gets
// a soft rounded-rect with transparent corners.
function renderIcon(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  const glyphScale = maskable ? 0.78 : 1.0; // keep the U inside the safe zone
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const inBg = maskable ? true : inRoundedSquare(x, y, 0.18);
          if (!inBg) continue;
          bg++;
          // Scale glyph coordinates around the center.
          const gx = 0.5 + (x - 0.5) / glyphScale;
          const gy = 0.5 + (y - 0.5) / glyphScale;
          if (inU(gx, gy)) fg++;
        }
      }
      const n = SS * SS;
      const alpha = Math.round((bg / n) * 255);
      const fgFrac = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(BRAND[0] + (WHITE[0] - BRAND[0]) * fgFrac);
      rgba[i + 1] = Math.round(BRAND[1] + (WHITE[1] - BRAND[1]) * fgFrac);
      rgba[i + 2] = Math.round(BRAND[2] + (WHITE[2] - BRAND[2]) * fgFrac);
      rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, rgba);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), renderIcon(192, { maskable: false }));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), renderIcon(512, { maskable: false }));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), renderIcon(512, { maskable: true }));
console.log('Wrote public/icons/icon-192.png, icon-512.png, icon-maskable-512.png');

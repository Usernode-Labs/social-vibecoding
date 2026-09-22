#!/usr/bin/env node
// Generates the platform's PWA icons (public/icons/*.png) — a cream
// script "H" lettermark with a small sparkle accent, on the shell's dark
// ground (#0b0d1b, the same TONE_GROUND.dark the app frame uses; the
// lettermark is #f4f2e4, TONE_GROUND.light — see
// frontend/src/features/app-frame/app-tone.js). The repo has no logo
// artwork, so the icons are generated rather than designed; re-run this
// script to regenerate after tweaking.
//
//   node scripts/generate-pwa-icons.js
//
// Zero dependencies: writes PNGs by hand (zlib IDAT + manual chunks).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GROUND_DARK = [0x0b, 0x0d, 0x1b];
const CREAM = [0xf4, 0xf2, 0xe4];

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

// Rounded-square background coverage (radius as a fraction of size).
function inRoundedSquare(x, y, radiusFrac) {
  const r = radiusFrac;
  const nx = Math.min(x, 1 - x);
  const ny = Math.min(y, 1 - y);
  if (nx >= r || ny >= r) return true;
  return Math.hypot(r - nx, r - ny) <= r;
}

// Distance from point (px, py) to the segment (x1,y1)-(x2,y2).
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function quadBezier(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

// Coverage test for a tapered quadratic-bezier stroke: true if (x, y) falls
// within `radius` of the curve, where radius eases from r0 (t=0) to r1
// (t=1) — used for the crossbar's swoop and the letterform's flourishes.
function inBezierStroke(x, y, p0, p1, p2, r0, r1, segments = 14) {
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a = quadBezier(p0, p1, p2, t0);
    const b = quadBezier(p0, p1, p2, t1);
    const r = r0 + (r1 - r0) * ((t0 + t1) / 2);
    if (segDist(x, y, a.x, a.y, b.x, b.y) <= r) return true;
  }
  return false;
}

function inCapsule(x, y, x1, y1, x2, y2, radius) {
  return segDist(x, y, x1, y1, x2, y2) <= radius;
}

// The script "H": two slanted uprights (a subtle italic shear, like a
// handwritten capital) joined by a crossbar that swoops upward, with a
// tapered entry flick off the right upright and a tapered exit tail off
// the left one — the two flourishes that read as "script" rather than a
// mechanical block letter.
function inH(x, y) {
  const SLANT = 0.16;
  // Shear so the top leans right relative to the bottom (italic lean).
  const ux = x - SLANT * (0.5 - y);
  const uy = y;

  const leftX = 0.35;
  const rightX = 0.67;
  const strokeR = 0.072;

  if (inCapsule(ux, uy, leftX, 0.26, leftX, 0.74, strokeR)) return true;
  if (inCapsule(ux, uy, rightX, 0.20, rightX, 0.78, strokeR)) return true;

  // Crossbar: a shallow upward swoop from the left upright to the right.
  if (inBezierStroke(
    ux, uy,
    { x: leftX + 0.01, y: 0.53 },
    { x: 0.51, y: 0.42 },
    { x: rightX - 0.01, y: 0.47 },
    0.056, 0.05,
  )) return true;

  // Exit tail off the bottom of the left upright, tapering to a point.
  if (inBezierStroke(
    ux, uy,
    { x: leftX, y: 0.735 },
    { x: 0.28, y: 0.88 },
    { x: 0.40, y: 0.93 },
    0.058, 0.006,
  )) return true;

  // Entry flick off the top of the right upright, tapering to a point.
  if (inBezierStroke(
    ux, uy,
    { x: rightX, y: 0.205 },
    { x: 0.735, y: 0.135 },
    { x: 0.615, y: 0.105 },
    0.05, 0.006,
  )) return true;

  return false;
}

// A 4-pointed sparkle: radius-per-angle traces a pinched star (tips at
// N/E/S/W, pinched at the diagonals). `rOut`/`rIn` and the exponent are in
// icon-space units around center (cx, cy).
function inSparkle(x, y, cx, cy, rOut, rIn, exponent) {
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  if (r > rOut) return false;
  const theta = Math.atan2(dy, dx);
  const edge = rIn + (rOut - rIn) * Math.pow(Math.abs(Math.cos(2 * theta)), exponent);
  return r <= edge;
}

function inGlyph(x, y) {
  if (inH(x, y)) return true;
  if (inSparkle(x, y, 0.815, 0.225, 0.095, 0.018, 1.5)) return true;
  if (inSparkle(x, y, 0.885, 0.345, 0.032, 0.006, 1.5)) return true;
  return false;
}

// 4x supersampled render. `maskable` fills the full square (the OS applies
// its own mask; glyph shrinks into the 80% safe zone), non-maskable gets a
// soft rounded-rect with transparent corners.
function renderIcon(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  const glyphScale = maskable ? 0.78 : 1.0; // keep the mark inside the safe zone
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
          if (inGlyph(gx, gy)) fg++;
        }
      }
      const n = SS * SS;
      const alpha = Math.round((bg / n) * 255);
      const fgFrac = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(GROUND_DARK[0] + (CREAM[0] - GROUND_DARK[0]) * fgFrac);
      rgba[i + 1] = Math.round(GROUND_DARK[1] + (CREAM[1] - GROUND_DARK[1]) * fgFrac);
      rgba[i + 2] = Math.round(GROUND_DARK[2] + (CREAM[2] - GROUND_DARK[2]) * fgFrac);
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

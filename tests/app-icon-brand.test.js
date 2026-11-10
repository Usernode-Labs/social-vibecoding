'use strict';
// Class Jump's app icon follows the Homeroom brand tile: a cream figure on a
// near-black rounded square. The platform sniffs magic bytes (PNG only, never
// SVG) and refuses anything over 256 KB, so the committed file is checked here
// the way src/services/app-manifest.js will read it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ICON = path.join(ROOT, 'public/icon.png');
const MAX_ICON_IMAGE_BYTES = 256 * 1024;

function readPng(file) {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${path.basename(file)} is a PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixel = (x, y) => {
    // Our rasteriser writes filter type 0 (None) on every row.
    const row = y * (width * 4 + 1);
    assert.equal(raw[row], 0, 'unfiltered scanline');
    const i = row + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  return { bytes: buf.length, width, height, pixel };
}

test('the app icon is a square 1024px PNG under the platform cap, and dapp.json points at it', () => {
  const dapp = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  assert.equal(dapp.icon.image, 'public/icon.png', 'the manifest names the committed icon');
  assert.equal(dapp.icon.color, '#37477b', 'the brand navy stays the project colour');
  assert.ok(fs.existsSync(ICON), 'the path in dapp.json exists, letter case included');

  const png = readPng(ICON);
  assert.equal(png.width, 1024);
  assert.equal(png.height, 1024);
  assert.ok(png.bytes <= MAX_ICON_IMAGE_BYTES, `icon is ${png.bytes} bytes, under ${MAX_ICON_IMAGE_BYTES}`);
});

test('the icon is drawn: cream figure on a near-black tile with transparent corners', () => {
  const png = readPng(ICON);
  const [, , , cornerAlpha] = png.pixel(0, 0);
  assert.equal(cornerAlpha, 0, 'outside the rounded corners is transparent');
  const bg = png.pixel(40, 512);
  assert.deepEqual(bg.slice(0, 3), [0x0b, 0x0b, 0x0b], 'the tile is near-black');
  assert.equal(bg[3], 255);
  const bar = png.pixel(512, 859);
  assert.deepEqual(bar.slice(0, 3), [0xff, 0xfe, 0xea], 'the bar under the figure is brand cream');
});

test('the featured picture comes in a light and a dark version, square and wordless', () => {
  const versions = [
    ['light', [0xf6, 0xf1, 0xdc], [0x14, 0x14, 0x14]],
    ['dark', [0x0b, 0x0b, 0x0b], [0xff, 0xfe, 0xea]],
  ];
  for (const [name, ground, ink] of versions) {
    const file = path.join(ROOT, 'assets/featured', `${name}.png`);
    assert.ok(fs.existsSync(file), `${name} featured picture is committed`);
    const png = readPng(file);
    assert.equal(png.width, 1024);
    assert.equal(png.height, 1024);
    assert.ok(png.bytes <= 1024 * 1024, `featured ${name} is under 1 MB`);
    assert.deepEqual(png.pixel(20, 20).slice(0, 3), ground, `the ${name} version's ground`);
    assert.deepEqual(png.pixel(512, 782).slice(0, 3), ink, `the ${name} version draws its subject`);
  }
});

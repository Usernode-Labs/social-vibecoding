#!/usr/bin/env node
'use strict';

// The sample files the shots agent may upload where a page asks for one
// (the shots bridge's upload_file). A change to a photo upload could not be
// shot before: the browser's own file tool stays blocked, because it would
// hand the page any file in the worker, the browsers' signed-in storage state
// among them (pixora PR 3, 2026-10-10: "no file-upload tool").
//
// So the only files that can ever reach a page are these: drawn here from
// fixed numbers, holding nothing about anyone, and the same bytes on every
// run and on both sides of a pair. The worker image writes them once
// (`node shots-samples.js <dir>`, read-only); the browser observer resolves a
// sample's name to its file in that directory and refuses every other name.
// The platform reads the names from here too, for the brief and for what a
// change's shots say was uploaded.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Where the worker image keeps them (worker/Dockerfile).
const SAMPLES_DIR = '/usr/local/share/usernode/shots-samples';
// At most this many in one upload: enough for a gallery's "choose several".
const MAX_FILES = 3;

// ── PNG ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// An 8-bit RGB PNG of `width` × `height`, coloured by `colourAt(x, y)`. Each
// row is filtered against the one above it, so a picture of broad shapes
// stays a few kilobytes.
function png(width, height, colourAt) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colourAt(x, y);
      row[x * 3] = r; row[x * 3 + 1] = g; row[x * 3 + 2] = b;
    }
    const offset = y * (stride + 1);
    raw[offset] = 2; // the "Up" filter
    for (let i = 0; i < stride; i += 1) raw[offset + 1 + i] = (row[i] - previous[i]) & 0xff;
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((value, i) => Math.round(value + (b[i] - value) * t));

// Hills under a sky with a sun, as a landscape photo would be framed.
function landscape() {
  const width = 960;
  const height = 640;
  const farHill = (x) => height * 0.56 + 34 * Math.sin(x / 120) + 16 * Math.sin(x / 47 + 1);
  const nearHill = (x) => height * 0.72 + 42 * Math.sin(x / 170 + 2) + 14 * Math.sin(x / 63);
  return png(width, height, (x, y) => {
    if (y >= nearHill(x)) return mix([96, 156, 92], [62, 118, 66], (y - height * 0.6) / (height * 0.4));
    if (y >= farHill(x)) return [134, 178, 132];
    if ((x - width * 0.76) ** 2 + (y - height * 0.22) ** 2 <= 52 ** 2) return [255, 214, 120];
    return mix([110, 164, 226], [204, 226, 244], y / (height * 0.6));
  });
}

// A head and shoulders on a plain ground, as a profile photo is framed.
function portrait() {
  const size = 512;
  return png(size, size, (x, y) => {
    if ((x - 256) ** 2 + (y - 206) ** 2 <= 92 ** 2) return [236, 196, 160];
    if (((x - 256) / 176) ** 2 + ((y - 512) / 190) ** 2 <= 1) return [84, 112, 196];
    return [228, 222, 246];
  });
}

// ── CSV ──────────────────────────────────────────────────────────────────

function table() {
  return Buffer.from([
    'date,item,category,amount',
    '2026-09-01,Coffee beans,Groceries,12.50',
    '2026-09-03,Bus pass,Travel,45.00',
    '2026-09-05,Notebook,Office,6.20',
    '2026-09-08,Vegetables,Groceries,18.75',
    '2026-09-12,Bike repair,Travel,24.00',
    '2026-09-15,Phone case,Shopping,15.99',
    '2026-09-20,Train ticket,Travel,32.40',
    '2026-09-28,Houseplant,Home,9.80',
    '',
  ].join('\n'), 'utf8');
}

// ── PDF ──────────────────────────────────────────────────────────────────

// One A4 page of text in the two fonts every PDF reader has, with the cross
// reference table worked out from the bytes, as a reader expects.
function document() {
  const escape = (text) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  const lines = [
    ['F1', 22, 'Sample document'],
    ['F2', 12, 'This is one of Homeroom\'s sample files for before and after shots.'],
    ['F2', 12, 'It was made up for testing and holds nothing about anyone.'],
    ['F2', 12, 'Item one: a short paragraph of plain text.'],
    ['F2', 12, 'Item two: another line, so the page has more than a heading.'],
  ];
  let y = 760;
  const content = lines.map(([font, size, text], index) => {
    const line = `BT /${font} ${size} Tf 72 ${y} Td (${escape(text)}) Tj ET`;
    y -= index === 0 ? 40 : 22;
    return line;
  }).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ── The set ──────────────────────────────────────────────────────────────

// What the shots agent is told about each (the brief, the upload tool).
const SAMPLE_FILES = Object.freeze([
  Object.freeze({ name: 'landscape.png', type: 'image/png', about: 'A 960 × 640 picture of green hills under a blue sky with a sun, like a landscape photo.' }),
  Object.freeze({ name: 'portrait.png', type: 'image/png', about: 'A 512 × 512 picture of a head and shoulders on a plain ground, like a profile photo.' }),
  Object.freeze({ name: 'table.csv', type: 'text/csv', about: 'A table of eight made-up purchases: date, item, category, amount.' }),
  Object.freeze({ name: 'document.pdf', type: 'application/pdf', about: 'A one-page document with a heading and four lines of text.' }),
]);
const SAMPLE_NAMES = Object.freeze(SAMPLE_FILES.map((file) => file.name));
const MAKERS = Object.freeze({
  'landscape.png': landscape,
  'portrait.png': portrait,
  'table.csv': table,
  'document.pdf': document,
});

function sampleBytes(name) {
  const make = Object.hasOwn(MAKERS, name) ? MAKERS[name] : null;
  if (!make) throw new Error(`${name} is not a sample file.`);
  return make();
}

// Writes the set into `dir`, each file read-only.
function writeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const name of SAMPLE_NAMES) {
    const file = path.join(dir, name);
    try { fs.chmodSync(file, 0o644); } catch { /* not written yet */ }
    fs.writeFileSync(file, sampleBytes(name), { mode: 0o444 });
    fs.chmodSync(file, 0o444);
  }
}

function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The files `names` choose, in `dir`: each a sample's name, none twice, at
// most MAX_FILES, and each a plain file there (never a link). Anything else
// is refused, so nothing but a sample can be handed to a page.
function samplePaths(names, dir = SAMPLES_DIR) {
  if (!Array.isArray(names) || names.length > MAX_FILES) {
    throw refusal('invalid_sample_files', `Choose up to ${MAX_FILES} of the sample files: ${SAMPLE_NAMES.join(', ')}.`);
  }
  if (new Set(names).size !== names.length) {
    throw refusal('invalid_sample_files', 'Name each sample file once.');
  }
  return names.map((name) => {
    if (typeof name !== 'string' || !SAMPLE_NAMES.includes(name)) {
      throw refusal('unknown_sample_file', `${JSON.stringify(String(name)).slice(0, 80)} is not a sample file; use ${SAMPLE_NAMES.join(', ')}.`);
    }
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) throw refusal('sample_file_missing', `The sample file ${name} is not on this worker.`);
    return file;
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('Usage: shots-samples.js <directory>\n');
    process.exit(2);
  }
  writeSamples(dir);
}

module.exports = {
  SAMPLES_DIR,
  MAX_FILES,
  SAMPLE_FILES,
  SAMPLE_NAMES,
  sampleBytes,
  writeSamples,
  samplePaths,
};

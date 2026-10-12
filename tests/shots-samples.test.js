'use strict';

// The only files a shots page can be handed (worker/shots-samples.js): drawn
// from fixed numbers, the same bytes every time, and chosen by name only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const samples = require('../worker/shots-samples');

test('the set is two pictures, a table and a document, each described for the agent', () => {
  assert.deepEqual(samples.SAMPLE_NAMES, ['landscape.png', 'portrait.png', 'table.csv', 'document.pdf']);
  assert.deepEqual(samples.SAMPLE_FILES.map((file) => file.type), ['image/png', 'image/png', 'text/csv', 'application/pdf']);
  for (const file of samples.SAMPLE_FILES) {
    assert.ok(file.about.length > 20 && file.about.length < 200, file.name);
    assert.doesNotMatch(file.about, /[—]/, 'no em dashes in model copy');
  }
  assert.equal(samples.MAX_FILES, 3);
});

test('every sample is the same bytes every time, and a whole file of its kind', () => {
  for (const name of samples.SAMPLE_NAMES) {
    assert.ok(samples.sampleBytes(name).equals(samples.sampleBytes(name)), `${name} is deterministic`);
  }
  for (const [name, width, height] of [['landscape.png', 960, 640], ['portrait.png', 512, 512]]) {
    const image = samples.sampleBytes(name);
    assert.ok(image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), name);
    assert.equal(image.toString('latin1', 12, 16), 'IHDR');
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [width, height]);
    assert.equal(image.toString('latin1', image.length - 8, image.length - 4), 'IEND');
    // Its pixels inflate to exactly one filtered row per line.
    const idat = image.indexOf('IDAT');
    const length = image.readUInt32BE(idat - 4);
    const raw = zlib.inflateSync(image.subarray(idat + 4, idat + 4 + length));
    assert.equal(raw.length, (width * 3 + 1) * height);
    assert.ok(image.length < 64 * 1024, `${name} stays small`);
  }
  const csv = samples.sampleBytes('table.csv').toString('utf8').trim().split('\n');
  assert.equal(csv[0], 'date,item,category,amount');
  assert.equal(csv.length, 9);
  assert.ok(csv.slice(1).every((row) => /^2026-\d\d-\d\d,[A-Za-z ]+,[A-Za-z]+,\d+\.\d\d$/.test(row)));
  // The PDF's cross reference points at each of its objects, as a reader expects.
  const pdf = samples.sampleBytes('document.pdf').toString('latin1');
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /%%EOF\n$/);
  const start = Number(/startxref\n(\d+)\n/.exec(pdf)[1]);
  assert.equal(pdf.slice(start, start + 4), 'xref');
  const offsets = [...pdf.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(offsets.length, 6);
  offsets.forEach((offset, index) => assert.ok(pdf.startsWith(`${index + 1} 0 obj`, offset), `object ${index + 1}`));
  assert.match(pdf, /\(Sample document\) Tj/);
});

test('the set is written read-only, and only a sample by name is ever chosen', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-samples-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  samples.writeSamples(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...samples.SAMPLE_NAMES].sort());
  for (const name of samples.SAMPLE_NAMES) {
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o444, name);
    assert.ok(fs.readFileSync(path.join(dir, name)).equals(samples.sampleBytes(name)), name);
  }
  // Writing again (a rebuilt image layer) replaces them in place.
  samples.writeSamples(dir);

  assert.deepEqual(samples.samplePaths(['table.csv', 'landscape.png'], dir),
    [path.join(dir, 'table.csv'), path.join(dir, 'landscape.png')]);
  assert.deepEqual(samples.samplePaths([], dir), []);
  for (const [names, code] of [
    ['landscape.png', 'invalid_sample_files'],
    [['landscape.png', 'landscape.png'], 'invalid_sample_files'],
    [['landscape.png', 'portrait.png', 'table.csv', 'document.pdf'], 'invalid_sample_files'],
    [['../state/member.json'], 'unknown_sample_file'],
    [[path.join(dir, 'table.csv')], 'unknown_sample_file'],
    [['LANDSCAPE.PNG'], 'unknown_sample_file'],
    [[42], 'unknown_sample_file'],
  ]) {
    assert.throws(() => samples.samplePaths(names, dir), { code }, JSON.stringify(names));
  }
  // A sample that is missing, or a link where a sample should be, is refused.
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-samples-linked-'));
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  fs.symlinkSync(path.join(dir, 'landscape.png'), path.join(linked, 'landscape.png'));
  assert.throws(() => samples.samplePaths(['landscape.png'], linked), { code: 'sample_file_missing' });
  assert.throws(() => samples.samplePaths(['table.csv'], linked), { code: 'sample_file_missing' });
});

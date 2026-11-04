'use strict';

// #6256: the attachment rules both message boxes share
// (frontend/src/features/attachments/limits.ts). The blank thread with
// Homeroom bot grew the drop zone, the "+" and paste that a reply thread
// already had, and the cap and per-type ceiling moved here so the two boxes
// cannot drift: a second copy keeps the number the first was fixed away from.
//
// Run with: node --test tests/attachment-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

// The refusal line's own format is pinned by tests/composer-refusal-summary;
// what this suite checks is which reason and how many more it is handed.
const mod = () => loadTsx('frontend/src/features/attachments/limits.ts', {
  stubs: {
    './refusal-summary': {
      refusalSummary: (reason, more) => (more >= 1 ? `${reason} +${more}` : reason),
    },
  },
});

const t = (id, values = {}) => (id === 'messages:composer.attachLimit' ? `limit ${values.count}` : `too large ${values.file}`);
const file = (name, type, size = 1024) => ({ name, type, size });

test('the cap is the four every composer has always had', () => {
  assert.equal(mod().MAX_ATTACHMENTS, 4);
});

test('the ceiling is per kind of file', () => {
  const { attachmentLimit } = mod();
  const MB = 1024 * 1024;
  assert.equal(attachmentLimit(file('shot.png', 'image/png')), 4 * MB);
  assert.equal(attachmentLimit(file('notes.md', '')), 200 * 1024);
  assert.equal(attachmentLimit(file('bundle.zip', 'application/zip')), 20 * MB);
  assert.equal(attachmentLimit(file('thing.bin', 'application/octet-stream')), 10 * MB);
});

test('files past the room are counted in the one refusal line', () => {
  const { stageFiles } = mod();
  const { upload, refused } = stageFiles([file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')], 3, t);
  assert.equal(upload.length, 1, 'one place was left out of four');
  assert.equal(refused, 'limit 4 +1', 'the reason, then how many more went with it');
});

test('a pick with no room uploads nothing and says so', () => {
  const { stageFiles } = mod();
  const { upload, refused } = stageFiles([file('a.png', 'image/png')], 4, t);
  assert.deepEqual(upload, []);
  assert.equal(refused, 'limit 4');
});

test('a file over its kind of ceiling is refused, and the rest still go', () => {
  const { stageFiles } = mod();
  const big = file('broken-header.png', 'image/png', 5 * 1024 * 1024);
  const { upload, refused } = stageFiles([big, file('notes.md', 'text/markdown')], 0, t);
  assert.deepEqual(upload.map((item) => item.name), ['notes.md'], 'the too-large one is not uploaded');
  assert.equal(refused, 'too large broken-header.png', 'and it is the reason the line gives');
});

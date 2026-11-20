// The "No build output" row (src/services/build-output-check.js): a change to
// the platform's own repository that adds a file the shell build makes fails.
//
// Run with: node --test tests/build-output-check.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('../src/services/build-output-check');

const HEAD = 'a'.repeat(40);
const SELF = { selfAppSlug: 'homeroom' };
const args = (over = {}) => ({
  config: SELF, pool: null, sessionId: 7, appSlug: 'homeroom',
  repoOwner: 'o', repoName: 'r', commitHash: HEAD, ...over,
});

test('a file added under public/shell, or the two generated files, is build output', () => {
  const added = (filename) => check.buildOutputFiles([{ filename, status: 'added' }]);
  assert.deepEqual(added('public/shell/js/app.js').map((f) => f.file), ['public/shell/js/app.js']);
  assert.deepEqual(added('public/shell/index.html').map((f) => f.file), ['public/shell/index.html']);
  assert.deepEqual(added('public/index.html').map((f) => f.file), ['public/index.html']);
  assert.deepEqual(added('public/css/tailwind.css').map((f) => f.file), ['public/css/tailwind.css']);
  assert.deepEqual(added('public/js/app.js'), [], 'a real source file is not build output');
  assert.deepEqual(added('public/shellish/app.js'), [], 'only the shell output folder, not a lookalike');
});

test('only a status that puts a file at the path counts; deletions and edits pass', () => {
  const flagged = check.buildOutputFiles([
    { filename: 'public/shell/js/app.js', status: 'removed' },
    { filename: 'public/shell/js/old.js', status: 'modified' },
    { filename: 'public/shell/js/new.js', status: 'renamed', previous: 'public/js/new.js' },
    { filename: 'public/shell/js/copy.js', status: 'copied', previous: 'public/js/copy.js' },
  ]);
  assert.deepEqual(flagged.map((f) => f.file), ['public/shell/js/new.js', 'public/shell/js/copy.js'],
    'a rename or copy INTO the output folder is an addition; a deletion is the cleanup this change makes');
});

test('the row fails the gate and names the files and what to do', () => {
  const found = [{ file: 'public/shell/js/app.js', previous: null }];
  const row = check.shapeRow({ found, checkedSha: HEAD.toUpperCase() });
  assert.equal(row.name, 'No build output');
  assert.equal(row.index, check.BUILD_OUTPUT_CHECK_INDEX);
  assert.equal(check.BUILD_OUTPUT_CHECK_INDEX, -9);
  assert.equal(row.status, 'fail');
  assert.equal(row.advisory, false, 'it gates the merge like any failing check');
  assert.match(row.failureReason, /public\/shell\/js\/app\.js/);
  assert.match(row.failureReason, /build output/);
  assert.match(row.failureReason, /git rm --cached/);
  assert.equal(row.checkedSha, HEAD, 'the checked sha is lower-cased');
  assert.doesNotMatch(row.failureReason, /—/, 'no em dash');

  const pass = check.shapeRow({ found: [] });
  assert.deepEqual([pass.status, pass.advisory, pass.summary], ['pass', true, 'Passes']);
});

test('more than ten files: the reason names ten and counts the rest', () => {
  const found = Array.from({ length: 12 }, (_, i) => ({ file: `public/shell/copy-${i}.js`, previous: null }));
  const row = check.shapeRow({ found });
  assert.match(row.failureReason, /and 2 more/);
  assert.doesNotMatch(row.failureReason, /copy-10\.js/);
});

test('the run: only the platform repository is read, and the row fails for an added file', async () => {
  check._resetCache();
  const github = { compareFiles: async () => ({ files: [{ filename: 'public/shell/js/app.js', status: 'added' }], complete: true }) };
  const out = await check.maybeRunBuildOutputCheck({ ...args(), deps: { github } });
  assert.equal(out.row.status, 'fail');
  assert.match(out.row.failureReason, /public\/shell\/js\/app\.js/);
  assert.equal(out.row.checkedSha, HEAD);
});

test('an app other than the platform gets no row', async () => {
  check._resetCache();
  const github = { compareFiles: async () => { throw new Error('should not be read'); } };
  const out = await check.maybeRunBuildOutputCheck({ ...args({ appSlug: 'stylist' }), deps: { github } });
  assert.equal(out, null);
  const noConfig = await check.maybeRunBuildOutputCheck({ ...args({ config: null }), deps: { github } });
  assert.equal(noConfig, null);
});

test('a deletion change passes, and a failed read passes open saying it was not checked', async () => {
  check._resetCache();
  const deleting = { compareFiles: async () => ({ files: [{ filename: 'public/shell/js/app.js', status: 'removed' }], complete: true }) };
  const pass = await check.maybeRunBuildOutputCheck({ ...args(), deps: { github: deleting } });
  assert.equal(pass.row.status, 'pass');

  check._resetCache();
  const broken = { compareFiles: async () => { throw new Error('boom'); } };
  const open = await check.maybeRunBuildOutputCheck({ ...args(), deps: { github: broken } });
  assert.equal(open.row.status, 'pass');
  assert.equal(open.row.advisory, true);
  assert.match(open.row.summary, /not checked/);
});

test('a second read of the same head is served from the cache', async () => {
  check._resetCache();
  let calls = 0;
  const github = { compareFiles: async () => { calls += 1; return { files: [], complete: true }; } };
  await check.maybeRunBuildOutputCheck({ ...args(), deps: { github } });
  await check.maybeRunBuildOutputCheck({ ...args(), deps: { github } });
  assert.equal(calls, 1);
});

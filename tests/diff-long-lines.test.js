'use strict';

// A committed, minified bundle no longer makes a change "not read in full".
//
// The hold rules read a change's diff up to a character budget. An app that
// commits its bundle beside its source (SOLfun's public/build/app.js) put
// about 1 MB of minified lines ahead of twenty lines of source, so the budget
// ran out in the bundle, the source was never read and the admins were told
// about every change. services/diff-long-lines.js cuts such lines to their
// start, and the hold rules ask the diff reader for that. The git host's
// reader is covered in tests/hosted-git.test.js.
//
// Run with: node --test tests/diff-long-lines.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const { clipLongLines, LONG_LINE, KEEP } = require('../src/services/diff-long-lines');
const github = require('../src/services/github');
const holds = require('../src/services/release-holds');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('a very long line is cut to its start and says how long it was; other lines are untouched', () => {
  const minified = `+${'a=1;'.repeat(20000)}`;
  const patch = ['@@ -1,2 +1,2 @@', ' const kept = true;', `-${'b=2;'.repeat(20000)}`, minified, '+usernode.sendTransaction(a, b);'].join('\n');
  const out = clipLongLines(patch);
  assert.equal(out.clipped, 2);
  const lines = out.text.split('\n');
  assert.equal(lines.length, 5, 'no line is dropped');
  assert.equal(lines[1], ' const kept = true;');
  assert.equal(lines[4], '+usernode.sendTransaction(a, b);', 'a line a person wrote is read whole');
  assert.equal(lines[3].slice(0, KEEP), minified.slice(0, KEEP), 'its start stays, with its + sign');
  assert.match(lines[3], /… \(a line of 80001 characters, not read past here\)$/);
  assert.ok(lines[2].startsWith('-b=2;'), 'a removed line stays a removed line');
  assert.ok(out.text.length < 1000, 'so it no longer uses a budget');

  const edge = `+${'x'.repeat(LONG_LINE - 1)}`;
  assert.deepEqual(clipLongLines(`${edge}\n+short`), { text: `${edge}\n+short`, clipped: 0 }, 'a line at the limit is kept');
  assert.deepEqual(clipLongLines(''), { text: '', clipped: 0 });
  assert.deepEqual(clipLongLines(null), { text: '', clipped: 0 });
});

test('GitHub\'s reader: with the option the source after a bundle is read, without it nothing changes', async (t) => {
  const bundle = `@@ -1 +1 @@\n-${'old();'.repeat(30000)}\n+${'new();'.repeat(30000)}`;
  const source = '@@ -1 +1,2 @@\n const a = 1;\n+usernode.sendTransaction(a, b);';
  github._setOctokitFactoryForTests(() => ({
    rest: { repos: { compareCommitsWithBasehead: async () => ({ data: { files: [
      { filename: 'public/build/app.js', status: 'modified', patch: bundle },
      { filename: 'src/client/app.js', status: 'modified', patch: source },
    ] } }) } },
  }));
  t.after(() => github._setOctokitFactoryForTests(null));

  const before = await github.getProposalDiff('acme', 'app', 'main...abc', 120000);
  assert.equal(before.truncated, true, 'as it was: the bundle uses the whole budget');
  assert.doesNotMatch(before.diff, /sendTransaction/, 'and the source is never reached');
  assert.equal(before.clippedLines, 0);

  const after = await github.getProposalDiff('acme', 'app', 'main...abc', 120000, { clipLongLines: true });
  assert.equal(after.truncated, false);
  assert.equal(after.clippedLines, 2);
  assert.match(after.diff, /diff --git a\/src\/client\/app\.js b\/src\/client\/app\.js\n@@ -1 \+1,2 @@\n const a = 1;\n\+usernode\.sendTransaction\(a, b\);\n/);
  assert.match(after.diff, /\+new\(\);[^\n]* … \(a line of 180001 characters, not read past here\)\n/);
  assert.deepEqual(holds.tripped({ diff: after.diff, unread: after.truncated }), ['wallet'],
    'the rules read the source: what it does is seen, and the change is not unread');

  // Readable lines past the budget are still a change that was not read whole.
  const long = await github.getProposalDiff('acme', 'app', 'main...abc', 200, { clipLongLines: true });
  assert.equal(long.truncated, true);
});

test('the hold rules ask for it, and the check that must see whole lines does not', async () => {
  const calls = [];
  holds._resetCache();
  const db = { async query() { return { rows: [], rowCount: 0 }; } };
  await holds.evaluate({
    pool: db, session: { id: 1 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'c'.repeat(40),
    deps: {
      isFirstVersion: async () => false, notify: async () => {},
      github: { getProposalDiff: async (...args) => { calls.push(args); return { diff: '' }; } },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(3), [120000, { clipLongLines: true }]);
  // An outside <script> on one long line of minified HTML must still fail its
  // check, so that reader keeps every line whole.
  assert.doesNotMatch(read('src/services/outside-script-check.js'), /clipLongLines/);
  assert.match(read('src/services/hosted-git.js'), /getProposalDiff\(owner, repo, basehead, charBudget, opts = \{\}\)/);
});

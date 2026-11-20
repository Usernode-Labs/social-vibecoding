// test:changed: when public/ (tracked build output; scripts/test-changed.js)
//
// Build output must never be tracked. public/shell/ is the shell build's
// output folder (frontend/vite.config.ts empties it on every build), and
// public/index.html and public/css/tailwind.css are generated from
// frontend/ too. PR 6917 (20 Nov 2026) committed 127 files from
// public/shell/, so every later build saw them as deleted. This guard fails
// for any of them that is tracked, naming each one. A change that adds one is
// also failed by the "No build output" check (src/services/build-output-check.js);
// this test catches a copy that is already in the tree.
//
// Run with: node --test tests/no-committed-build-output.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PATHS = ['public/shell', 'public/index.html', 'public/css/tailwind.css'];

const WHY = 'It is build output: the shell build makes it, so it is not source and must not be '
  + 'committed. Remove it with `git rm --cached <path>` and leave it to the build.';

function trackedBuildOutput() {
  const out = execFileSync('git', ['ls-files', '--', ...PATHS], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

test('no build output is tracked', (t) => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    t.skip('no .git here (an image build context has no repository)');
    return;
  }
  let files;
  try {
    files = trackedBuildOutput();
  } catch (err) {
    t.skip(`git ls-files is unavailable: ${err.message}`);
    return;
  }
  assert.equal(
    files.length, 0,
    `Tracked build output:\n${files.map((f) => `  ${f}: ${WHY}`).join('\n')}`,
  );
});

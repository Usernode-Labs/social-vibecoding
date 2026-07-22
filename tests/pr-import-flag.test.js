// Unit tests for the #687 PR-import master flag (Slice 1).
//
// PR-import ships dark: every route/poller/merge branch in the later slices
// gates on config.isPrImportEnabled(), which must default OFF so merging the
// feature changes nothing until an operator explicitly enables it. This
// guards that contract (spec "Tests" → Flag).

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');

test('isPrImportEnabled() is OFF by default', () => {
  const prev = process.env.PR_IMPORT_ENABLED;
  delete process.env.PR_IMPORT_ENABLED;
  try {
    assert.equal(config.isPrImportEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED;
    else process.env.PR_IMPORT_ENABLED = prev;
  }
});

test('isPrImportEnabled() is ON only for the exact string "true"', () => {
  const prev = process.env.PR_IMPORT_ENABLED;
  try {
    process.env.PR_IMPORT_ENABLED = 'true';
    assert.equal(config.isPrImportEnabled(), true);

    for (const v of ['false', '1', 'yes', 'TRUE', '', 'on']) {
      process.env.PR_IMPORT_ENABLED = v;
      assert.equal(config.isPrImportEnabled(), false, `"${v}" must not enable the flag`);
    }
  } finally {
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED;
    else process.env.PR_IMPORT_ENABLED = prev;
  }
});

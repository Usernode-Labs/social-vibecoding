// #687 — the app payload must carry `pr_import_enabled` so the client can
// gate the "Import Feature from a PR" "+" menu entry without an extra
// round-trip. accessFlags() (src/routes/apps.js) mirrors the same env flag
// the pr-import routes gate on (config.isPrImportEnabled()), so the menu
// item never leads to a 404 dead-end.

const test = require('node:test');
const assert = require('node:assert/strict');

const { accessFlags } = require('../src/routes/apps');

const APP = { collab_visibility: 'public', created_by: 10 };
const USER = { id: 10 };

function withFlag(value, fn) {
  const prev = process.env.PR_IMPORT_ENABLED;
  try {
    if (value === undefined) delete process.env.PR_IMPORT_ENABLED;
    else process.env.PR_IMPORT_ENABLED = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.PR_IMPORT_ENABLED;
    else process.env.PR_IMPORT_ENABLED = prev;
  }
}

test('accessFlags exposes pr_import_enabled: true when PR_IMPORT_ENABLED="true"', () => {
  withFlag('true', () => {
    const flags = accessFlags(APP, USER, true);
    assert.equal(flags.pr_import_enabled, true);
  });
});

test('accessFlags exposes pr_import_enabled: false when the flag is off/unset', () => {
  withFlag(undefined, () => {
    assert.equal(accessFlags(APP, USER, true).pr_import_enabled, false);
  });
  for (const v of ['false', '1', 'yes', 'TRUE', '']) {
    withFlag(v, () => {
      assert.equal(accessFlags(APP, USER, true).pr_import_enabled, false,
        `"${v}" must not enable pr_import_enabled`);
    });
  }
});

test('pr_import_enabled is independent of the viewer\'s collaborator status', () => {
  // The flag reflects feature availability only; can_collaborate is a
  // separate field the menu ANDs with. A non-collaborator still sees the
  // true flag (the backend route remains the source of truth).
  withFlag('true', () => {
    assert.equal(accessFlags(APP, null, false).pr_import_enabled, true);
    assert.equal(accessFlags(APP, USER, true).pr_import_enabled, true);
  });
});

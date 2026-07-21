// Unit tests for #687 Slice 5 — the PR-import flags resolve ON in a staging
// preview and OFF in production, purely by manifest value (no USERNODE_ENV
// code branch). Guards the staging-ON/prod-OFF asymmetry against regression.
//
// Resolution path under test: app-manifest.read() parses dapp.json, then
// app-secrets.mergeForDeploy(manifest, stored, platformDefaults, { forStaging })
// applies the private/staging_default rules (services/app-secrets.js).
//
// Run with: node --test tests/pr-import-manifest-flags.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const manifestSvc = require('../src/services/app-manifest');
const secrets = require('../src/services/app-secrets');

// The real repo-root dapp.json — the manifest that actually ships.
const REPO_ROOT = path.join(__dirname, '..');

function resolve(forStaging) {
  const manifest = manifestSvc.read(REPO_ROOT);
  // No stored prod value, no platform default → exercise the pure
  // default/staging_default fallback path for both flags.
  const { env } = secrets.mergeForDeploy(manifest, {}, {}, { forStaging });
  return env;
}

test('dapp.json declares both PR-import flags as private with default OFF / staging ON', () => {
  const manifest = manifestSvc.read(REPO_ROOT);
  for (const key of ['PR_IMPORT_ENABLED', 'PR_IMPORT_MOCK_GITHUB']) {
    const entry = manifest.secrets.find((s) => s.key === key);
    assert.ok(entry, `${key} present in manifest`);
    assert.equal(entry.required, false, `${key} is not required`);
    assert.equal(entry.private, true, `${key} is private (isolates staging + at-rest)`);
    assert.equal(entry.default, 'false', `${key} default is "false"`);
    assert.equal(entry.staging_default, 'true', `${key} staging_default is "true"`);
  }
});

test('production path resolves both flags OFF (no stored value → default "false")', () => {
  const env = resolve(false);
  assert.equal(env.PR_IMPORT_ENABLED, 'false');
  assert.equal(env.PR_IMPORT_MOCK_GITHUB, 'false');
});

test('staging path resolves both flags ON (private → staging_default "true")', () => {
  const env = resolve(true);
  assert.equal(env.PR_IMPORT_ENABLED, 'true');
  assert.equal(env.PR_IMPORT_MOCK_GITHUB, 'true');
});

test('isPrImportEnabled/isPrImportMockGithubEnabled read the env var verbatim (no USERNODE_ENV branch)', () => {
  const cfg = require('../src/config');
  const prevEnabled = process.env.PR_IMPORT_ENABLED;
  const prevMock = process.env.PR_IMPORT_MOCK_GITHUB;
  const prevUnEnv = process.env.USERNODE_ENV;
  try {
    // Even claiming to be "staging" must not flip the accessors — only the
    // injected env value does.
    process.env.USERNODE_ENV = 'staging';
    delete process.env.PR_IMPORT_ENABLED;
    delete process.env.PR_IMPORT_MOCK_GITHUB;
    assert.equal(cfg.isPrImportEnabled(), false, 'unset → false even in staging');
    assert.equal(cfg.isPrImportMockGithubEnabled(), false, 'unset → false even in staging');

    process.env.PR_IMPORT_ENABLED = 'true';
    process.env.PR_IMPORT_MOCK_GITHUB = 'true';
    assert.equal(cfg.isPrImportEnabled(), true);
    assert.equal(cfg.isPrImportMockGithubEnabled(), true);

    for (const v of ['false', '1', 'TRUE', 'yes', '']) {
      process.env.PR_IMPORT_ENABLED = v;
      assert.equal(cfg.isPrImportEnabled(), false, `"${v}" must not enable`);
    }
  } finally {
    if (prevEnabled === undefined) delete process.env.PR_IMPORT_ENABLED; else process.env.PR_IMPORT_ENABLED = prevEnabled;
    if (prevMock === undefined) delete process.env.PR_IMPORT_MOCK_GITHUB; else process.env.PR_IMPORT_MOCK_GITHUB = prevMock;
    if (prevUnEnv === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prevUnEnv;
  }
});

'use strict';

// Contract coverage must follow shared owners and the contained CLI path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { SUITES } = require('../scripts/test-preview-flow');
const { spawnSync } = require('node:child_process');

test('focused CI refuses a general SQL fallback without its explicit contract database', () => {
  const result = spawnSync(process.execPath, ['scripts/test-preview-flow.js'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SQL_CHECK_CONNECTION_URL: 'postgresql://unused@database.invalid/test' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require PREVIEW_FLOW_TEST_DATABASE_URL/);
});

test('focused CI runs the shared runtime, admission, runtime and checks retirement regressions', () => {
  for (const file of SUITES) assert.ok(fs.existsSync(file), file);
  assert.equal(new Set(SUITES).size, SUITES.length);
  for (const file of [
    'tests/disposable-postgres.test.js',
    'tests/preview-worker-bootstrap.test.js',
    'tests/packaged-cli-isolation.test.js',
    'tests/decision-runtime.test.js',
    'tests/execution-worker.test.js',
    'tests/review-work.test.js',
    'tests/preview-admission.test.js',
    'tests/experimental-support.test.js',
    'tests/recoverable-preview-runtime.test.js',
    'tests/cli-preview-handoff-postgres.test.js',
    'tests/cli-preview-checks.test.js',
    'tests/cli-check-settlement-postgres.test.js',
    'tests/check-retirement.test.js',
    'tests/published-predecessor-retirement.test.js',
    'tests/check-harvest.test.js',
    'tests/check-history.test.js',
    'tests/merge-queue.test.js',
  ]) assert.ok(SUITES.includes(file), file);
});

test('focused CI triggers for its suites, shared owners and operation contracts', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/preview-flow-contract.yml', 'utf8'));
  const patterns = workflow.on.pull_request.paths;
  for (const file of [
    ...SUITES,
    'tests/packaged-cli-entrypoints-integration.test.js',
    'tests/published-predecessor-integration.test.js',
    'tests/lib/packaged-cli-preload.js',
    'tests/lib/packaged-cli-fixture.js',
    'archives/experimental-replay-c01dc0687/replay.cjs',
    'src/services/decision-runtime/index.js',
    'src/services/execution/store.js',
    'src/services/preview-flow/runtime-intent.js',
    'src/services/cli-preview-handoff/checks.js',
    'src/services/proposal-review/store.js',
    'src/services/check-retirement.js',
    'src/services/check-history.js',
    'src/services/merge-queue.js',
    'src/services/github.js',
    'src/services/llm.js',
    'src/services/visuals.js',
    'src/services/kubernetes.js',
    'src/db/schema.sql',
    'sql-dynamic-baseline.json',
    'scripts/preview-preparation-worker.js',
    'scripts/preview-postgres-fixture.js',
    'tests/lib/disposable-postgres.js',
    'tests/lib/preview-postgres-fixture.js',
  ]) {
    assert.ok(fs.existsSync(file), file);
    assert.ok(patterns.some(pattern => path.matchesGlob(file, pattern)), file);
  }
});

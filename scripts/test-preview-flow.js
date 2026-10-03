#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { verifyDisposablePostgres, verifiedTestEnvironment } = require('../tests/lib/disposable-postgres');

const SUITES = [
  'tests/preview-contract-ci.test.js',
  'tests/preview-worker-bootstrap.test.js',
  'tests/packaged-cli-isolation.test.js',
  'tests/https-private-fixture.test.js',
  'tests/disposable-postgres.test.js',
  'tests/decision-runtime.test.js',
  'tests/execution-worker.test.js',
  'tests/preview-admission.test.js',
  'tests/experimental-support.test.js',
  'tests/preview-work.test.js',
  'tests/recoverable-preview-clone.test.js',
  'tests/recoverable-preview-build.test.js',
  'tests/recoverable-preview-runtime.test.js',
  'tests/cli-preview-handoff-postgres.test.js',
  'tests/native-preview-manual-postgres.test.js',
  'tests/native-preview-recheck-postgres.test.js',
  'tests/native-preview-submission-postgres.test.js',
  'tests/native-preview-request-client.test.js',
  'tests/cli-handoff-sync.test.js',
  'tests/sync-progress.test.js',
  'tests/headless-staging.test.js',
  'tests/generated-dockerfile-user.test.js',
  'tests/key-separation-env.test.js',
  'tests/cli-preview-checks.test.js',
  'tests/cli-check-settlement-postgres.test.js',
  'tests/cli-preview-checks-outcome.test.js',
  'tests/check-harvest.test.js',
  'tests/check-history.test.js',
  'tests/merge-queue.test.js',
  'tests/check-retirement.test.js',
  'tests/published-predecessor-retirement.test.js',
  'tests/unit-suite-check.test.js',
  'tests/unit-suite-source-inspection.test.js',
  'tests/review-work.test.js',
  'tests/unpromote-proposal-postgres.test.js',
  'tests/preview-flow.test.js',
  'tests/preview-candidate.test.js',
  'tests/preview-runtime-isolation.test.js',
  'tests/preview-binding-adapters.test.js',
  'tests/preview-cleanup.test.js',
  'tests/preview-flow-ownership.test.js',
  'tests/preview-lifecycle.test.js',
  'tests/proposal-handoff.test.js',
  'tests/staging-build-serialize.test.js',
  'tests/local-agent-tail.test.js',
  'tests/kubernetes-runtime.test.js',
  'tests/application-runtime.test.js',
  'tests/kubernetes-preview-inventory.test.js',
  'tests/staging-reap.test.js',
  'tests/homeroom-bot-checks-fix.test.js',
  'tests/pr-import-sync.test.js',
  'tests/proposal-update.test.js',
  'tests/proposal-description-postgres.test.js',
  'tests/proposal-description-edit.test.js',
  'tests/homeroom-bot-restart-recovery.test.js',
  'tests/isolated-kpack-fixture.test.js',
  'tests/kpack-local-fixture.test.js',
];

async function main() {
  // This job cannot claim success by skipping its transaction races. External
  // operations are injected; actual-resource evidence uses its isolated harness.
  // Require the explicit service DB instead of inheriting a general SQL fallback.
  const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.error('Preview contract tests require PREVIEW_FLOW_TEST_DATABASE_URL (a disposable PostgreSQL database).');
    process.exitCode = 1;
    return;
  }

  await verifyDisposablePostgres(databaseUrl);

  const result = spawnSync(process.execPath, [
    '--require', './tests/lib/test-net.js',
    '--test',
    '--test-force-exit',
    '--test-timeout=180000',
    '--test-concurrency=1',
    ...SUITES,
  ], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: verifiedTestEnvironment(process.env, databaseUrl),
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

if (require.main === module) main().catch(error => {
  console.error(error.message.startsWith('Disposable PostgreSQL preflight:')
    ? error.message : 'Disposable PostgreSQL preflight failed');
  process.exitCode = 1;
});

module.exports = { SUITES };

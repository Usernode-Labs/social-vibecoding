#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

if (!process.env.PREVIEW_FLOW_TEST_DATABASE_URL || !process.env.KPACK_RECOVERY_TEST_CONFIG) {
  console.error('Actual build proof requires PREVIEW_FLOW_TEST_DATABASE_URL and KPACK_RECOVERY_TEST_CONFIG (a labeled disposable kpack namespace and pinned public source). No integration checkpoint is demonstrated.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [
    '--test', '--test-force-exit', '--test-timeout=1200000',
    'tests/recoverable-preview-build-integration.test.js',
  ], { stdio: 'inherit', env: process.env });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// The full unit suite can run offline; this contract job cannot claim success
// by skipping its transaction races. Only an explicit disposable DB is used.
const url = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
if (!url) {
  console.error('Preview contract tests require PREVIEW_FLOW_TEST_DATABASE_URL (a disposable PostgreSQL database).');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [
    '--require', './tests/lib/test-net.js', '--test', '--test-force-exit', '--test-timeout=180000',
    'tests/preview-flow.test.js', 'tests/preview-cleanup.test.js', 'tests/preview-flow-ownership.test.js',
    'tests/preview-lifecycle.test.js', 'tests/proposal-handoff.test.js',
    'tests/staging-build-serialize.test.js', 'tests/local-agent-tail.test.js',
  ], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
    env: { ...process.env, PREVIEW_FLOW_TEST_DATABASE_URL: url, PREVIEW_LIFECYCLE_TEST_DATABASE_URL: url },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

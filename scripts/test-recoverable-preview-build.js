#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { verifyIsolatedBuildFixture, sanitizedEnvironment } = require('../tests/lib/isolated-kpack-fixture');

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && !['--runtime', '--release', '--preparation', '--handoff'].includes(process.argv[2]))) {
    throw new Error('Only --runtime, --release, --preparation or --handoff is supported');
  }
  const env = sanitizedEnvironment();
  await verifyIsolatedBuildFixture({ env });
  const selections = {
    '--handoff': ['tests/cli-preview-handoff-postgres.test.js', 'tests/cli-preview-handoff-integration.test.js'],
    '--preparation': ['tests/complete-preview-preparation-integration.test.js'],
    '--release': ['tests/retired-database-release-integration.test.js'],
    '--runtime': ['tests/recoverable-preview-runtime-integration.test.js'],
  };
  const files = selections[process.argv[2]] || ['tests/recoverable-preview-build-integration.test.js'];
  const result = spawnSync(process.execPath, [
    '--test', '--test-force-exit', '--test-timeout=1200000', '--test-concurrency=1', ...files,
  ], { stdio: 'inherit', env });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

main().catch(error => {
  console.error(`${error.message}\nNo integration mutations were authorized; Isolated integration evidence remains pending.`);
  process.exitCode = 1;
});

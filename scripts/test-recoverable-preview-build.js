#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { verifyIsolatedBuildFixture, sanitizedEnvironment } = require('../tests/lib/isolated-kpack-fixture');

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && !['--runtime', '--release'].includes(process.argv[2]))) {
    throw new Error('Only --runtime or --release is supported');
  }
  const env = sanitizedEnvironment();
  await verifyIsolatedBuildFixture({ env });
  const result = spawnSync(process.execPath, [
    '--test', '--test-force-exit', '--test-timeout=1200000',
    process.argv[2] === '--release' ? 'tests/retired-database-release-integration.test.js'
      : process.argv[2] === '--runtime' ? 'tests/recoverable-preview-runtime-integration.test.js'
        : 'tests/recoverable-preview-build-integration.test.js',
  ], { stdio: 'inherit', env });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

main().catch(error => {
  console.error(`${error.message}\nNo integration mutations were authorized; Isolated integration evidence remains pending.`);
  process.exitCode = 1;
});

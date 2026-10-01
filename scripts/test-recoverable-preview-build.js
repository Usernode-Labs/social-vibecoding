#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { verifyIsolatedBuildFixture, sanitizedEnvironment } = require('../tests/lib/isolated-kpack-fixture');

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--runtime')) throw new Error('Only --runtime is supported');
  const env = sanitizedEnvironment();
  await verifyIsolatedBuildFixture({ env });
  const result = spawnSync(process.execPath, [
    '--test', '--test-force-exit', '--test-timeout=1200000',
    process.argv[2] === '--runtime' ? 'tests/recoverable-preview-runtime-integration.test.js'
      : 'tests/recoverable-preview-build-integration.test.js',
  ], { stdio: 'inherit', env });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}

main().catch(error => {
  console.error(`${error.message}\nNo integration mutations were authorized; C4 evidence remains pending.`);
  process.exitCode = 1;
});

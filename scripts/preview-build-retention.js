'use strict';

// Read-only inventory using the same rules as the leader's scheduled sweep.
require('dotenv').config({ quiet: true });
const { load } = require('../src/config');
const { getPool } = require('../src/db/pool');
const { sweep } = require('../src/services/build-retention');

async function main() {
  const config = load();
  if (config.appRuntime !== 'kubernetes') throw new Error('APP_RUNTIME must be kubernetes');
  const pool = getPool(config);
  try {
    console.log(JSON.stringify(await sweep(config, { dryRun: true, pool }), null, 2));
  } finally { await pool.end(); }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

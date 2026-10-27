#!/usr/bin/env node
'use strict';
// Run from the NEW platform environment only, after old builders are gone.
// See docs/security/platform-preview-data.md. This removes previews, not
// production apps. A successful API delete alone is not acceptance.
async function main() {
  const config = require('../src/config').load();
  if (process.env.USERNODE_ENV === 'staging') throw new Error('Run retirement in the production orchestrator environment');
  const pool = require('../src/db/pool').getPool(config);
  try {
    const result = await require('../src/services/platform-preview-retirement').retire(config, pool);
    console.log(JSON.stringify({ policy: require('../src/services/platform-preview-data-policy').DIGEST, ...result }));
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => {
  console.error(`Platform preview retirement incomplete: ${error.message}`);
  process.exitCode = 1;
});
module.exports = { main };

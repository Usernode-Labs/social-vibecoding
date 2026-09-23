'use strict';

// Operator-created Kubernetes Job entrypoint. No placement or source mutations.
const fs = require('node:fs');
const { copyDatabase } = require('../src/services/database-copy');
async function main() {
  const config = JSON.parse(fs.readFileSync('/etc/sv-database-copy/config.json','utf8'));
  // Rehearsals can populate only a separately named scratch database.
  if (!/^app_copy_[a-z0-9_]+$/.test(config.destination?.database || '')) throw new Error('Invalid rehearsal destination');
  const result = await copyDatabase(config);
  console.log(JSON.stringify({ phase:'Verified', ...result }));
}
main().catch(error => {
  const code = /^COPY_[A-Z_]+$/.test(error.code || '') ? error.code : 'COPY_INVALID_CONFIG';
  console.error(JSON.stringify({phase:'Failed',code}));
  process.exitCode=1;
});

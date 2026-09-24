'use strict';

// Operator-created Kubernetes Job entrypoint. No placement or source mutations.
const fs = require('node:fs');
const { copyDatabase } = require('../src/services/database-copy');
function validateMode(config, mode = process.env.SV_DATABASE_COPY_MODE) {
  if (mode === 'move') {
    if (!/^app_[a-z0-9_]+$/.test(config.source?.database || '')
      || config.destination?.database !== config.source.database) throw new Error('Invalid move destination');
  } else if (mode || !/^app_copy_[a-z0-9_]+$/.test(config.destination?.database || '')) {
    throw new Error('Invalid rehearsal destination');
  }
}
async function main() {
  const config = JSON.parse(fs.readFileSync('/etc/sv-database-copy/config.json','utf8'));
  validateMode(config);
  const result = await copyDatabase(config);
  console.log(JSON.stringify({ phase:'Verified', ...result }));
}
if (require.main === module) main().catch(error => {
  const code = /^COPY_[A-Z_]+$/.test(error.code || '') ? error.code : 'COPY_INVALID_CONFIG';
  console.error(JSON.stringify({phase:'Failed',code}));
  process.exitCode=1;
});
module.exports = { validateMode };

'use strict';

// The before & after shots runner (src/services/shots-environment.js) starts
// this inside the AFTER copy's image, pointed at the BEFORE copy's database,
// once both copies have booted. It runs the change's own staging seeds there
// so both sides hold the demo data the change adds (src/db/seed-other-copy.js).
//
// It answers GET /healthz 200 at once, and GET /result 202 while the seeds
// run, then 200 with the runner's JSON. It applies no schema, reference data
// or backfill, and it refuses to start unless it is staging and its DATABASE_URL
// is this run's base shots database.

const http = require('node:http');
const configModule = require('../src/config');
const shotsFixtures = require('../src/services/shots-fixtures');

const PORT = 3000;

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const slug = process.env.SHOTS_SEED_SLUG;
  const runId = process.env.SHOTS_SEED_RUN_ID;
  if (process.env.USERNODE_ENV !== 'staging') {
    refuse('The before-copy seed runner only runs in staging.');
  }
  try {
    shotsFixtures.assertShotsDatabase(databaseUrl, slug, runId, 'base');
  } catch (_) {
    refuse('The before-copy seed runner requires this run\'s base shots database.');
  }

  let result = null;
  let failed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/result') {
      if (result) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(202, { 'content-type': 'text/plain' });
        res.end('pending');
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(PORT, '0.0.0.0', () => {
    // Loaded after the server is up so /healthz answers while config and
    // the seeds are still starting.
    let config;
    try {
      config = configModule.load();
    } catch (error) {
      process.stderr.write(`Before-copy seed runner could not load config: ${error.message}\n`);
      failed = true;
      return;
    }
    const { applySeedsToOtherCopy } = require('../src/db/seed-other-copy');
    applySeedsToOtherCopy(databaseUrl, config).then((applied) => {
      result = applied;
    }).catch((error) => {
      failed = true;
      process.stderr.write(`Before-copy seed runner failed: ${error.message}\n`);
    });
  });
  return { server, failed: () => failed };
}

if (require.main === module) main();

module.exports = { main };

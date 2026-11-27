'use strict';

// The before & after shots runner (src/services/shots-environment.js) starts
// this inside the AFTER copy's image, pointed at the BEFORE copy's database,
// once both copies have booted. It runs the change's own staging seeds there
// so both sides hold the demo data the change adds (src/db/seed-other-copy.js).
//
// It answers GET /health (and /healthz) 200 at once, and GET /result 202
// while the seeds run, then 200 with the runner's JSON. It applies no
// schema, reference data or backfill, and it refuses to start unless it is
// staging and its DATABASE_URL is this run's base shots database.
//
// /health is the path every runtime it is deployed as probes
// (src/services/kubernetes.js httpProbes, application-runtime.js
// waitForHealthy). Answering only /healthz, as it did at first, left the
// runner never Ready: each Homeroom change's copies waited out the
// deployment's five-minute rollout and the seeds never reached the before
// copy (tests/shots-before-seeds-script.test.js pins the paths).
//
// When the seeds fail, /result says so (`failed: true`) instead of staying
// pending, so the platform stops waiting at once rather than after its
// SEEDS_TIMEOUT_MS. The error itself stays in this process's stderr.

const http = require('node:http');
const configModule = require('../src/config');
const shotsFixtures = require('../src/services/shots-fixtures');

const PORT = 3000;
const HEALTH_PATHS = Object.freeze(['/health', '/healthz']);
const FAILED_RESULT = Object.freeze({ version: 1, failed: true });

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// `state.result` is the runner's JSON once the seeds are done, and
// `state.failed` true when they could not run.
function createServer(state) {
  return http.createServer((req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (HEALTH_PATHS.includes(pathname)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (pathname === '/result') {
      const answer = state.result || (state.failed ? FAILED_RESULT : null);
      if (answer) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      } else {
        res.writeHead(202, { 'content-type': 'text/plain' });
        res.end('pending');
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
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

  const state = { result: null, failed: false };
  const server = createServer(state);
  server.listen(PORT, '0.0.0.0', () => {
    // Loaded after the server is up so /health answers while config and
    // the seeds are still starting.
    let config;
    try {
      config = configModule.load();
    } catch (error) {
      process.stderr.write(`Before-copy seed runner could not load config: ${error.message}\n`);
      state.failed = true;
      return;
    }
    const { applySeedsToOtherCopy } = require('../src/db/seed-other-copy');
    applySeedsToOtherCopy(databaseUrl, config).then((applied) => {
      state.result = applied;
    }).catch((error) => {
      state.failed = true;
      process.stderr.write(`Before-copy seed runner failed: ${error.message}\n`);
    });
  });
  return { server, failed: () => state.failed };
}

if (require.main === module) main();

module.exports = { main, createServer, HEALTH_PATHS, FAILED_RESULT };

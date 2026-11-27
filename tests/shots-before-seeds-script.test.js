'use strict';

// scripts/shots-before-seeds.js writes a change's own staging seeds into the
// pair's BEFORE copy. Before it opens a connection it must refuse any
// database that is not this run's base shots database, and refuse to run
// outside staging: the only data it may touch is the run's two disposable
// copies.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dbManager = require('../src/services/db-manager');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'shots-before-seeds.js');
const SLUG = 'usernode-2d5619';
const RUN_ID = 'a'.repeat(32);

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function postgresUrl(dbName) {
  return `postgres://fixture:secret@db.example.test:5432/${dbName}`;
}

test('the runner refuses a database that is not the run\'s base shots database', () => {
  const headDb = dbManager.shotsDbName(SLUG, RUN_ID, 'head');
  const result = run({
    USERNODE_ENV: 'staging',
    DATABASE_URL: postgresUrl(headDb),
    SHOTS_SEED_SLUG: SLUG,
    SHOTS_SEED_RUN_ID: RUN_ID,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base shots database/);
});

test('the runner refuses to run outside staging', () => {
  const baseDb = dbManager.shotsDbName(SLUG, RUN_ID, 'base');
  const result = run({
    USERNODE_ENV: 'production',
    DATABASE_URL: postgresUrl(baseDb),
    SHOTS_SEED_SLUG: SLUG,
    SHOTS_SEED_RUN_ID: RUN_ID,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only runs in staging/);
});

test('the runner accepts this run\'s base shots database', async () => {
  const baseDb = dbManager.shotsDbName(SLUG, RUN_ID, 'base');
  // It may fail to connect, but it must get past the guards and start
  // listening rather than refuse; stop it once it has had time to.
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      USERNODE_ENV: 'staging',
      DATABASE_URL: postgresUrl(baseDb),
      SHOTS_SEED_SLUG: SLUG,
      SHOTS_SEED_RUN_ID: RUN_ID,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 800));
  child.kill('SIGKILL');
  await closed;
  assert.doesNotMatch(stderr, /base shots database|only runs in staging/);
});

// The runner is deployed like any app runtime, so it is only ever seen as
// started when it answers the path those runtimes are probed on. It once
// answered /healthz alone: every probe got a 404, the pod was never Ready,
// and each Homeroom change's copies waited out the five-minute rollout
// while the seeds never reached the before copy.
const fs = require('node:fs');
const http = require('node:http');
const seedRunner = require('../scripts/shots-before-seeds');

function probedHealthPaths() {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const kubernetes = /function httpProbes\b[\s\S]*?httpGet: \{ path: '([^']+)'/.exec(read('src/services/kubernetes.js'));
  assert.ok(kubernetes, 'kubernetes.js httpProbes names the path it probes');
  const docker = [...read('src/services/application-runtime.js').matchAll(/waitForHealthy\([^)]*?'([^']+)'\)/g)]
    .map((match) => match[1]);
  assert.ok(docker.length > 0, 'application-runtime.js names the path Docker waits on');
  return [...new Set([kubernetes[1], ...docker])];
}

async function withRunner(state, fn) {
  const server = seedRunner.createServer(state);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (urlPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try { return await fn(get); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('the runner answers healthy on every path its runtimes are probed on, at once', async () => {
  const paths = probedHealthPaths();
  assert.ok(paths.includes('/health'));
  await withRunner({ result: null, failed: false }, async (get) => {
    for (const probe of paths) {
      assert.ok(seedRunner.HEALTH_PATHS.includes(probe), `${probe} is one of the runner's health paths`);
      const res = await get(probe);
      assert.equal(res.status, 200, `${probe} answers 200 while the seeds are still running`);
    }
    assert.equal((await get('/healthz')).status, 200, '/healthz still answers');
    assert.equal((await get('/nothing-here')).status, 404);
  });
});

test('/result is pending while the seeds run, then the runner\'s JSON, or failed when they could not run', async () => {
  const state = { result: null, failed: false };
  await withRunner(state, async (get) => {
    const pending = await get('/result');
    assert.equal(pending.status, 202);
    assert.equal(pending.body, 'pending');

    state.result = { version: 1, applied: ['seedSample'], leftOut: [] };
    const done = await get('/result');
    assert.equal(done.status, 200);
    assert.deepEqual(JSON.parse(done.body), state.result);

    state.result = null;
    state.failed = true;
    const failed = await get('/result');
    assert.equal(failed.status, 200, 'a failure is an answer, so the platform stops waiting');
    assert.deepEqual(JSON.parse(failed.body), { version: 1, failed: true });
    assert.doesNotMatch(failed.body, /error|postgres|password/i, 'the error itself stays in the runner\'s own log');
  });
});

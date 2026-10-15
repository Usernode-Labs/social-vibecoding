// The drift poller does not ask for a deploy that keeps failing for the
// same commit at full cadence. Before this a commit main could not build (a
// Dockerfile the build sandbox cannot build, a syntax error) was rebuilt
// every tick, forever: a full image build per tick and, until staging.js
// learned to suppress repeats, a "Deploy failed" notification per tick.
//
// Every production deploy is a request app delivery runs, and what decides
// whether to ask is the app's row: nothing is asked while a deploy of the
// app runs (deploy_state), a commit whose deploy failed is asked again only
// after a wait (last_failure), and a commit refused for running as root
// waits for a new one. The admin's manual "Check for updates" skips both
// waits. Being durable, another Pod or a restarted one decides the same.
//
// Run with: node --test tests/main-drift-poller-backoff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  github: require.resolve('../src/services/github'),
  conflictResolver: require.resolve('../src/services/conflict-resolver'),
  mainWatch: require.resolve('../src/services/main-watch'),
  platform: require.resolve('../src/workflow/platform.ts'),
};

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
stub(ids.pool, { getPool: () => pool });

let remoteSha = null;
let fetchError = null;
const readClient = {
  rest: {
    repos: {
      getBranch: async () => {
        if (fetchError) throw fetchError;
        return { data: { commit: { sha: remoteSha } } };
      },
    },
  },
};
stub(ids.github, {
  parseGithubUrl: (url) => {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  getOctokit: async () => readClient,
  // main's tip is a read (services/github.js getReadOctokit).
  getReadOctokit: async () => readClient,
  isEnabled: () => true,
});
stub(ids.conflictResolver, { checkAndResolveConflicts: async () => {} });
stub(ids.mainWatch, { afterMerge: async () => {} });
// The app-delivery machine: what was asked of it, and the app's row as it
// reads it.
const delivery = { requested: [], row: { deploy_state: null, last_failure: null } };
stub(ids.platform, {
  requestDeploy: async (appId, reason) => { delivery.requested.push([appId, reason]); return 1; },
});

const queries = [];
const pool = {
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/SELECT deploy_state, last_failure FROM apps/.test(String(sql))) return { rows: [delivery.row], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
};

const poller = require('../src/services/main-drift-poller');

const RED = 'e7ab4060ee62bea30536db98af7a06aff33554e9';
const RUNNING = 'de34dda1111111111111111111111111111111111';
const FIXED = 'f1x3d000000000000000000000000000000000000';
const app = { id: 8, slug: 'falling-sands', repo_url: 'https://github.com/example/falling-sands', main_sha: RUNNING };
const config = {};
const WAIT_MS = 30 * 60 * 1000;

let clock = 0;
function reset() {
  poller._forTest.setClock(() => clock);
  poller._forTest.resetHeadCache();
  clock = 1_000_000;
  queries.length = 0;
  remoteSha = RED;
  fetchError = null;
  delivery.requested.length = 0;
  delivery.row = { deploy_state: null, last_failure: null };
}

const minutesAgo = (n) => new Date(clock - n * 60 * 1000).toISOString();

test('drift asks app delivery for the deploy, and the machine writes main_sha', async () => {
  reset();
  const asked = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(asked.status, 'deploy_requested');
  assert.equal(asked.from, RUNNING);
  assert.equal(asked.to, RED);
  assert.deepEqual(delivery.requested, [[8, 'drift']]);
  assert.ok(!queries.some((q) => /UPDATE apps/.test(q.sql)), 'no write of its own');
});

test('while a deploy of the app runs, in any process, nothing is asked again', async () => {
  reset();
  delivery.row = { deploy_state: 'deploying', last_failure: null };
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'in_flight');
  assert.equal((await poller.checkAndRedeployOne(config, pool, app, { manual: true })).status, 'in_flight');
  assert.deepEqual(delivery.requested, []);
});

test('a commit whose deploy failed waits 30 minutes, unless an admin asks', async () => {
  reset();
  delivery.row = { deploy_state: null, last_failure: { sha: RED, at: minutesAgo(1) } };
  const held = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(held.status, 'backing_off');
  assert.equal(held.attempted, RED);
  assert.equal(held.retryInMs, WAIT_MS - 60 * 1000);
  assert.deepEqual(delivery.requested, []);

  // The admin has just fixed the thing that was failing (say, the network
  // policy) and asks now; the same commit is asked for immediately.
  assert.equal((await poller.checkAndRedeployOne(config, pool, app, { manual: true })).status, 'deploy_requested');

  // Once the wait has passed, the poller asks again.
  clock += WAIT_MS;
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'deploy_requested');
  assert.deepEqual(delivery.requested.map((r) => r[1]), ['check_updates', 'drift']);
});

test('a failure that names no commit (a clone that failed) waits the same', async () => {
  reset();
  delivery.row = { deploy_state: null, last_failure: { sha: null, at: minutesAgo(1) } };
  assert.equal((await poller.checkAndRedeployOne(config, pool, app)).status, 'backing_off');
  assert.deepEqual(delivery.requested, []);
});

test('a new commit on main is a new attempt: a failure of the previous one does not hold it', async () => {
  reset();
  delivery.row = { deploy_state: null, last_failure: { sha: RED, at: minutesAgo(1) } };
  remoteSha = FIXED;
  const r = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(r.status, 'deploy_requested');
  assert.equal(r.to, FIXED);
  assert.deepEqual(delivery.requested, [[8, 'drift']]);
});

test('fetch failures and first-seen backfills ask for nothing', async () => {
  reset();
  fetchError = new Error('rate limited');
  const fetchFailed = await poller.checkAndRedeployOne(config, pool, app);
  assert.equal(fetchFailed.status, 'fetch_failed');

  fetchError = null;
  const firstSeen = await poller.checkAndRedeployOne(config, pool, { ...app, main_sha: null });
  assert.equal(firstSeen.status, 'first_seen');
  assert.ok(queries.some((q) => /SET main_sha = \$1 WHERE id = \$2 AND main_sha IS NULL/.test(q.sql)));
  assert.deepEqual(delivery.requested, []);
});

// A commit whose image was refused for running as root (deploy-failure.js)
// waits for a commit that changes it; "Check for updates" still asks, and
// app delivery retries the refused commit for a check_updates request.
test('a commit refused for running as root waits for a new one; a manual check still asks for it', async () => {
  reset();
  const refused = { ...app, last_failure: { stage: 'healthcheck', kind: 'root_image', sha: RED, reason: 'runs as root' } };
  const waiting = await poller.checkAndRedeployOne(config, pool, refused);
  assert.equal(waiting.status, 'waits_for_new_commit');
  assert.deepEqual(delivery.requested, []);

  const manual = await poller.checkAndRedeployOne(config, pool, refused, { manual: true });
  assert.equal(manual.status, 'deploy_requested');
  assert.deepEqual(delivery.requested, [[8, 'check_updates']]);

  remoteSha = FIXED;
  const fixed = await poller.checkAndRedeployOne(config, pool, refused);
  assert.equal(fixed.status, 'deploy_requested', 'a new commit on main is asked for');
  assert.deepEqual(delivery.requested, [[8, 'check_updates'], [8, 'drift']]);
});

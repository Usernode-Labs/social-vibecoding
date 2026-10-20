// main's drift (services/main-drift-poller.js), the main-drift clock's
// look: each running app's main read, and app delivery told about a commit
// production does not run (MainMoved, keyed by the commit, so the clock's
// next look adds nothing). App delivery decides whether to deploy it: not
// beside a deploy, not a commit whose image runs as root, a failed commit
// only after its retry's wait (tests/workflow-app-delivery-postgres.test.js
// D1-D5). The admin's "Check for updates" tells it by hand, which deploys
// without those waits.
//
// Run with: node --test tests/main-drift-poller.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  github: require.resolve('../src/services/github'),
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
  getReadOctokit: async () => readClient,
  isEnabled: () => true,
});
// The workflow: what app delivery was told (and what it answers), the merge
// queue's asks, and the commits the main check was asked about.
const wf = { moved: [], answer: { status: 'accepted' }, wants: [], checks: [], checkFails: false };
stub(ids.platform, {
  reportMainMoved: async (appId, sha, o) => { wf.moved.push([appId, sha, !!o?.byHand]); return wf.answer; },
  wantMerge: async (p) => { wf.wants.push(p); },
  requestMainCheck: async (c) => {
    if (wf.checkFails) throw new Error('The workflow runtime is not running in this process');
    wf.checks.push(c);
  },
});

const queries = [];
let rows = [];
const pool = {
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/FROM apps\s+WHERE repo_url IS NOT NULL AND status = 'running'/.test(String(sql))) return { rows };
    return { rows: [], rowCount: 1 };
  },
};

const poller = require('../src/services/main-drift-poller');

const RED = 'e7ab4060ee62bea30536db98af7a06aff33554e9';
const RUNNING = 'de34dda111111111111111111111111111111111';
const app = { id: 8, slug: 'falling-sands', repo_url: 'https://github.com/example/falling-sands', main_sha: RUNNING };
const config = {};

function reset() {
  poller._forTest.resetHeadCache();
  queries.length = 0;
  remoteSha = RED;
  fetchError = null;
  wf.moved.length = 0;
  wf.wants.length = 0;
  wf.checks.length = 0;
  wf.checkFails = false;
  wf.answer = { status: 'accepted' };
}

test('drift tells app delivery the commit, keyed by it, and the merge queue looks once per commit', async () => {
  reset();
  const out = await poller.checkOne(config, pool, app);
  assert.deepEqual(wf.moved, [[8, RED, false]]);
  assert.equal(out.status, 'deploy_requested');
  assert.deepEqual(wf.wants, [{ appId: 8, reason: 'drift', requestKey: `want:drift:8:${RED}` }]);
});

test('what app delivery decided is what the check reports; the merge queue is told only of an accepted drift', async () => {
  reset();
  wf.answer = { status: 'rejected', reason: 'waits_for_new_commit' };
  const out = await poller.checkOne(config, pool, app);
  assert.equal(out.status, 'waits_for_new_commit');
  assert.deepEqual(wf.wants, []);
});

test('the admin\'s check tells it by hand', async () => {
  reset();
  await poller.checkByHand(config, pool, app);
  assert.deepEqual(wf.moved, [[8, RED, true]]);
});

test('a new main is the main-check machine\'s to check, once per commit; an ask that fails holds nothing up', async () => {
  reset();
  await poller.checkOne(config, pool, app);
  assert.deepEqual(wf.checks, [{ appId: 8, sha: RED }]);
  wf.checks.length = 0;
  await poller.checkOne(config, pool, { ...app, main_check_sha: RED, main_check_state: 'passing' });
  assert.deepEqual(wf.checks, [], 'checked already');
  await poller.checkOne(config, pool, { ...app, main_check_sha: RED, main_check_state: 'error' });
  assert.deepEqual(wf.checks, [{ appId: 8, sha: RED }], 'a check that errored is asked again');
  wf.checkFails = true;
  assert.equal((await poller.checkOne(config, pool, app)).status, 'deploy_requested');
});

test('fetch failures, no drift and first-seen backfills tell app delivery nothing', async () => {
  reset();
  fetchError = Object.assign(new Error('Bad credentials'), { status: 401 });
  assert.equal((await poller.checkOne(config, pool, app)).status, 'fetch_failed');
  fetchError = null;
  remoteSha = RUNNING;
  assert.equal((await poller.checkOne(config, pool, app)).status, 'no_drift');
  remoteSha = RED;
  const firstSeen = await poller.checkOne(config, pool, { ...app, main_sha: null });
  assert.equal(firstSeen.status, 'first_seen');
  assert.ok(queries.some((q) => /UPDATE apps SET main_sha = \$1 WHERE id = \$2 AND main_sha IS NULL/.test(q.sql)));
  assert.deepEqual(wf.moved, []);
});

test('the clock\'s look reads every running app with a repository, one after another, and stops when asked', async () => {
  reset();
  process.env.GITHUB_BOT_TOKEN = process.env.GITHUB_BOT_TOKEN || 'test-token';
  rows = [app, { ...app, id: 9, slug: 'second', repo_url: 'https://github.com/example/second' }];
  const out = await poller.scan(config, pool);
  assert.equal(out.checked, 2);
  assert.deepEqual(out.reported.map((r) => r.slug), ['falling-sands', 'second']);
  const stopped = await poller.scan(config, pool, { shouldStop: () => true });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.checked, 0);
});

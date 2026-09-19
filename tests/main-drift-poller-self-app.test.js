// The drift poller and the platform's own row.
//
// For a child app, main ahead of apps.main_sha means "rebuild it here". For
// the self-hosted row it means "merged, not released": main_sha is the build
// that is serving (seedSelfApp writes GIT_SHA at boot) and the release comes
// from the repository's Actions workflow through Argo CD, never from
// rebuildProduction — which on this row can only fail, and did, every tick,
// during the #2589 gap ("missing required secrets"). So the poller hands that
// row's drift to services/release-watch.js, with the head's date and subject
// so a stall can be dated from the merge and name its PR, and hands its
// convergence there too so a recorded stall is closed out.
//
// Run with: node --test tests/main-drift-poller-self-app.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  github: require.resolve('../src/services/github'),
  staging: require.resolve('../src/services/staging'),
  ws: require.resolve('../src/services/ws'),
  conflictResolver: require.resolve('../src/services/conflict-resolver'),
  releaseWatch: require.resolve('../src/services/release-watch'),
};

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
stub(ids.pool, { getPool: () => pool });

const MERGED = '7817d05e0169594c5ad3affea1afd5af51521a5c';
const RUNNING = '741b8f75b9ce10a3c10cb60f4a0f72e5c48bd24c';
const COMMITTED_AT = '2026-09-19T18:26:31Z';
const SUBJECT = 'Model picker: say what each model is good for and what it costs (#2589)\n\nbody';

let remoteSha = MERGED;
let branchShape = 'full';
const octokit = {
  rest: { repos: { getBranch: async ({ owner, repo, branch }) => {
    assert.equal(branch, 'main');
    assert.equal(`${owner}/${repo}`, 'Usernode-Labs/social-vibecoding');
    if (branchShape === 'bare') return { data: { commit: { sha: remoteSha } } };
    return { data: { commit: {
      sha: remoteSha,
      commit: { message: SUBJECT, committer: { date: COMMITTED_AT }, author: { date: '2026-09-19T18:20:00Z' } },
    } } };
  } } },
};
stub(ids.github, {
  parseGithubUrl: (url) => {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  getOctokit: async () => octokit,
  isEnabled: () => true,
});

const rebuilds = [];
stub(ids.staging, {
  rebuildProduction: async (config, app) => { rebuilds.push(app.slug); return { containerId: 'c-1', sha: remoteSha }; },
  MissingSecretsError: class extends Error {},
});
stub(ids.ws, { broadcastGlobal: () => {} });
stub(ids.conflictResolver, { checkAndResolveConflicts: async () => {} });

const observed = [];
const converged = [];
stub(ids.releaseWatch, {
  observe: async (config, pool, app, head, opts) => {
    observed.push({ app, head, opts });
    return { status: 'release_pending', slug: app.slug, sha: head.sha, running: app.main_sha };
  },
  converged: async (config, pool, app) => { converged.push(app); return { cleared: !!app.release_stall }; },
});

const queries = [];
let pollRows = [];
const pool = {
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    if (/FROM apps\s+WHERE repo_url IS NOT NULL AND status = 'running'/.test(String(sql))) return { rows: pollRows };
    return { rows: [], rowCount: 1 };
  },
};

const poller = require('../src/services/main-drift-poller');

const SELF = {
  id: 1, slug: 'usernode-2d5619', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
  main_sha: RUNNING, self_hosted: true, release_stall: null,
};
const CHILD = {
  id: 8, slug: 'echo', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
  main_sha: RUNNING, self_hosted: false, release_stall: null,
};

function reset() {
  poller._forTest.resetBackoff();
  rebuilds.length = 0; observed.length = 0; converged.length = 0; queries.length = 0;
  remoteSha = MERGED; branchShape = 'full'; pollRows = [];
}

test('the self-hosted row ahead on main goes to the release watch, not to a rebuild', async () => {
  reset();
  const result = await poller.checkAndRedeployOne({}, pool, SELF);
  assert.equal(result.status, 'release_pending');
  assert.equal(result.sha, MERGED);
  assert.equal(result.running, RUNNING);
  assert.equal(rebuilds.length, 0, 'rebuildProduction is never called for the platform itself');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].app, SELF);
  assert.deepEqual({ ...observed[0].head, octokit: undefined }, {
    sha: MERGED, committedAt: COMMITTED_AT, subject: SUBJECT, octokit: undefined,
  }, 'the head carries when main moved and what the commit says');
  assert.equal(observed[0].opts.octokit, octokit, 'the same client, so the watch can read the workflow run');
  assert.equal(queries.filter((q) => /UPDATE apps/.test(q.sql)).length, 0, 'main_sha is not touched: it is the running build');
});

test('the self-hosted row at main closes out a recorded stall', async () => {
  reset();
  remoteSha = RUNNING;
  const record = { sha: RUNNING, kind: 'workflow_failed', prNumber: 2589 };
  const result = await poller.checkAndRedeployOne({}, pool, { ...SELF, release_stall: record });
  assert.equal(result.status, 'no_drift');
  assert.equal(converged.length, 1);
  assert.equal(converged[0].release_stall, record);
  assert.equal(observed.length, 0);
});

test('a child app at the same drift is rebuilt as before, and never consults the watch', async () => {
  reset();
  const result = await poller.checkAndRedeployOne({}, pool, CHILD);
  assert.equal(result.status, 'redeployed');
  assert.deepEqual(rebuilds, ['echo']);
  assert.equal(observed.length, 0);
  remoteSha = RUNNING;
  assert.equal((await poller.checkAndRedeployOne({}, pool, CHILD)).status, 'no_drift');
  assert.equal(converged.length, 0, 'a child app has no release to watch');
});

test('a branch response without commit details still yields the sha; the rest is null', async () => {
  reset();
  branchShape = 'bare';
  const result = await poller.checkAndRedeployOne({}, pool, SELF);
  assert.equal(result.status, 'release_pending');
  assert.equal(observed[0].head.sha, MERGED);
  assert.equal(observed[0].head.committedAt, null);
  assert.equal(observed[0].head.subject, null);
});

test('the poll reads self_hosted and release_stall so the watch has what it needs', async () => {
  reset();
  pollRows = [SELF, CHILD];
  await poller.poll({});
  const select = queries.find((q) => /FROM apps\s+WHERE repo_url IS NOT NULL/.test(q.sql));
  assert.match(select.sql, /SELECT id, slug, repo_url, main_sha, self_hosted, release_stall/);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].app.slug, 'usernode-2d5619');
  assert.deepEqual(rebuilds, ['echo']);
});

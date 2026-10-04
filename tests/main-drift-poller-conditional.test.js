'use strict';

// The drift poller reads main conditionally and gives way to people's work.
//
// It read every running app's main every five minutes: 12 requests an app an
// hour against the bot token's 5,000, the whole budget at about 400 apps, and
// services/merge-followup-recovery.js read it again every four minutes for
// every app with a merged proposal. Now the read sends If-None-Match with the
// last ETag for the repo. An unchanged main answers 304, which GitHub does
// not count, and Octokit reports as a thrown RequestError; the poller answers
// from the cached body in the same shape. And while the hourly budget is
// nearly used up (services/github-budget.js) a pass is held.
//
// Run with: node --test tests/main-drift-poller-conditional.test.js

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
  mainWatch: require.resolve('../src/services/main-watch'),
};

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
stub(ids.pool, { getPool: () => pool });

const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const COMMITTED_AT = '2026-10-04T14:00:00Z';
const SUBJECT = 'Say what the budget is (#3820)';

// GitHub, as far as getBranch goes: an ETag per tip, and a 304 thrown the
// way Octokit throws it when If-None-Match still matches.
let tip = SHA;
const branchCalls = [];
function notModified() {
  const err = new Error('Not modified');
  err.status = 304;
  err.response = { status: 304, headers: { etag: `W/"${tip}"` }, data: '' };
  return err;
}
const octokit = {
  rest: { repos: { getBranch: async (params) => {
    branchCalls.push(params);
    const sent = params.headers && params.headers['if-none-match'];
    if (sent === `W/"${tip}"`) throw notModified();
    return {
      status: 200,
      headers: { etag: `W/"${tip}"` },
      data: { commit: { sha: tip, commit: { message: SUBJECT, committer: { date: COMMITTED_AT } } } },
    };
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
  rebuildProduction: async (config, app) => { rebuilds.push(app.slug); return { containerId: 'c-1', sha: tip }; },
  MissingSecretsError: class extends Error {},
});
stub(ids.ws, { broadcastGlobal: () => {} });
stub(ids.conflictResolver, { checkAndResolveConflicts: async () => {} });
const observed = [];
stub(ids.releaseWatch, {
  observe: async (config, pool, app, head) => {
    observed.push(head);
    return { status: 'release_pending', slug: app.slug, sha: head.sha };
  },
  converged: async () => ({ cleared: false }),
});
stub(ids.mainWatch, { afterMerge: async () => {} });

let pollRows = [];
const pool = {
  query: async (sql) => {
    if (/FROM apps\s+WHERE repo_url IS NOT NULL AND status = 'running'/.test(String(sql))) return { rows: pollRows };
    return { rows: [], rowCount: 1 };
  },
};

const budget = require('../src/services/github-budget');
const poller = require('../src/services/main-drift-poller');
const recovery = require('../src/services/merge-followup-recovery');

const APP = { id: 5, slug: 'demo', repo_url: 'https://github.com/usernode-bot/demo', main_sha: SHA, self_hosted: false };

test.beforeEach(() => {
  tip = SHA;
  branchCalls.length = 0;
  rebuilds.length = 0;
  observed.length = 0;
  poller._forTest.resetHeadCache();
  poller._forTest.resetBackoff();
  budget._resetForTests();
});

test('the second read is conditional, and a 304 answers unchanged with no rebuild and no extra call', async () => {
  const first = await poller.checkAndRedeployOne({}, pool, { ...APP });
  assert.equal(first.status, 'no_drift');
  assert.equal(branchCalls.length, 1);
  assert.equal(branchCalls[0].headers, undefined, 'nothing to be conditional on yet');

  const second = await poller.checkAndRedeployOne({}, pool, { ...APP });
  assert.equal(second.status, 'no_drift');
  assert.equal(branchCalls.length, 2, 'one call per check, the 304 included');
  assert.deepEqual(branchCalls[1].headers, { 'if-none-match': `W/"${SHA}"` });
  assert.equal(rebuilds.length, 0);
});

test('fetchRemoteHead keeps its shape on a 304, with the cached date and subject', async () => {
  const fresh = await poller.fetchRemoteHead('usernode-bot', 'demo');
  assert.deepEqual({ ...fresh, octokit: undefined },
    { sha: SHA, committedAt: COMMITTED_AT, subject: SUBJECT, octokit: undefined });
  const cached = await poller.fetchRemoteHead('usernode-bot', 'demo');
  assert.equal(cached.sha, SHA);
  assert.equal(cached.committedAt, COMMITTED_AT, 'the self-hosted row still dates its merge');
  assert.equal(cached.subject, SUBJECT, 'and still names its PR');
  assert.equal(cached.octokit, octokit, 'release-watch still gets a client');
  assert.equal(cached.notModified, true);
});

test('the self-hosted row hands release-watch the cached head on a 304', async () => {
  const self = { ...APP, id: 1, slug: 'homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', main_sha: 'c'.repeat(40), self_hosted: true };
  await poller.checkAndRedeployOne({}, pool, self);
  await poller.checkAndRedeployOne({}, pool, self);
  assert.equal(observed.length, 2);
  assert.equal(observed[1].sha, SHA);
  assert.equal(observed[1].committedAt, COMMITTED_AT);
  assert.equal(observed[1].subject, SUBJECT);
});

test('a moved main is a 200 with the new tip, and is rebuilt', async () => {
  await poller.checkAndRedeployOne({}, pool, { ...APP });
  tip = NEWER;
  const out = await poller.checkAndRedeployOne({}, pool, { ...APP });
  assert.equal(out.status, 'redeployed');
  assert.deepEqual(rebuilds, ['demo']);
  const third = await poller.fetchRemoteHead('usernode-bot', 'demo');
  assert.equal(third.notModified, true, 'and the new ETag is the one sent next');
  assert.equal(third.sha, NEWER);
});

test('a 304 for a repo with nothing cached is still an error, never a guess', async () => {
  const bare = {
    rest: { repos: { getBranch: async () => { throw notModified(); } } },
  };
  const github = require(ids.github);
  const prior = github.getOctokit;
  github.getOctokit = async () => bare;
  try {
    await assert.rejects(poller.fetchRemoteHead('usernode-bot', 'never-read'), (err) => err.status === 304);
  } finally {
    github.getOctokit = prior;
  }
});

test('a pass is held while the budget is under the reserve, and the admin check is not', async (t) => {
  const prior = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-token';
  t.after(() => {
    if (prior === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = prior;
  });
  pollRows = [{ ...APP }, { ...APP, id: 6, slug: 'other', repo_url: 'https://github.com/usernode-bot/other' }];
  budget.record('pat', {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '400',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
  });
  const held = await poller.poll({});
  assert.deepEqual(held, { apps: 2, checked: 0, held: true });
  assert.equal(branchCalls.length, 0, 'not one read while held');

  const manual = await poller.checkAndRedeployOne({}, pool, { ...APP }, { manual: true });
  assert.equal(manual.status, 'no_drift', '"Check for updates" is a person asking');
  assert.equal(branchCalls.length, 1);

  budget._resetForTests();
  const free = await poller.poll({});
  assert.deepEqual(free, { apps: 2, checked: 2, held: false });
});

test('merge follow-up recovery reads main through the same ETag, and is held too', async () => {
  const row = {
    ...APP, session_id: 42, pr_number: 7, merge_commit_sha: SHA,
    main_check_sha: SHA, main_check_state: 'passing',
  };
  const recPool = {
    async query(sql) {
      if (/WITH latest AS/.test(sql)) return { rows: [row] };
      return { rows: [], rowCount: 1 };
    },
  };
  await poller.checkAndRedeployOne({}, pool, { ...APP });
  const out = await recovery.recover({}, { pool: recPool, enabled: () => true });
  await out.done;
  assert.equal(out.held, false);
  assert.equal(branchCalls.length, 2);
  assert.deepEqual(branchCalls[1].headers, { 'if-none-match': `W/"${SHA}"` },
    'the sweep\'s read is the poller\'s conditional one: a 304 that costs nothing');

  const held = await recovery.recover({}, { pool: recPool, enabled: () => true, allowed: () => false });
  await held.done;
  assert.equal(held.held, true);
  assert.equal(branchCalls.length, 2, 'not one read while held');
});

// #5743: a test copy (a staging preview, or a developer's own machine) has no
// GitHub credentials, so POST /api/feedback files the request locally under an
// obviously fake number and answers the way a real filing does — that is what
// puts the thanks sheet, and everything after it, within reach of the before &
// after shots. Production, and any server that does not say it is a test copy,
// files a real request: since GitHub suspended the filing account (26 Oct
// 2026) that is a request row on Homeroom's own board (github.createIssue,
// services/requests.js), which needs no token, so the old 503 is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const app = {
  id: 3, slug: 'demo-app', name: 'Demo', repo_url: 'https://github.com/owner/demo',
  created_by: 1, self_hosted: false, view_visibility: 'public', collab_visibility: 'public',
};
const platform = { ...app, id: 1, slug: 'platform-app', repo_url: 'https://github.com/platform/repo', self_hosted: true };

let user;
let queries;
let receipts;
let createIssueCalls;
let githubEnabled;
let platformIssueCalls;

require('../src/db/pool').getPool = () => ({
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/COALESCE\(MAX\(issue_number\)/.test(sql)) {
      const max = receipts.reduce((m, r) => (r.issue_number > m ? r.issue_number : m), 970000);
      return { rows: [{ next: String(max + 1) }] };
    }
    if (/INSERT INTO feedback_reports/.test(sql)) {
      const id = receipts.length + 1;
      receipts.push({ id, user_id: params[0], issue_owner: params[3], issue_repo: params[4],
        issue_number: params[5], title: params[6], description: params[7], source: null,
        edit_version: 0, has_body: true, seconds_left: 300 });
      return { rows: [{ id }] };
    }
    if (/FROM feedback_reports fr/.test(sql)) {
      return { rows: receipts.filter((r) => r.id === params[0] && r.user_id === params[1]) };
    }
    if (/FROM apps WHERE slug = \$1/.test(sql)) return { rows: params[0] === app.slug ? [app] : [] };
    if (/FROM apps/.test(sql)) return { rows: [app, platform] };
    return { rows: [] };
  },
});

const llm = require('../src/services/llm');
// No model is reachable from a route test: the filing falls back to the
// template title, which is exactly the state that queues a title heal — the
// queue row test copies must NOT write.
llm.generateIssueTitle = async () => { throw new Error('no model'); };

const github = require('../src/services/github');
github.isEnabled = () => githubEnabled;
github.noteIssueCreated = () => {};
github.createIssue = async (owner, repo) => {
  createIssueCalls.push({ owner, repo });
  return { number: 41, html_url: `https://github.com/${owner}/${repo}/issues/41` };
};

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: { pushIssueUpdate() {} } };

const realFetch = global.fetch;
// Anything that reaches api.github.com from the route is a failure of the
// change's central promise: a test copy never talks to GitHub.
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.github.com/')) {
    platformIssueCalls.push(String(url));
    return { ok: true, status: 201, text: async () => '', json: async () => ({ number: 41, html_url: 'https://github.com/platform/repo/issues/41' }) };
  }
  return realFetch(url, opts);
};

const { feedbackRoutes } = require('../src/routes/feedback');
const { feedbackSubmitLimiter } = require('../src/middleware/rate-limits');

const ENV_KEYS = ['GITHUB_BOT_TOKEN', 'USERNODE_ENV', 'USERNODE_LOCAL_DEV', 'NODE_ENV'];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

let server;
test.before(async () => {
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use((req, _res, next) => { req.user = user; next(); });
  serverApp.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/platform/repo' }));
  server = await new Promise((resolve) => {
    const listener = serverApp.listen(0, () => resolve(listener));
  });
});

test.after(() => {
  server.close();
  global.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test.beforeEach(() => {
  feedbackSubmitLimiter.resetKey('user:7');
  user = { id: 7, username: 'reporter' };
  queries = [];
  receipts = [];
  createIssueCalls = [];
  platformIssueCalls = [];
  githubEnabled = true;
  for (const key of ENV_KEYS) delete process.env[key];
});

function stagingCopy() {
  process.env.USERNODE_ENV = 'staging';
  delete process.env.GITHUB_BOT_TOKEN;
}

async function submit(overrides = {}) {
  const response = await realFetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'The board jumps when scrolling.', title: 'Board jumps', ...overrides }),
  });
  return { status: response.status, data: await response.json() };
}

test('a staging copy with no token files the request locally, under a fake number', async () => {
  stagingCopy();
  // No title: the model is unreachable here, so the filing falls back to the
  // template title — the state that queues a title heal for a real filing.
  const { status, data } = await submit({ title: undefined });
  assert.equal(status, 200);
  assert.equal(data.url, 'https://github.com/platform/repo/issues/970001');
  assert.equal(platformIssueCalls.length, 0, 'nothing may reach GitHub from a test copy');
  const receipt = queries.find((q) => /INSERT INTO feedback_reports/.test(q.sql));
  assert.ok(receipt, 'the receipt is written');
  assert.equal(receipt.params[5], 970001);
  assert.equal(queries.filter((q) => /INSERT INTO title_heal_queue/.test(q.sql)).length, 0,
    'a test filing queues no title heal, which would PATCH GitHub');
  assert.equal(data.titleFallback, true);
});

test('a second test filing on the same copy takes the next fake number', async () => {
  stagingCopy();
  assert.equal((await submit()).data.url, 'https://github.com/platform/repo/issues/970001');
  const second = await submit();
  assert.equal(second.status, 200);
  assert.equal(second.data.url, 'https://github.com/platform/repo/issues/970002');
  assert.equal(platformIssueCalls.length, 0);
});

test('a staging copy files app-targeted feedback locally when the GitHub app is off', async () => {
  stagingCopy();
  githubEnabled = false;
  const { status, data } = await submit({ target: 'app', appSlug: 'demo-app' });
  assert.equal(status, 200);
  assert.equal(createIssueCalls.length, 0, 'the GitHub App is never asked');
  assert.equal(data.url, 'https://github.com/owner/demo/issues/970001');
  assert.ok(data.edit, 'the thanks sheet’s Edit action is offered');
});

test('local development without a token behaves like a test copy', async () => {
  process.env.USERNODE_LOCAL_DEV = '1';
  process.env.NODE_ENV = 'development';
  const { status, data } = await submit();
  assert.equal(status, 200);
  assert.equal(data.url, 'https://github.com/platform/repo/issues/970001');
  assert.equal(platformIssueCalls.length, 0);
});

test('a staging copy that does have a token files for real', async () => {
  process.env.USERNODE_ENV = 'staging';
  process.env.GITHUB_BOT_TOKEN = 'test-token';
  const { status, data } = await submit({ title: undefined });
  assert.equal(status, 200);
  assert.deepEqual(createIssueCalls, [{ owner: 'platform', repo: 'repo' }], 'a request row on the platform board');
  assert.equal(platformIssueCalls.length, 0, 'filing no longer reaches GitHub');
  assert.equal(data.url, 'https://github.com/platform/repo/issues/41');
  assert.equal(queries.filter((q) => /INSERT INTO title_heal_queue/.test(q.sql)).length, 1);
});

// Production with no token used to answer 503 'GitHub token not configured'.
// A request is a row now and needs no token: it files for real, never under
// a fake number.
test('production with no token files the request natively', async () => {
  process.env.USERNODE_ENV = 'production';
  const { status, data } = await submit();
  assert.equal(status, 200);
  assert.deepEqual(createIssueCalls, [{ owner: 'platform', repo: 'repo' }]);
  assert.equal(data.url, 'https://github.com/platform/repo/issues/41');
  assert.equal(platformIssueCalls.length, 0);
});

test('a server that does not say it is a test copy files for real, never under a fake number', async () => {
  const { status, data } = await submit();
  assert.equal(status, 200);
  assert.equal(data.url, 'https://github.com/platform/repo/issues/41');
  assert.equal(createIssueCalls.length, 1);
  assert.equal(platformIssueCalls.length, 0);

  process.env.NODE_ENV = 'production';
  process.env.USERNODE_LOCAL_DEV = '1';
  const prod = await submit();
  assert.equal(prod.status, 200);
  assert.equal(prod.data.url, 'https://github.com/platform/repo/issues/41', 'NODE_ENV=production is never a test copy');
  assert.equal(createIssueCalls.length, 2);
});

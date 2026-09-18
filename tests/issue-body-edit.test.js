// Tests for PATCH /api/apps/:slug/github-issues/:number/body (#2427) —
// author-only Markdown body editing from an issue topic.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let poolQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    poolQueries.push({ sql: String(sql), params });
    return poolQueryHandler(String(sql), params);
  },
});

const kudos = require('../src/routes/kudos');
kudos.countWeeklyAllowanceUsed = async () => 0;

const ws = require('../src/services/ws');
let systemMessages = [];
ws.sendSystemMessage = async (pool, appId, content, msgType, metadata, thread) => {
  systemMessages.push({ appId, content, msgType, thread });
};
let issueUpdates = [];
ws.pushIssueUpdate = (detail) => issueUpdates.push(detail);

const github = require('../src/services/github');
github.isEnabled = () => true;
let ghIssuesResult = null;
github.fetchPublicIssues = async () => ghIssuesResult;
let patchCalls = [];
let patchShouldFail = false;
github.patchIssueBody = async (owner, repo, number, body) => {
  if (patchShouldFail) throw new Error('boom');
  patchCalls.push({ owner, repo, number, body });
};
let cacheInvalidations = [];
github.invalidateIssuesCache = (owner, repo) => cacheInvalidations.push(`${owner}/${repo}`);

const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async () => ({
  id: 1, slug: 'demo', repo_url: 'https://github.com/o/r',
});

const { issueRoutes } = require('../src/routes/issues');
const express = require('express');

function defaultGhIssues() {
  return {
    issues: [
      {
        number: 12, title: 'Editable issue',
        body: '**Source:** usernode user (tester)\n\nOld description',
        htmlUrl: 'https://github.com/o/r/issues/12', user: 'usernode-bot',
      },
      {
        number: 13, title: 'Native issue', body: 'Filed directly on GitHub.',
        htmlUrl: 'https://github.com/o/r/issues/13', user: 'stranger',
      },
    ],
    truncatedList: false,
  };
}

beforeEach(() => {
  poolQueryHandler = async () => ({ rows: [] });
  poolQueries = [];
  systemMessages = [];
  issueUpdates = [];
  patchCalls = [];
  patchShouldFail = false;
  cacheInvalidations = [];
  ghIssuesResult = defaultGhIssues();
});

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(issueRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function patchBody(server, number, body) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/${number}/body`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

test('author edits the GitHub body, local mirror, issue thread and live viewers', async () => {
  const server = await startServer();
  try {
    const next = '**Source:** usernode user (tester)\n\nA clearer description.';
    const res = await patchBody(server, 12, next);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, body: next });
    assert.deepEqual(patchCalls, [{ owner: 'o', repo: 'r', number: 12, body: next }]);

    const update = poolQueries.find((query) => /UPDATE issues SET description/.test(query.sql));
    assert.ok(update, 'local issue mirror updated');
    assert.deepEqual(update.params, [1, 12, next]);
    assert.deepEqual(systemMessages, [{
      appId: 1,
      content: 'tester edited the issue description',
      msgType: 'system',
      thread: { type: 'issue', ref: 12 },
    }]);
    assert.deepEqual(cacheInvalidations, ['o/r']);
    assert.equal(issueUpdates.length, 1);
    assert.equal(issueUpdates[0].issueNumber, 12);
    assert.equal(issueUpdates[0].action, 'updated');
  } finally {
    server.close();
  }
});

test('author via a local issue row may edit without a Source line', async () => {
  poolQueryHandler = async (sql) => (/SELECT 1 FROM issues/.test(sql)
    ? { rows: [{ '?column?': 1 }] }
    : { rows: [] });
  const server = await startServer();
  try {
    const res = await patchBody(server, 13, 'Updated native-looking body');
    assert.equal(res.status, 200);
    assert.equal(patchCalls.length, 1);
  } finally {
    server.close();
  }
});

test('feedback author may edit again after clearing the Source line', async () => {
  poolQueryHandler = async (sql) => (/SELECT 1 FROM feedback_reports/.test(sql)
    ? { rows: [{ '?column?': 1 }] }
    : { rows: [] });
  const native = defaultGhIssues().issues[1];
  native.body = '';
  ghIssuesResult = { issues: [native], truncatedList: false };
  const server = await startServer();
  try {
    const res = await patchBody(server, 13, 'A new description after clearing it.');
    assert.equal(res.status, 200);
    assert.equal(patchCalls.length, 1);
  } finally {
    server.close();
  }
});

test('non-author collaborator gets 403 with no side effects', async () => {
  const server = await startServer();
  try {
    const res = await patchBody(server, 13, 'Hijacked body');
    assert.equal(res.status, 403);
    assert.equal(patchCalls.length, 0);
    assert.equal(systemMessages.length, 0);
    assert.ok(!poolQueries.some((query) => /UPDATE issues SET description/.test(query.sql)));
  } finally {
    server.close();
  }
});

test('unknown or closed issue number is refused', async () => {
  const server = await startServer();
  try {
    const res = await patchBody(server, 999, 'Whatever');
    assert.equal(res.status, 404);
    assert.equal(patchCalls.length, 0);
  } finally {
    server.close();
  }
});

test('a degraded open-issues read is refused without writing', async () => {
  ghIssuesResult = { issues: [], truncatedList: false, note: 'rate limited' };
  const server = await startServer();
  try {
    const res = await patchBody(server, 12, 'Whatever');
    assert.equal(res.status, 422);
    assert.equal(patchCalls.length, 0);
  } finally {
    server.close();
  }
});

test('unchanged and empty bodies are both valid', async () => {
  const server = await startServer();
  try {
    let res = await patchBody(server, 12, defaultGhIssues().issues[0].body);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unchanged, true);
    assert.equal(patchCalls.length, 0);

    res = await patchBody(server, 12, '');
    assert.equal(res.status, 200);
    assert.deepEqual(patchCalls, [{ owner: 'o', repo: 'r', number: 12, body: '' }]);
  } finally {
    server.close();
  }
});

test('non-string and over-long bodies are rejected before GitHub', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    let res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/12/body`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: null }),
    });
    assert.equal(res.status, 400);
    res = await patchBody(server, 12, 'x'.repeat(10001));
    assert.equal(res.status, 400);
    assert.equal(patchCalls.length, 0);
  } finally {
    server.close();
  }
});

test('GitHub failure leaves local state and the issue thread untouched', async () => {
  patchShouldFail = true;
  const server = await startServer();
  try {
    const res = await patchBody(server, 12, 'New body');
    assert.equal(res.status, 502);
    assert.equal(systemMessages.length, 0);
    assert.equal(issueUpdates.length, 0);
    assert.ok(!poolQueries.some((query) => /UPDATE issues SET description/.test(query.sql)));
  } finally {
    server.close();
  }
});

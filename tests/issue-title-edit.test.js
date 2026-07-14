// Tests for PATCH /api/apps/:slug/github-issues/:number/title (#556) —
// the author-only issue rename route.
//
//  - 200 for the author (via the local issues row OR the body Source line),
//    with the GitHub PATCH issued, the local mirror updated, the pending
//    title_heal_queue row deleted, a system message recorded in the
//    issue's thread carrying both titles, and an issue_update broadcast.
//  - 403 for a non-author collaborator (no side effects).
//  - 404 for a number that isn't an open issue; 422 on a degraded fetch.
//  - unchanged title → 200 { unchanged: true }, no side effects.
//  - GitHub PATCH failure → 502 with no local mutation and no message.
//
// Run with: node --test tests/issue-title-edit.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Override collaborators BEFORE requiring the route module: issues.js
// destructures sendSystemMessage / pushIssueUpdate from services/ws and
// getPool from db/pool at require time.
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
ws.pushIssueUpdate = (d) => issueUpdates.push(d);

const github = require('../src/services/github');
github.isEnabled = () => true;
// The open-issues snapshot the route verifies against. Issue #12 is
// feedback-filed by "tester" (Source line); #13 has no resolvable
// platform creator (GitHub-native).
let ghIssuesResult = null;
github.fetchPublicIssues = async () => ghIssuesResult;
let patchCalls = [];
let patchShouldFail = false;
github.patchIssueTitle = async (owner, repo, n, title) => {
  if (patchShouldFail) throw new Error('boom');
  patchCalls.push({ owner, repo, n, title });
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
        number: 12, title: 'Old title',
        body: '**Source:** usernode user (tester)\n\nSomething broke',
        htmlUrl: 'https://github.com/o/r/issues/12', user: 'usernode-bot',
      },
      {
        number: 13, title: 'Native issue',
        body: 'Filed directly on GitHub.',
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

async function patchTitle(server, number, title) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/${number}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

test('author via Source line: renames on GitHub, cleans up, records the old and new title in the issue thread', async () => {
  const server = await startServer();
  try {
    const res = await patchTitle(server, 12, 'New sharper title');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, title: 'New sharper title' });

    assert.deepEqual(patchCalls, [{ owner: 'o', repo: 'r', n: 12, title: 'New sharper title' }]);
    const upd = poolQueries.find((q) => /UPDATE issues SET title/.test(q.sql));
    assert.ok(upd, 'local issues mirror updated');
    assert.deepEqual(upd.params, [1, 12, 'New sharper title']);
    const del = poolQueries.find((q) => /DELETE FROM title_heal_queue/.test(q.sql));
    assert.ok(del, 'pending heal row deleted');
    assert.deepEqual(del.params, ['o', 'r', 12]);

    assert.equal(systemMessages.length, 1);
    assert.equal(systemMessages[0].msgType, 'system');
    assert.deepEqual(systemMessages[0].thread, { type: 'issue', ref: 12 });
    assert.ok(systemMessages[0].content.includes('"Old title"'), 'message carries the old title');
    assert.ok(systemMessages[0].content.includes('"New sharper title"'), 'message carries the new title');
    assert.ok(systemMessages[0].content.includes('tester'), 'message names the renamer');

    assert.deepEqual(cacheInvalidations, ['o/r']);
    assert.equal(issueUpdates.length, 1);
    assert.equal(issueUpdates[0].action, 'updated');
    assert.equal(issueUpdates[0].issueNumber, 12);
  } finally {
    server.close();
  }
});

test('author via local issues row: rename allowed even without a matching Source line', async () => {
  poolQueryHandler = async (sql) => {
    if (/SELECT 1 FROM issues/.test(sql)) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await patchTitle(server, 13, 'Renamed by platform author');
    assert.equal(res.status, 200);
    assert.equal(patchCalls.length, 1);
  } finally {
    server.close();
  }
});

test('non-author collaborator gets 403 and nothing changes', async () => {
  const server = await startServer();
  try {
    const res = await patchTitle(server, 13, 'Hijacked title');
    assert.equal(res.status, 403);
    assert.equal(patchCalls.length, 0);
    assert.equal(systemMessages.length, 0);
    assert.ok(!poolQueries.some((q) => /UPDATE issues SET title/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('unknown / closed issue number → 404', async () => {
  const server = await startServer();
  try {
    const res = await patchTitle(server, 999, 'Whatever');
    assert.equal(res.status, 404);
    assert.equal(patchCalls.length, 0);
  } finally {
    server.close();
  }
});

test('degraded GitHub fetch (note) → 422, nothing changes', async () => {
  ghIssuesResult = { issues: [], truncatedList: false, note: 'rate limited' };
  const server = await startServer();
  try {
    const res = await patchTitle(server, 12, 'Whatever');
    assert.equal(res.status, 422);
    assert.equal(patchCalls.length, 0);
  } finally {
    server.close();
  }
});

test('unchanged title → 200 unchanged, no side effects', async () => {
  const server = await startServer();
  try {
    const res = await patchTitle(server, 12, 'Old title');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.unchanged, true);
    assert.equal(patchCalls.length, 0);
    assert.equal(systemMessages.length, 0);
    assert.ok(!poolQueries.some((q) => /UPDATE issues SET title|DELETE FROM title_heal_queue/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('empty and over-long titles → 400', async () => {
  const server = await startServer();
  try {
    let res = await patchTitle(server, 12, '   ');
    assert.equal(res.status, 400);
    res = await patchTitle(server, 12, 'a'.repeat(201));
    assert.equal(res.status, 400);
    assert.equal(patchCalls.length, 0);
  } finally {
    server.close();
  }
});

test('GitHub PATCH failure → 502 with no local mutation and no message', async () => {
  patchShouldFail = true;
  const server = await startServer();
  try {
    const res = await patchTitle(server, 12, 'New title');
    assert.equal(res.status, 502);
    assert.equal(systemMessages.length, 0);
    assert.equal(issueUpdates.length, 0);
    assert.ok(!poolQueries.some((q) => /UPDATE issues SET title|DELETE FROM title_heal_queue/.test(q.sql)));
  } finally {
    server.close();
  }
});

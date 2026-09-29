// #2327: an author can rename a native proposal while it is Underway or In
// review, without
// handing ownership of imported PRs or settled work to this route.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let candidate = null;
let updateQuery = null;
poolMod.getPool = () => ({
  query: async (sql, params) => {
    const text = String(sql);
    if (/SELECT a\.id, a\.collab_visibility/.test(text)) {
      return { rows: [{ id: 1, collab_visibility: 'public', view_visibility: 'public' }] };
    }
    if (/UPDATE chat_sessions cs/.test(text) && /proposed_pr_title/.test(text)) {
      updateQuery = { sql: text, params };
      const allowed = candidate
        && candidate.user_id === params[2]
        && ['active', 'paused', 'promoted', 'merging'].includes(candidate.status)
        && candidate.is_headless === false
        && candidate.source !== 'imported';
      return { rows: allowed ? [{
        id: candidate.id,
        app_id: 1,
        app_slug: 'demo',
        repo_url: 'https://github.com/Acme/Demo.git',
        pr_number: candidate.pr_number,
        pr_title: candidate.pr_number ? params[0] : candidate.pr_title,
        session_title: params[0],
        proposed_pr_title: params[0],
      }] : [] };
    }
    return { rows: [] };
  },
});

const github = require('../src/services/github');
const ws = require('../src/services/ws');
const originalUpdatePR = github.updatePR;
const originalPushSessionUpdate = ws.pushSessionUpdate;
let githubCalls = [];
let pushes = [];
let githubFailure = null;
github.updatePR = async (...args) => {
  githubCalls.push(args);
  if (githubFailure) throw githubFailure;
};
ws.pushSessionUpdate = (payload) => pushes.push(payload);

after(() => {
  github.updatePR = originalUpdatePR;
  ws.pushSessionUpdate = originalPushSessionUpdate;
});

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');
const OWNER = { id: 7, username: 'builder' };

beforeEach(() => {
  candidate = {
    id: 42,
    user_id: OWNER.id,
    status: 'active',
    is_headless: false,
    source: 'cli_handoff',
    pr_number: null,
    pr_title: null,
  };
  updateQuery = null;
  githubCalls = [];
  pushes = [];
  githubFailure = null;
});

function startServer(user = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function rename(server, title, id = 42) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${id}/title`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return { res, body: await res.json() };
}

test('normalizes and persists a pre-PR title as both display and future PR title', async () => {
  const server = await startServer();
  try {
    const { res, body } = await rename(server, '  A better\n proposal   title  ');
    assert.equal(res.status, 200);
    assert.deepEqual(body, {
      ok: true,
      proposalId: 42,
      title: 'A better proposal title',
      prTitle: null,
      githubUpdated: false,
    });
    assert.deepEqual(updateQuery.params, ['A better proposal title', 42, OWNER.id]);
    assert.match(updateQuery.sql, /session_title = \$1/);
    assert.match(updateQuery.sql, /proposed_pr_title = \$1/);
    assert.match(updateQuery.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/);
    assert.match(updateQuery.sql, /is_headless = FALSE/);
    assert.match(updateQuery.sql, /source IS DISTINCT FROM 'imported'/);
    assert.deepEqual(githubCalls, []);
    assert.deepEqual(pushes, [{
      action: 'titled', sessionId: 42, appId: 1,
      appSlug: 'demo', sessionTitle: 'A better proposal title',
    }]);
  } finally {
    server.close();
  }
});

test('renames an existing managed PR locally and on GitHub', async () => {
  candidate.pr_number = 91;
  candidate.pr_title = 'Old title';
  candidate.status = 'paused';
  const server = await startServer();
  try {
    const { res, body } = await rename(server, 'New title');
    assert.equal(res.status, 200);
    assert.equal(body.prTitle, 'New title');
    assert.equal(body.githubUpdated, true);
    assert.deepEqual(githubCalls, [['acme', 'demo', 91, { title: 'New title' }]]);
    assert.match(updateQuery.sql, /pr_title_fallback = CASE[\s\S]*ELSE FALSE END/);
  } finally {
    server.close();
  }
});

test('keeps the same edit contract while a proposal is in review', async () => {
  candidate.pr_number = 91;
  candidate.pr_title = 'Old title';
  const server = await startServer();
  try {
    for (const status of ['promoted', 'merging']) {
      candidate.status = status;
      const { res, body } = await rename(server, `Title while ${status}`);
      assert.equal(res.status, 200, status);
      assert.equal(body.title, `Title while ${status}`);
    }
    assert.equal(githubCalls.length, 2);
    assert.equal(pushes.length, 2);
  } finally {
    server.close();
  }
});

test('a GitHub outage does not roll back the local rename', async () => {
  candidate.pr_number = 91;
  githubFailure = new Error('offline');
  const server = await startServer();
  try {
    const { res, body } = await rename(server, 'Locally durable');
    assert.equal(res.status, 200);
    assert.equal(body.githubUpdated, false);
    assert.equal(body.title, 'Locally durable');
    assert.equal(pushes.length, 1, 'the successful local change is still broadcast');
  } finally {
    server.close();
  }
});

test('foreign, imported, headless and completed rows all stay non-enumerable', async () => {
  const variants = [
    { user_id: 99 },
    { source: 'imported' },
    { is_headless: true },
    { status: 'merged' },
    { status: 'archived' },
  ];
  const server = await startServer();
  try {
    for (const patch of variants) {
      candidate = { ...candidate, user_id: OWNER.id, source: 'cli_handoff', is_headless: false, status: 'active', ...patch };
      const { res, body } = await rename(server, 'Nope');
      assert.equal(res.status, 404, JSON.stringify(patch));
      assert.equal(body.error, 'Session not found');
    }
    assert.deepEqual(githubCalls, []);
    assert.deepEqual(pushes, []);
  } finally {
    server.close();
  }
});

test('rejects empty and overlong titles before touching the session', async () => {
  const server = await startServer();
  try {
    for (const title of [' \n ', 'x'.repeat(257)]) {
      updateQuery = null;
      const { res } = await rename(server, title);
      assert.equal(res.status, 400);
      assert.equal(updateQuery, null);
    }
  } finally {
    server.close();
  }
});

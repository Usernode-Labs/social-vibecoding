// Route test for POST /api/apps/:slug/sessions (src/routes/sessions.js) —
// the #287 issue link. When the issue row's "Create PR" button starts a
// dev chat it passes the issue number, which is persisted as
// chat_sessions.created_from_issue_number so the row can later swap to
// "Open Session" for that viewer. The generic "+ New chat" path sends no
// body and must store NULL.
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module, capture every query, and assert the
// INSERT's column list + params directly (the persistence is the contract).
//
// Run with: node --test tests/create-session-issue-link.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(sql, params);
  },
});

// No GitHub creds in the test env — skip the branch-create side effect.
const github = require('../src/services/github');
github.isEnabled = () => false;

const events = require('../src/services/events');
events.record = () => {};

const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo', repo_url: null });

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

// Answer the cap-count queries with 0 and the INSERT with a canned row.
function installInsertCapture() {
  let insert = null;
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/INSERT INTO chat_sessions/.test(s)) {
      insert = { sql: s, params };
      return { rows: [{ id: 99, status: 'active', created_from_issue_number: params[3] }] };
    }
    if (/COUNT\(\*\)/.test(s)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  return () => insert;
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('issueNumber is persisted to created_from_issue_number', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueNumber: 287 }),
    });
    assert.strictEqual(res.status, 201);

    const insert = getInsert();
    assert.ok(insert, 'an INSERT was issued');
    assert.match(insert.sql, /created_from_issue_number/);
    assert.strictEqual(insert.params[3], 287);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('no body → created_from_issue_number is NULL', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, { method: 'POST' });
    assert.strictEqual(res.status, 201);

    const insert = getInsert();
    assert.ok(insert, 'an INSERT was issued');
    assert.strictEqual(insert.params[3], null);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('a non-positive / non-integer issueNumber is rejected to NULL', async () => {
  for (const bad of [0, -5, 1.5, 'abc', null]) {
    const getInsert = installInsertCapture();
    const server = await startServer();
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueNumber: bad }),
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(getInsert().params[3], null, `issueNumber=${bad} stores NULL`);
    } finally {
      poolQueryHandler = async () => ({ rows: [] });
      server.close();
    }
  }
});

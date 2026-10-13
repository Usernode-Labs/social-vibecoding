// Route test for POST /api/sessions/:id/fork (src/routes/sessions.js).
//
// Forking someone else's SHARED dev chat into a new classic session of your
// own is retired with classic sessions (#2779): new work starts in an agent
// session. The route stays, so a shell cached before the switch is told why
// instead of getting a 404, and it writes nothing: no session row, no branch,
// no copied transcript. The transcript read reports `can_fork: false`, so no
// current page offers the button (tests/session-transcript-route.test.js).
//
// Same harness shape as tests/shared-sessions.test.js.
//
// Run with: node --test tests/fork-shared-chat.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return Promise.resolve({ rows: [] });
  },
});

const github = require('../src/services/github');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const FORKER = { id: 7, username: 'forker' };

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = FORKER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('#2779: forking a chat is retired: 410, with where new work starts, and nothing written', async () => {
  const realCreateBranch = github.createBranch;
  const branchCalls = [];
  github.createBranch = async (...args) => { branchCalls.push(args); };
  capturedQueries = [];
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/5/fork`, { method: 'POST' });
    const body = await res.json();
    assert.strictEqual(res.status, 410);
    assert.strictEqual(body.code, 'agent_sessions_only');
    assert.match(body.error, /agent session/);
    assert.ok(!capturedQueries.some((q) => /INSERT|UPDATE/.test(String(q.sql))), 'no row is written');
    assert.ok(!capturedQueries.some((q) => /transcript_shared_at IS NOT NULL/.test(String(q.sql))),
      'the source chat is not even looked up');
    assert.strictEqual(branchCalls.length, 0, 'and no branch is created');
  } finally {
    server.close();
    github.createBranch = realCreateBranch;
  }
});

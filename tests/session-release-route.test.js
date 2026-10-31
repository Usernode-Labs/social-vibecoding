// Route test for POST /api/sessions/:id/release (#6068), the change page's
// Clear status and the Mayor's release_change: who may press it, what an
// already-open change with nothing holding it answers, and the refusal on a
// change that is no longer open.
//
// Same harness shape as tests/me-session-state-route.test.js: override
// getPool BEFORE requiring the route module, mount the router on a real
// express app, and inject req.user. The release itself (which records it
// ends, and the line it writes) is services/change-busy.js's, pinned against
// a real PostgreSQL schema in tests/session-work-holders-postgres.test.js and
// its selection rules in tests/change-busy.test.js.
//
// Run with: node --test tests/session-release-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const express = require('express');
const { sessionRoutes } = require('../src/routes/sessions');

const VIEWER = { id: 7, username: 'tester', isAdmin: false };

function startServer({ viewer = VIEWER, config = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, path) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: '{}',
  });
  return { status: res.status, body: await res.json() };
}

// The change row the route reads, and no holder: an idle change.
function pool({ change, holders = [] } = {}) {
  poolQueryHandler = async (sql) => {
    if (/SELECT id, user_id, status FROM chat_sessions/i.test(sql)) return { rows: change ? [change] : [] };
    if (/h\.kind, h\.since, h\.ref/i.test(sql)) return { rows: holders };
    return { rows: [] };
  };
}

test('a change that is not the reader\'s is refused', async () => {
  pool({ change: { id: 50, user_id: 9, status: 'active' } });
  const server = await startServer();
  try {
    const answer = await post(server, '/api/sessions/50/release');
    assert.equal(answer.status, 403);
    assert.equal(answer.body.error, 'Not allowed');
  } finally {
    server.close();
  }
});

test('a platform admin may clear anyone\'s change', async () => {
  pool({ change: { id: 50, user_id: 9, status: 'active' } });
  const server = await startServer({ viewer: { id: 7, username: 'tester', isAdmin: true } });
  try {
    const answer = await post(server, '/api/sessions/50/release');
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { released: [], stillHeld: [], busy: false });
  } finally {
    server.close();
  }
});

test('an idle change answers that nothing was released', async () => {
  pool({ change: { id: 50, user_id: 7, status: 'active' } });
  const server = await startServer();
  try {
    const answer = await post(server, '/api/sessions/50/release');
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { released: [], stillHeld: [], busy: false });
  } finally {
    server.close();
  }
});

test('a change that is no longer open has no status to clear', async () => {
  pool({ change: { id: 50, user_id: 7, status: 'merged' } });
  const server = await startServer();
  try {
    const answer = await post(server, '/api/sessions/50/release');
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'not_open');
  } finally {
    server.close();
  }
});

test('a missing change, and an id that is not one, are both a 404', async () => {
  pool({ change: null });
  const server = await startServer();
  try {
    assert.equal((await post(server, '/api/sessions/50/release')).status, 404);
    assert.equal((await post(server, '/api/sessions/abc/release')).status, 404);
  } finally {
    server.close();
  }
});

'use strict';
// #2089: GET /api/apps/:slug/board-search — the server half of the board
// search. Answers which discussion threads on an app mention the query,
// keyed the way the browser's cards are (GitHub issue number, chat_sessions
// id, issues id), over human messages only, view-gated like the board.
//
// Run with: node --test tests/board-search-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
const pool = { query: (...args) => poolQueryHandler(...args) };
poolMod.getPool = () => pool;

const appAccessId = require.resolve('../src/services/app-access');
let lastAccessLevel = null;
require.cache[appAccessId] = {
  id: appAccessId,
  filename: appAccessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, slug, _user, level) => {
      lastAccessLevel = level;
      return slug === 'demo' ? { id: 7, slug: 'demo' } : null;
    },
    checkAppAccess: async () => true,
    issueCollabGuard: () => (_req, _res, next) => next(),
  },
};

const { issueRoutes } = require('../src/routes/issues');

async function withServer(fn) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 5, username: 'alice' }; next(); });
  app.use(issueRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  try {
    await fn((path) => fetch(`http://127.0.0.1:${port}${path}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('groups matching threads by the key the board looks cards up by', async () => {
  const queries = [];
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return {
      rows: [
        { thread_type: 'issue', thread_ref: 900003 },
        { thread_type: 'session', thread_ref: '9000001' },
        { thread_type: 'governance', thread_ref: 7 },
        { thread_type: 'issue', thread_ref: null },
      ],
    };
  };
  await withServer(async (get) => {
    const res = await get('/api/apps/demo/board-search?q=%25viewport_');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      q: '%viewport_', issues: [900003], sessions: [9000001], gov: [7],
    });
  });
  assert.equal(lastAccessLevel, 'view', 'read-gated like the board itself');
  assert.equal(queries.length, 1);
  const { sql, params } = queries[0];
  assert.match(sql, /FROM chat_messages/);
  assert.match(sql, /msg_type = 'message'/, 'human messages only');
  assert.match(sql, /thread_type IN \('issue', 'session', 'governance'\)/);
  assert.match(sql, /content ILIKE \$2 ESCAPE '\\'/);
  assert.equal(params[0], 7, 'the app id from the access gate');
  assert.equal(params[1], '%\\%viewport\\_%', 'LIKE metacharacters in the query are escaped');
  assert.equal(params[2], 200, 'the hit list is capped');
});

test('a query under the floor answers empty without touching the database', async () => {
  let asked = 0;
  poolQueryHandler = async () => { asked += 1; return { rows: [] }; };
  await withServer(async (get) => {
    for (const q of ['', 'a', '%20%20']) {
      const res = await get(`/api/apps/demo/board-search?q=${q}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual({ issues: body.issues, sessions: body.sessions, gov: body.gov },
        { issues: [], sessions: [], gov: [] });
    }
  });
  assert.equal(asked, 0);
});

test('an app the viewer cannot see is a 404, and a database failure a 500', async () => {
  poolQueryHandler = async () => { throw new Error('boom'); };
  await withServer(async (get) => {
    const missing = await get('/api/apps/nope/board-search?q=viewport');
    assert.equal(missing.status, 404);
    const failed = await get('/api/apps/demo/board-search?q=viewport');
    assert.equal(failed.status, 500);
  });
});

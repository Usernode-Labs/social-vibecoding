'use strict';

// #7172: on a staging copy, a project with no repository shows the requests
// stored for it (its seeds' rows) in its open list, its closed list and at a
// request's own address. Made-up rows fill only a project whose request
// table is empty, open and closed. Runs with a fake pool that answers the
// request reads; the route's other queries get empty rows, as elsewhere.
//
// Run with: node --test tests/staging-requests-stored-first.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.USERNODE_ENV = 'staging';

function rowOf(n, { state = 'open', title = `Seeded request ${n}`, comments = 0 } = {}) {
  return {
    number: n,
    title,
    body: `Stored body of #${n}`,
    state,
    state_reason: state === 'closed' ? 'completed' : null,
    labels: ['seeded'],
    author_login: 'usernode-capture',
    created_at: '2026-11-25T10:00:00Z',
    updated_at: '2026-11-25T11:00:00Z',
    closed_at: state === 'closed' ? '2026-11-25T12:00:00Z' : null,
    comments,
  };
}

function fakePool(requests = [], commentsByNumber = new Map()) {
  const state = { requests: [...requests], calls: [] };
  state.query = async (sql, params = []) => {
    state.calls.push({ sql: String(sql), params });
    const text = String(sql);
    if (text.includes('FROM requests')) {
      if (/number = \$2/.test(text)) {
        const hit = state.requests.find((r) => Number(r.number) === Number(params[1]));
        return { rows: hit ? [hit] : [] };
      }
      const closed = /state = 'closed'/.test(text);
      const rows = state.requests.filter((r) => (closed ? r.state === 'closed' : r.state === 'open'));
      return { rows };
    }
    if (text.includes('FROM request_comments')) {
      const n = Number(params[1]);
      const list = commentsByNumber.get(n) || [];
      return { rows: list };
    }
    return { rows: [] };
  };
  state.connect = async () => ({ query: state.query, release() {} });
  return state;
}

// The pool is read at require time, so it is overridden before the route is.
const poolMod = require('../src/db/pool');
let app = { id: 1, slug: 'staging-demo-pin-1', repo_url: null };
let pool = fakePool();
poolMod.getPool = () => pool;
const requests = require('../src/services/requests');
requests.setPool(pool);
require('../src/services/github').isEnabled = () => false;
require('../src/services/app-access').getAppForUser = async () => app;

const { issueRoutes, readRequestComments } = require('../src/routes/issues');
const express = require('express');

function startServer() {
  const server = express();
  server.use((req, res, next) => { req.user = { id: 7, username: 'usernode-capture' }; next(); });
  server.use(issueRoutes({}));
  return new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
}

async function get(path) {
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

function reset(nextRequests, comments) {
  app = { id: 1, slug: 'staging-demo-pin-1', repo_url: null };
  pool = fakePool(nextRequests, comments);
  requests.setPool(pool);
  poolMod.getPool = () => pool;
}

test('a project with no repository returns its stored open requests, not the mocks', async () => {
  reset([rowOf(9170)]);
  const { status, body } = await get('/api/apps/staging-demo-pin-1/github-issues');
  assert.equal(status, 200);
  assert.deepEqual(body.issues.map((i) => i.number), [9170]);
  assert.equal(body.issues[0].title, 'Seeded request 9170');
  assert.equal(body.truncatedList, false);
});

test('PR #7165: the request seeded into staging-demo-pin-1 opens at its address and is in its list', async () => {
  reset([rowOf(9170, { title: 'Staging demo: a request in an emoji project' })]);
  const list = await get('/api/apps/staging-demo-pin-1/github-issues');
  assert.ok(list.body.issues.some((i) => i.number === 9170), 'the list holds the seeded request');
  const page = await get('/api/apps/staging-demo-pin-1/github-issues/9170');
  assert.equal(page.status, 200);
  assert.equal(page.body.issue.number, 9170);
  assert.equal(page.body.issue.title, 'Staging demo: a request in an emoji project');
});

test('a project with no rows still returns the mocks', async () => {
  reset([]);
  const open = await get('/api/apps/staging-demo-pin-1/github-issues');
  assert.equal(open.body.issues[0].number, 900001);
  const closed = await get('/api/apps/staging-demo-pin-1/github-issues?state=closed');
  assert.equal(closed.body.issues[0].number, 900031);
  const page = await get('/api/apps/staging-demo-pin-1/github-issues/900001');
  assert.equal(page.status, 200);
  assert.equal(page.body.issue.number, 900001);
});

test('a stored closed request is returned, and a project with closed rows has an empty open list', async () => {
  reset([rowOf(9100, { state: 'closed' })]);
  const closed = await get('/api/apps/staging-demo-pin-1/github-issues?state=closed');
  assert.deepEqual(closed.body.issues.map((i) => i.number), [9100]);
  const open = await get('/api/apps/staging-demo-pin-1/github-issues');
  assert.deepEqual(open.body.issues, []);
});

test('a stored request with no comments gets the mock discussion, and one with comments keeps them', async () => {
  const withComments = new Map([[9170, [{
    id: 1, author_login: 'usernode-capture', body: 'Its own reply', created_at: '2026-11-25T11:30:00Z',
  }]]]);
  reset([rowOf(9170), rowOf(9200)], withComments);
  const own = await readRequestComments(pool, app, 9170);
  assert.deepEqual(own.comments.map((c) => c.body), ['Its own reply']);
  const empty = await readRequestComments(pool, app, 9200);
  assert.ok(empty.comments.length > 0, 'the mock discussion stands in');
  assert.notEqual(empty.comments[0].body, 'Its own reply');
});

test('a project with a repository on a copy without GitHub keeps the fixture list', async () => {
  reset([rowOf(9170)]);
  app = { id: 1, slug: 'staging-demo-pin-1', repo_url: 'https://github.com/o/r' };
  const { body } = await get('/api/apps/staging-demo-pin-1/github-issues');
  assert.equal(body.issues[0].number, 900001, 'the declared checks read these rows');
  assert.ok(!body.issues.some((i) => i.number === 9170), 'its stored rows are not listed here');
});

test.after(() => {
  delete process.env.USERNODE_ENV;
});

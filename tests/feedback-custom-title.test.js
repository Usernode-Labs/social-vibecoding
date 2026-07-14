// Tests for the optional user-chosen title on POST /api/feedback (#556).
//
// When the submitter supplies a non-blank `title`, it is used verbatim:
// the Haiku naming call is skipped entirely, `titleFallback` is false,
// and no title_heal_queue row is enqueued. A blank/whitespace title falls
// back to generation exactly as before, and an over-long title is a 400.
//
// Run with: node --test tests/feedback-custom-title.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Override collaborators BEFORE requiring the route module (same pattern
// as tests/github-issues-route.test.js).
const poolMod = require('../src/db/pool');
let poolQueries = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    poolQueries.push({ sql: String(sql), params });
    return { rows: [] };
  },
});

const llm = require('../src/services/llm');
let generateCalls = 0;
llm.generateIssueTitle = async () => {
  generateCalls++;
  return { title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' };
};

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

// Platform-target feedback files via a raw fetch to api.github.com with
// the PAT — stub it and capture the POSTed body. Local requests to the
// test server pass through to the real fetch.
process.env.GITHUB_BOT_TOKEN = 'test-pat';
let ghCreates = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    const body = JSON.parse(opts.body);
    ghCreates.push(body);
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 77, html_url: 'https://github.com/plat/repo/issues/77' }),
    };
  }
  return realFetch(url, opts);
};

const { feedbackRoutes } = require('../src/routes/feedback');
const express = require('express');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  poolQueries = [];
  ghCreates = [];
  generateCalls = 0;
}

async function post(server, body) {
  const port = server.address().port;
  return realFetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('custom title is used verbatim — no LLM call, no heal-queue row', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'Something broke', title: 'My exact title' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'My exact title');
    assert.equal(body.titleFallback, false);
    assert.equal(generateCalls, 0, 'Haiku naming skipped');
    assert.equal(ghCreates.length, 1);
    assert.equal(ghCreates[0].title, 'My exact title');
    assert.ok(
      !poolQueries.some((q) => /INSERT INTO title_heal_queue/.test(q.sql)),
      'no title_heal_queue row for a user-titled issue'
    );
  } finally {
    server.close();
  }
});

test('blank / whitespace title falls back to generation', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'Something broke', title: '   ' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Generated title');
    assert.equal(body.titleFallback, false);
    assert.equal(generateCalls, 1, 'Haiku naming used when the title is blank');
  } finally {
    server.close();
  }
});

test('omitted title generates exactly as before', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'Something broke' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Generated title');
    assert.equal(generateCalls, 1);
  } finally {
    server.close();
  }
});

test('over-long title is rejected with 400 (nothing filed)', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'x', title: 'a'.repeat(201) });
    assert.equal(res.status, 400);
    assert.equal(ghCreates.length, 0, 'no GitHub issue created');
    assert.equal(generateCalls, 0);
  } finally {
    server.close();
  }
});

test('non-string title is rejected with 400', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'x', title: 42 });
    assert.equal(res.status, 400);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

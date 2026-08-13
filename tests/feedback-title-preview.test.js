// Tests for POST /api/feedback/title (#556) — the live title preview
// the feedback modal debounces while the user types their description.
//
//  - success: returns the generated title and records the Haiku spend
//    against the user's daily ledger (same posture as the filing path);
//  - LLM disabled → 200 { title: null, note: 'unavailable' }, no call;
//  - generation throws → 200 { title: null, note: 'failed' } (soft —
//    an empty Title field is a fully working state);
//  - missing / over-long description → 400 with no generation call;
//  - over-long generated titles are clipped to 200 chars;
//  - the route mounts feedbackTitleLimiter (20/min/user → 429 on #21).
//
// Run with: node --test tests/feedback-title-preview.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Override collaborators BEFORE requiring the route module (same pattern
// as tests/feedback-custom-title.test.js).
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [] }) });

const llm = require('../src/services/llm');
let generateCalls = [];
let llmEnabled = true;
let generateImpl = async ({ description }) => {
  generateCalls.push(description);
  return { title: 'Generated title', usage: { input_tokens: 30, output_tokens: 12 }, model: 'claude-haiku-4-5' };
};
llm.isEnabled = () => llmEnabled;
llm.generateIssueTitle = (args) => generateImpl(args);
llm.estimateCostCents = () => 0.05;

const limits = require('../src/services/limits');
let spendCalls = [];
let billingImpl = async () => ({ apiKey: null, byok: false });
limits.resolveBillingPath = (...args) => billingImpl(...args);
limits.recordSpend = async (pool, userId, costCents, opts) => {
  spendCalls.push({ userId, costCents, opts });
};

const { feedbackRoutes } = require('../src/routes/feedback');
const express = require('express');

// The limiter keys by user id; a mutable id lets the 429 test use its
// own bucket so it can't starve the other cases.
let currentUserId = 7;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: currentUserId, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function postTitle(server, body) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}/api/feedback/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  generateCalls = [];
  spendCalls = [];
  llmEnabled = true;
  billingImpl = async () => ({ apiKey: null, byok: false });
  currentUserId = 7;
  generateImpl = async ({ description }) => {
    generateCalls.push(description);
    return { title: 'Generated title', usage: { input_tokens: 30, output_tokens: 12 }, model: 'claude-haiku-4-5' };
  };
});

test('returns the generated title and records spend', async () => {
  const server = await startServer();
  try {
    const res = await postTitle(server, { description: 'The dark mode toggle resets after a refresh' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Generated title');
    assert.ok(!('note' in body));
    assert.deepEqual(generateCalls, ['The dark mode toggle resets after a refresh']);
    assert.equal(spendCalls.length, 1, 'Haiku spend recorded');
    assert.equal(spendCalls[0].userId, 7);
    assert.deepEqual(spendCalls[0].opts, { byok: false });
  } finally {
    server.close();
  }
});

test('LLM disabled → soft null title, no generation call', async () => {
  llmEnabled = false;
  const server = await startServer();
  try {
    const res = await postTitle(server, { description: 'Something broke on my phone' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, null);
    assert.equal(body.note, 'unavailable');
    assert.equal(generateCalls.length, 0);
  } finally {
    server.close();
  }
});

test('generation failure → soft null title with note: failed', async () => {
  generateImpl = async () => { throw new Error('credits exhausted'); };
  const server = await startServer();
  try {
    const res = await postTitle(server, { description: 'Something broke on my phone' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, null);
    assert.equal(body.note, 'failed');
    assert.equal(spendCalls.length, 0);
  } finally {
    server.close();
  }
});

test('exhausted platform credits skip title generation without blocking feedback', async () => {
  billingImpl = async () => ({ error: 'credits exhausted' });
  const server = await startServer();
  try {
    const res = await postTitle(server, { description: 'The form itself must still work' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: null, note: 'credits' });
    assert.equal(generateCalls.length, 0);
    assert.equal(spendCalls.length, 0);
  } finally {
    server.close();
  }
});

test('BYOK title generation uses the user key and records only BYOK spend', async () => {
  billingImpl = async () => ({ apiKey: 'sk-ant-user', byok: true });
  let receivedKey = null;
  generateImpl = async ({ description, apiKey }) => {
    generateCalls.push(description);
    receivedKey = apiKey;
    return {
      title: 'Generated with own key',
      usage: { input_tokens: 30, output_tokens: 12 },
      model: 'claude-haiku-4-5',
    };
  };
  const server = await startServer();
  try {
    const res = await postTitle(server, { description: 'Use my own key for this title' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).title, 'Generated with own key');
    assert.equal(receivedKey, 'sk-ant-user');
    assert.equal(spendCalls.length, 1);
    assert.deepEqual(spendCalls[0].opts, { byok: true });
  } finally {
    server.close();
  }
});

test('missing / blank / over-long description → 400 with no generation call', async () => {
  const server = await startServer();
  try {
    let res = await postTitle(server, {});
    assert.equal(res.status, 400);
    res = await postTitle(server, { description: '   ' });
    assert.equal(res.status, 400);
    res = await postTitle(server, { description: 'x'.repeat(2001) });
    assert.equal(res.status, 400);
    assert.equal(generateCalls.length, 0);
  } finally {
    server.close();
  }
});

test('over-long generated titles are clipped to 200 chars', async () => {
  generateImpl = async () => ({ title: 'a'.repeat(300), usage: undefined, model: 'claude-haiku-4-5' });
  const server = await startServer();
  try {
    const res = await postTitle(server, { description: 'A very rambling description of a bug' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title.length, 200);
  } finally {
    server.close();
  }
});

test('feedbackTitleLimiter is mounted: 21st request in a minute → 429', async () => {
  // Own user id → own limiter bucket, so this test can't starve the
  // others (the store is shared across the process).
  currentUserId = 999;
  const server = await startServer();
  try {
    for (let i = 0; i < 20; i++) {
      const res = await postTitle(server, { description: `request number ${i}` });
      assert.equal(res.status, 200, `request ${i + 1} passes the limiter`);
    }
    const res = await postTitle(server, { description: 'one too many' });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.ok(/slow down/i.test(body.error));
    assert.equal(typeof body.retryAfterSeconds, 'number');
  } finally {
    server.close();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let connectCalls = 0;
const fakePool = {
  // The app-level session guard deliberately falls through when its lookup
  // finds nothing; these validation cases must return before route DB work.
  query: async () => ({ rows: [] }),
  connect: async () => {
    connectCalls += 1;
    throw new Error('validation should have returned before checkout');
  },
};
poolMod.getPool = () => fakePool;

const { sessionRoutes } = require('../src/routes/sessions');

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 7, username: 'owner' };
    next();
  });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, id, body) {
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/sessions/${id}/reset-agent-context`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { response, json: await response.json() };
}

test('reset-agent-context rejects a malformed session id before DB checkout', async (t) => {
  connectCalls = 0;
  const server = await startServer();
  t.after(() => server.close());

  const { response, json } = await post(server, 'not-a-number', {
    backend: 'claude_code',
  });
  assert.equal(response.status, 400);
  assert.equal(json.error, 'Bad session id');
  assert.equal(connectCalls, 0);
});

test('reset-agent-context rejects an explicit unknown backend as a client error', async (t) => {
  connectCalls = 0;
  const server = await startServer();
  t.after(() => server.close());

  const { response, json } = await post(server, 42, {
    backend: 'not-a-real-backend',
  });
  assert.equal(response.status, 400);
  assert.equal(json.error, 'Unknown backend');
  assert.equal(connectCalls, 0);
});

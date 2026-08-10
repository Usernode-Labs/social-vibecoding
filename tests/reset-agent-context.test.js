'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let connectCalls = 0;
let connectHandler = async () => {
  throw new Error('validation should have returned before checkout');
};
const fakePool = {
  // The app-level session guard deliberately falls through when its lookup
  // finds nothing; these validation cases must return before route DB work.
  query: async () => ({ rows: [] }),
  connect: async () => {
    connectCalls += 1;
    return connectHandler();
  },
};
poolMod.getPool = () => fakePool;

const { sessionRoutes } = require('../src/routes/sessions');

async function startServer(config = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 7, username: 'owner' };
    next();
  });
  app.use(sessionRoutes(config));
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
  connectHandler = async () => { throw new Error('validation should have returned before checkout'); };
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
  connectHandler = async () => { throw new Error('validation should have returned before checkout'); };
  const server = await startServer();
  t.after(() => server.close());

  const { response, json } = await post(server, 42, {
    backend: 'not-a-real-backend',
  });
  assert.equal(response.status, 400);
  assert.equal(json.error, 'Unknown backend');
  assert.equal(connectCalls, 0);
});

test('reset-agent-context atomically switches the backend and records the context reset', async (t) => {
  connectCalls = 0;
  const calls = [];
  const updated = {
    id: 42,
    agent_backend: 'claude_code',
    agent_provider: 'anthropic',
    agent_model: null,
    agent_reasoning_effort: null,
    agent_config_version: 3,
  };
  connectHandler = async () => ({
    release() {},
    async query(sql, params) {
      const text = String(sql);
      calls.push({ text, params });
      if (/SELECT id, user_id, status, active_turn/.test(text)) {
        return { rows: [{
          id: 42,
          user_id: 7,
          status: 'active',
          active_turn: null,
          agent_backend: 'codex_openrouter',
          agent_model: 'old/model',
          agent_reasoning_effort: 'high',
          agent_config_version: 2,
        }] };
      }
      if (/UPDATE chat_sessions SET/.test(text)) return { rows: [updated] };
      if (/INSERT INTO chat_session_messages/.test(text)) {
        return { rows: [{ id: 91, role: 'system', content: params[1], metadata: JSON.parse(params[2]) }] };
      }
      return { rows: [] };
    },
  });

  const worker = require('../src/services/worker');
  const originalInFlight = worker.isInFlight;
  const originalEvict = worker.evictWorker;
  let evicted = null;
  worker.isInFlight = () => false;
  worker.evictWorker = async (sessionId) => { evicted = sessionId; };
  t.after(() => {
    worker.isInFlight = originalInFlight;
    worker.evictWorker = originalEvict;
    connectHandler = async () => { throw new Error('validation should have returned before checkout'); };
  });

  const server = await startServer();
  t.after(() => server.close());
  const { response, json } = await post(server, 42, { backend: 'claude_code' });

  assert.equal(response.status, 200);
  assert.equal(json.session.agent_backend, 'claude_code');
  assert.match(json.message.content, /Coding agent switched to Claude Code/);
  assert.equal(json.message.metadata.previousBackend, 'codex_openrouter');
  assert.equal(json.message.metadata.agentBackend, 'claude_code');
  assert.equal(connectCalls, 1);
  assert.equal(evicted, 42);
  const update = calls.find((call) => /UPDATE chat_sessions SET/.test(call.text));
  assert.deepEqual(update.params.slice(1), ['claude_code', 'anthropic', null, null]);
  assert.ok(calls.some((call) => call.text === 'COMMIT'));
});

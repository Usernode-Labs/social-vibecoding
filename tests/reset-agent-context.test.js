'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let connectCalls = 0;
let connectHandler = async () => {
  throw new Error('validation should have returned before checkout');
};
// Pool-level queries (as opposed to the checked-out client's): the app
// guard's lookup, the stored-preference read, and #1348's write-back of the
// backend a user just picked. Programmable so a test can seed a preference;
// the default answers nothing, which is "this user has no stored default".
let poolQueries = [];
let poolQueryHandler = async () => ({ rows: [] });
const fakePool = {
  // The app-level session guard deliberately falls through when its lookup
  // finds nothing; these validation cases must return before route DB work.
  query: async (sql, params) => {
    poolQueries.push({ text: String(sql), params });
    return poolQueryHandler(String(sql), params);
  },
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

// ── #1348: "whichever on-platform agent I used last" ─────────────────
//
// The venue sheet asks one coarse "On-Platform" question now, so the pick
// carries no backend and this route resolves it. Two halves have to hold:
// an omitted backend reads the stored preference LENIENTLY, and an explicit
// one is remembered so there is something to read next time.

// A session row the switch can actually operate on.
function switchableSession(t, updated) {
  connectHandler = async () => ({
    release() {},
    async query(sql, params) {
      const text = String(sql);
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
  worker.isInFlight = () => false;
  worker.evictWorker = async () => {};
  t.after(() => {
    worker.isInFlight = originalInFlight;
    worker.evictWorker = originalEvict;
    connectHandler = async () => { throw new Error('validation should have returned before checkout'); };
    poolQueryHandler = async () => ({ rows: [] });
    poolQueries = [];
  });
}

const CLAUDE_ROW = {
  id: 42,
  agent_backend: 'claude_code',
  agent_provider: 'anthropic',
  agent_model: null,
  agent_reasoning_effort: null,
  agent_config_version: 3,
};

test('an omitted backend resolves the stored default, leniently, with its reason', async (t) => {
  // The distinguishing case. A stored OpenRouter default that no longer
  // validates must not 4xx the switch — the user asked to come back
  // on-platform, and refusing would strand them somewhere else. It falls
  // back to Claude AND says why, which is the sentence the client paints
  // above the composer.
  connectCalls = 0;
  poolQueries = [];
  poolQueryHandler = async (text) => {
    if (/FROM user_agent_preferences/.test(text) && /is_default = TRUE/.test(text)) {
      return { rows: [{ backend: 'codex_openrouter', model_id: 'x/y', reasoning_effort: null }] };
    }
    return { rows: [] };
  };
  switchableSession(t, CLAUDE_ROW);
  // No codexOpenrouterEnabled in the config: the deployment has it off.
  const server = await startServer({});
  t.after(() => server.close());

  const { response, json } = await post(server, 42, {});
  assert.equal(response.status, 200);
  assert.equal(json.session.agent_backend, 'claude_code');
  assert.equal(json.agentFallbackReason, 'flag_off',
    'the client needs the reason to explain the venue it did not get');
});

test('an omitted backend writes no preference — it had no new answer', async (t) => {
  // The resolved switch was READ from the preference. Writing it back would
  // be a write on every visit to a row nobody chose.
  connectCalls = 0;
  poolQueries = [];
  switchableSession(t, CLAUDE_ROW);
  const server = await startServer({});
  t.after(() => server.close());

  const { response } = await post(server, 42, {});
  assert.equal(response.status, 200);
  assert.ok(
    !poolQueries.some((q) => /INSERT INTO user_agent_preferences/.test(q.text)),
    'a resolved switch must not rewrite the preference it just read',
  );
});

test('an explicit pick is remembered as the one you used last', async (t) => {
  // Without this there is nothing for the coarse row to resolve TO: the
  // preference would only ever change from Settings, and "most recently
  // used" would mean "whatever you last configured".
  connectCalls = 0;
  poolQueries = [];
  switchableSession(t, CLAUDE_ROW);
  const server = await startServer({});
  t.after(() => server.close());

  const { response } = await post(server, 42, { backend: 'claude_code' });
  assert.equal(response.status, 200);
  const clear = poolQueries.find((q) => /UPDATE user_agent_preferences SET is_default = FALSE/.test(q.text));
  const upsert = poolQueries.find((q) => /INSERT INTO user_agent_preferences/.test(q.text));
  assert.ok(clear, 'other defaults are cleared');
  assert.ok(upsert, 'the picked backend is stored');
  assert.deepEqual(upsert.params, [7, 'claude_code', null, null]);
  // Order matters: the partial unique index (one is_default per user)
  // rejects the upsert if another backend still holds the flag, because
  // ON CONFLICT only fires after the INSERT has attempted the second row.
  assert.ok(
    poolQueries.indexOf(clear) < poolQueries.indexOf(upsert),
    'the clear must precede the upsert',
  );
});

test('a preference that fails to save does not fail the switch', async (t) => {
  // It happens after the commit. The session has already moved; turning
  // that into a 500 would tell the user nothing happened when it did.
  connectCalls = 0;
  poolQueries = [];
  switchableSession(t, CLAUDE_ROW);
  poolQueryHandler = async (text) => {
    if (/user_agent_preferences/.test(text) && !/is_default = TRUE\s*$/.test(text)) {
      throw new Error('preference store is down');
    }
    return { rows: [] };
  };
  const server = await startServer({});
  t.after(() => server.close());

  const { response, json } = await post(server, 42, { backend: 'claude_code' });
  assert.equal(response.status, 200, 'the switch still succeeded');
  assert.equal(json.session.agent_backend, 'claude_code');
});

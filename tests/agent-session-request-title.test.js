'use strict';

// #3752: a conversation opened on a request is named after that request.
//
// Start work on a request card opens an agent session focused on the
// request, and the conversation used to take its name from the first message
// only. So one that opened with "can you implement this?" was called exactly
// that, and nothing in Messages or its header said which request it was for.
// It is now named "#N · <request title>", the name a session about an issue
// already gets (session-title.js headlessTitle), once the request is read.
//
//   1. THE REQUEST IS READ AS ITS PAGE READS IT: GitHub first, the staging
//      mock requests when GitHub has nothing, and null when neither has it.
//   2. ONLY AN AUTOMATIC NAME IS REPLACED, and only on a conversation opened
//      on a request: one its owner renamed keeps its name, and one whose
//      request cannot be read keeps its first message's.
//   3. THE TURN ROUTE STARTS IT once the first message is written, without
//      waiting for it, and only for an untitled conversation on a request.
//
// The same rules against a real PostgreSQL are in
// tests/agent-sessions-postgres.test.js.
//
// Run with: node --test tests/agent-session-request-title.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const agentSessions = require('../src/services/agent-sessions');

function recordingPool(handlers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, fn] of Object.entries(handlers)) {
        if (new RegExp(pattern).test(sql)) return fn(sql, params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ── 1. Reading the request ─────────────────────────────────────────────

function fakeGithub({ enabled = true, issue = null } = {}) {
  const asked = [];
  return {
    asked,
    isEnabled: () => enabled,
    fetchPublicIssue: async (owner, repo, number) => {
      asked.push([owner, repo, number]);
      return issue ? { issue } : { issue: null, note: 'not found' };
    },
  };
}

test('the request\'s title is read from GitHub, cache-first, for the app\'s own repo', async () => {
  const github = fakeGithub({ issue: { number: 75, title: 'Keep checked items in place' } });
  assert.equal(
    await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list.git', 75, { github, staging: false }),
    'Keep checked items in place',
  );
  assert.deepEqual(github.asked, [['acme', 'todo-list', 75]]);

  const off = fakeGithub({ enabled: false, issue: { number: 75, title: 'x' } });
  assert.equal(await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 75, { github: off, staging: false }), null,
    'no GitHub on this deployment: no name to give');
  assert.deepEqual(off.asked, []);
  assert.equal(await agentSessions.lookupRequestTitle(null, 75, { github: fakeGithub({ issue: { title: 'x' } }), staging: false }), null,
    'an app with no repo has no requests to read');
  assert.equal(await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 76, { github: fakeGithub(), staging: false }), null,
    'a request GitHub does not have');
});

test('in staging, a mock request on the board names its conversation, as the request\'s page reads it', async () => {
  const mocks = [{ number: 900001, title: '[Mock] Dark mode toggle resets after refresh' }];
  const deps = { github: fakeGithub({ enabled: false }), staging: true, stagingMockIssues: () => mocks };
  assert.equal(await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 900001, deps),
    '[Mock] Dark mode toggle resets after refresh');
  assert.equal(await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 12, deps), null);
  assert.equal(await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 900001, { ...deps, staging: false }), null,
    'never outside staging');
  // The real list, as routes/issues.js serves it.
  const real = await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 900001, { github: fakeGithub({ enabled: false }), staging: true });
  assert.match(real, /^\[Mock\] /);
  // A live request still wins over a mock with the same number.
  assert.equal(await agentSessions.lookupRequestTitle('https://github.com/acme/todo-list', 900001,
    { ...deps, github: fakeGithub({ issue: { number: 900001, title: 'Live title' } }) }), 'Live title');
});

// ── 2. Naming ──────────────────────────────────────────────────────────

const OPENED_ON_REQUEST = { focus_context: { entry: 'issue', issueNumber: 75 }, repo_url: 'https://github.com/acme/todo-list' };

test('a conversation opened on a request is named "#N · <title>", over its first message\'s automatic name only', async () => {
  const asked = [];
  const lookupTitle = async (repoUrl, number) => { asked.push([repoUrl, number]); return '  Keep checked items\n in place  '; };
  const pool = recordingPool({
    'SELECT s\\.focus_context, a\\.repo_url': () => ({ rows: [OPENED_ON_REQUEST] }),
    'UPDATE agent_sessions SET title': () => ({ rows: [{ id: 5 }], rowCount: 1 }),
  });
  assert.equal(await agentSessions.nameFromRequest(pool, { agentSessionId: 5, userId: 7, lookupTitle }),
    '#75 · Keep checked items in place');
  assert.deepEqual(asked, [['https://github.com/acme/todo-list', 75]]);

  const [read, update] = pool.calls;
  assert.match(read.sql, /JOIN apps a ON a\.id = s\.focus_app_id/, 'the request is on the conversation\'s focus app');
  assert.match(read.sql, /WHERE s\.id = \$1 AND s\.user_id = \$2 AND s\.title_source = 'auto'/, 'the owner\'s, and not renamed');
  assert.deepEqual(read.params, [5, 7]);
  assert.match(update.sql, /WHERE id = \$2 AND user_id = \$3 AND title_source = 'auto'/,
    'a rename that lands while the request is read still wins');
  assert.doesNotMatch(update.sql, /title IS NULL/, 'the first message\'s automatic name is replaced');
  assert.deepEqual(update.params, ['#75 · Keep checked items in place', 5, 7]);
});

test('nothing is renamed without a request, a readable title, or an automatic name to replace', async () => {
  let looked = 0;
  const lookupTitle = async () => { looked += 1; return 'Keep checked items in place'; };

  const renamed = recordingPool();
  assert.equal(await agentSessions.nameFromRequest(renamed, { agentSessionId: 5, userId: 7, lookupTitle }), null,
    'renamed by its owner (or not theirs): the read finds nothing');
  assert.equal(looked, 0);

  const noRequest = recordingPool({
    'SELECT s\\.focus_context': () => ({ rows: [{ focus_context: { entry: 'improve' }, repo_url: 'https://github.com/acme/todo-list' }] }),
  });
  assert.equal(await agentSessions.nameFromRequest(noRequest, { agentSessionId: 5, userId: 7, lookupTitle }), null);
  assert.equal(looked, 0, 'a conversation not opened on a request keeps its first message\'s name');
  assert.equal(noRequest.calls.filter((c) => /UPDATE/.test(c.sql)).length, 0);

  const unreadable = recordingPool({ 'SELECT s\\.focus_context': () => ({ rows: [OPENED_ON_REQUEST] }) });
  assert.equal(await agentSessions.nameFromRequest(unreadable, { agentSessionId: 5, userId: 7, lookupTitle: async () => null }), null);
  assert.equal(unreadable.calls.filter((c) => /UPDATE/.test(c.sql)).length, 0, 'GitHub had nothing: the first message\'s name stays');

  const failing = recordingPool({ 'SELECT s\\.focus_context': () => ({ rows: [OPENED_ON_REQUEST] }) });
  assert.equal(await agentSessions.nameFromRequest(failing, {
    agentSessionId: 5, userId: 7, lookupTitle: async () => { throw new Error('socket hang up'); },
  }), null, 'never rejects: a name is not worth failing a turn over');
});

// ── 3. The turn route starts it ────────────────────────────────────────

const poolMod = require('../src/db/pool');
const agentTurn = require('../src/services/mayor/agent-turn');

const SESSION_ROW = {
  id: 5, user_id: 7, title: null, title_source: 'auto', status: 'open', focus_app_id: 3,
  focus_context: { entry: 'issue', issueNumber: 75 }, active_change_id: null, active_turn: null,
  last_activity_at: new Date('2026-10-03T12:00:00Z'), created_at: new Date('2026-10-03T12:00:00Z'),
  archived_at: null, focus_app_slug: 'todo-list', focus_app_name: 'Todo List',
};

async function sendFirstMessage(row) {
  const pool = recordingPool({
    'FROM agent_sessions s': () => ({ rows: [row] }),
    'UPDATE agent_sessions\\s+SET active_turn': () => ({ rows: [{ id: 5 }] }),
    'INSERT INTO chat_session_messages': () => ({ rows: [{ id: 99 }] }),
  });
  const saved = {
    getPool: poolMod.getPool,
    runAgentTurn: agentTurn.runAgentTurn,
    resolveAgentMayor: agentTurn.resolveAgentMayor,
    nameFromRequest: agentSessions.nameFromRequest,
  };
  const named = [];
  const order = [];
  poolMod.getPool = () => pool;
  agentTurn.resolveAgentMayor = async () => ({ ok: true, apiKey: 'k' });
  agentTurn.runAgentTurn = async (args) => { order.push('turn'); args.res.end(); };
  // Never settles: the turn must not wait for the request to be read.
  agentSessions.nameFromRequest = (_pool, args) => { order.push('name'); named.push(args); return new Promise(() => {}); };
  delete require.cache[require.resolve('../src/routes/agent-sessions')];
  const { agentSessionRoutes } = require('../src/routes/agent-sessions');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(agentSessionRoutes({}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agent-sessions/5/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'can you implement this?' }),
    });
    await res.arrayBuffer();
    assert.equal(res.status, 200);
    const firstName = pool.calls.find((c) => /SET title = \$1\s+WHERE id = \$2 AND title IS NULL/.test(c.sql));
    return { named, order, firstName: firstName ? firstName.params[0] : null };
  } finally {
    server.close();
    Object.assign(poolMod, { getPool: saved.getPool });
    Object.assign(agentTurn, { runAgentTurn: saved.runAgentTurn, resolveAgentMayor: saved.resolveAgentMayor });
    agentSessions.nameFromRequest = saved.nameFromRequest;
    delete require.cache[require.resolve('../src/routes/agent-sessions')];
  }
}

test('the first message of a conversation opened on a request starts the naming, and the turn does not wait for it', async () => {
  const opened = await sendFirstMessage(SESSION_ROW);
  assert.equal(opened.firstName, 'can you implement this?', 'the message names it first, with the message, as before');
  assert.deepEqual(opened.named, [{ agentSessionId: 5, userId: 7 }]);
  assert.deepEqual(opened.order, ['name', 'turn'], 'started after the message is written, and the turn runs at once');

  const titled = await sendFirstMessage({ ...SESSION_ROW, title: 'Checklist order', title_source: 'manual' });
  assert.deepEqual(titled.named, [], 'a conversation that already has a name keeps it');
  assert.equal(titled.firstName, null);

  const plain = await sendFirstMessage({ ...SESSION_ROW, focus_context: { entry: 'improve' } });
  assert.deepEqual(plain.named, [], 'one not opened on a request is named from its first message, as before');
  assert.equal(plain.firstName, 'can you implement this?');
});

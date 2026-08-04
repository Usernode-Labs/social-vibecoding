'use strict';

// JSON group-chat write route used by CLI/MCP clients. The route must keep
// browser and bearer behavior aligned by delegating to the canonical
// WebSocket message handler rather than inserting chat rows itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeAccessToken, hashSecret } = require('../src/services/cli-auth');
const {
  API_SCOPE,
  CLIENT_ID,
  IDENTITY_SCOPE,
} = require('../src/services/cli-auth-constants');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
const pool = { query: (...args) => poolQueryHandler(...args) };
poolMod.getPool = () => pool;

const appAccessId = require.resolve('../src/services/app-access');
let grantedApp = { id: 7, slug: 'demo' };
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
      return slug === 'demo' ? grantedApp : null;
    },
    checkAppAccess: async () => true,
  },
};

const wsId = require.resolve('../src/services/ws');
let handleCalls = [];
let handleResult;
require.cache[wsId] = {
  id: wsId,
  filename: wsId,
  loaded: true,
  paths: [],
  exports: {
    handleMessage: async (...args) => {
      handleCalls.push(args);
      return handleResult;
    },
    getReactionsForMessages: async () => ({}),
  },
};

const { chatRoutes } = require('../src/routes/chat');

function reset() {
  grantedApp = { id: 7, slug: 'demo' };
  lastAccessLevel = null;
  handleCalls = [];
  poolQueryHandler = async () => ({ rows: [] });
  handleResult = {
    ok: true,
    message: {
      id: 31,
      userId: 5,
      username: 'alice',
      content: 'Need the exact error output.',
      msgType: 'message',
      thread: { type: 'issue', ref: 864 },
      createdAt: '2026-08-04T10:00:00.000Z',
    },
  };
}

async function startBearerServer() {
  const { cliApiBearerAuth } = require('../src/routes/cli-auth');
  const app = express();
  app.use(express.json());
  app.use(cliApiBearerAuth({ cliAuthEnabled: true }));
  app.use(chatRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // cliApiBearerAuth and cookie auth both expose this same request shape
    // before the route is mounted (server.js).
    req.user = { id: 5, username: 'alice' };
    req.cliAuthenticated = true;
    next();
  });
  app.use(chatRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, path = '/api/apps/demo/messages') {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

test('GET and POST share strict thread-ref validation', async () => {
  reset();
  const server = await startServer();
  try {
    for (const threadRef of ['1e3', '12junk', '0', '2147483648']) {
      const res = await fetch(urlFor(
        server,
        `/api/apps/demo/messages?thread_type=issue&thread_ref=${threadRef}`
      ));
      assert.equal(res.status, 400, threadRef);
    }
    assert.equal(lastAccessLevel, null, 'invalid query is rejected before app lookup');
  } finally {
    server.close();
  }
});

test('POST issue reply is collab-gated and delegates to the canonical chat handler', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '  Need the exact error output.  ',
        thread_type: 'issue',
        thread_ref: 864,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(lastAccessLevel, 'collab');
    assert.equal(handleCalls.length, 1);
    assert.equal(handleCalls[0][0], pool);
    assert.deepEqual(handleCalls[0][1], {
      user: { id: 5, username: 'alice' },
      appId: 7,
      appSlug: 'demo',
    });
    assert.deepEqual(handleCalls[0][2], {
      type: 'chat',
      content: '  Need the exact error output.  ',
      thread: { type: 'issue', ref: 864 },
    });
    assert.deepEqual(await res.json(), {
      message: {
        id: 31,
        user_id: 5,
        username: 'alice',
        content: 'Need the exact error output.',
        msg_type: 'message',
        metadata: {},
        thread_type: 'issue',
        thread_ref: 864,
        created_at: '2026-08-04T10:00:00.000Z',
        edited_at: null,
        reactions: [],
      },
    });
  } finally {
    server.close();
  }
});

test('CLI API bearer authenticates all the way through the issue-reply route', async () => {
  reset();
  const token = makeAccessToken();
  const now = new Date();
  poolQueryHandler = async (sql, params = []) => {
    const text = String(sql);
    if (/FROM cli_access_tokens/.test(text)) {
      assert.equal(params[0], hashSecret(token));
      return {
        rows: [{
          id: 11,
          user_id: 5,
          client_id: CLIENT_ID,
          scopes: [IDENTITY_SCOPE, API_SCOPE],
          created_at: now,
          last_used_at: null,
          expires_at: new Date(now.getTime() + 60_000),
          revoked_at: null,
        }],
      };
    }
    if (/clock_timestamp\(\) AS now/.test(text)) return { rows: [{ now }] };
    if (/FROM cli_auth_rate_limits/.test(text)) return { rows: [] };
    if (/SELECT id, username, is_admin, admin_readonly/.test(text)) {
      return {
        rows: [{
          id: 5,
          username: 'alice',
          is_admin: false,
          admin_readonly: false,
          app_quota: 3,
          ai_progress_estimate: false,
          locale: null,
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  };

  const server = await startBearerServer();
  try {
    const res = await fetch(urlFor(server), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Need the exact error output.',
        thread_type: 'issue',
        thread_ref: 864,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(handleCalls.length, 1);
    assert.deepEqual(handleCalls[0][1].user, {
      id: 5,
      username: 'alice',
      isAdmin: false,
      adminReadonly: false,
      canAdminWrite: false,
      appQuota: 3,
      aiProgressEstimate: false,
      locale: null,
    });
  } finally {
    server.close();
  }
});

test('POST accepts a decimal string thread ref and supports general chat', async () => {
  reset();
  const server = await startServer();
  try {
    let res = await fetch(urlFor(server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'reply', thread_type: 'issue', thread_ref: '864' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(handleCalls[0][2].thread, { type: 'issue', ref: 864 });

    handleCalls = [];
    handleResult.message.thread = undefined;
    res = await fetch(urlFor(server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'general chat' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(handleCalls[0][2], { type: 'chat', content: 'general chat' });
    const body = await res.json();
    assert.equal(body.message.thread_type, null);
    assert.equal(body.message.thread_ref, null);
  } finally {
    server.close();
  }
});

test('POST rejects empty content and malformed thread scopes after the access lookup', async () => {
  const invalidBodies = [
    [],
    {},
    { content: '   ' },
    { content: 42 },
    { content: 'x', thread_type: 'issue' },
    { content: 'x', thread_ref: 864 },
    { content: 'x', thread_type: 'github', thread_ref: 864 },
    { content: 'x', thread_type: 'issue', thread_ref: 0 },
    { content: 'x', thread_type: 'issue', thread_ref: '1e3' },
    { content: 'x', thread_type: 'issue', thread_ref: 2147483648 },
  ];
  const server = await startServer();
  try {
    for (const requestBody of invalidBodies) {
      reset();
      const res = await fetch(urlFor(server), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      assert.equal(res.status, 400, JSON.stringify(requestBody));
      assert.equal(lastAccessLevel, 'collab', JSON.stringify(requestBody));
      assert.equal(handleCalls.length, 0, JSON.stringify(requestBody));
    }
  } finally {
    server.close();
  }
});

test('POST hides the app from non-collaborators', async () => {
  reset();
  grantedApp = null;
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'reply', thread_type: 'issue', thread_ref: 864 }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'App not found' });
    assert.equal(lastAccessLevel, 'collab');
    assert.equal(handleCalls.length, 0);
  } finally {
    server.close();
  }
});

test('POST hides the app before validating a denied caller payload', async () => {
  reset();
  grantedApp = null;
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 42, thread_type: 'not-a-thread' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'App not found' });
    assert.equal(handleCalls.length, 0);
  } finally {
    server.close();
  }
});

test('POST maps canonical race-time access and thread failures safely', async () => {
  reset();
  const server = await startServer();
  try {
    for (const [result, status, error] of [
      [{ ok: false, code: 'not_collaborator' }, 404, 'App not found'],
      [{ ok: false, code: 'invalid_thread' }, 400, 'Invalid thread_type/thread_ref'],
      [{ ok: false, code: 'write_access_failed' }, 503, 'temporarily_unavailable'],
    ]) {
      handleResult = result;
      const res = await fetch(urlFor(server), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'reply', thread_type: 'session', thread_ref: 12 }),
      });
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), { error });
    }
  } finally {
    server.close();
  }
});

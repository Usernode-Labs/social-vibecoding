'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');

const poolModule = require('../src/db/pool');
const credentialStore = require('../src/services/credential-store');
const profileService = require('../src/services/global-chat/profile');
const globalChatStore = require('../src/services/global-chat/store');

const THREAD_ID = '95df0790-4873-43cc-9608-728f3349da50';
const NEXT_THREAD_ID = '6d461f00-ca14-44ee-a2b0-67fda9c81d73';

async function listen(router, { authenticated = true } = {}) {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      req.user = { id: 7, username: 'member' };
      next();
    });
  }
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function mount(t, { authenticated = true, enabled = true } = {}) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ name: 'pool.query', sql, params });
      if (/FROM user_agent_preferences/.test(sql)) {
        return { rows: [{ backend: 'codex', model_id: 'glm/dev', reasoning_effort: 'high' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const originals = {
    getPool: poolModule.getPool,
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    readProfile: profileService.readProfile,
    readMonthlyUsage: profileService.readMonthlyUsage,
    ensureThread: globalChatStore.ensureThread,
    currentThread: globalChatStore.currentThread,
    createThread: globalChatStore.createThread,
    listMessages: globalChatStore.listMessages,
    loadToolResults: globalChatStore.loadToolResults,
    deleteThread: globalChatStore.deleteThread,
    turnState: globalChatStore.turnState,
  };

  poolModule.getPool = () => pool;
  credentialStore.readMetadata = async () => ({ status: 'valid', revision: 4 });
  credentialStore.readSecret = async () => 'sk-or-private';
  profileService.readProfile = async (_pool, userId) => {
    calls.push({ name: 'readProfile', userId });
    return {
      backend: 'openrouter', enabled, model: 'cheap/global', reasoningEffort: 'low',
      spendCapUsd: '1', saved: true,
    };
  };
  profileService.readMonthlyUsage = async (_pool, userId, options) => {
    calls.push({ name: 'readMonthlyUsage', userId, options });
    return { spentUsd: '0.02', capUsd: '1', remainingUsd: '0.98' };
  };
  globalChatStore.ensureThread = async (_pool, userId) => {
    calls.push({ name: 'ensureThread', userId });
    return { id: THREAD_ID, summary: null };
  };
  globalChatStore.currentThread = async (_pool, userId) => {
    calls.push({ name: 'currentThread', userId });
    return { id: THREAD_ID };
  };
  globalChatStore.createThread = async (_pool, userId, options) => {
    calls.push({ name: 'createThread', userId, options });
    return { id: NEXT_THREAD_ID };
  };
  globalChatStore.listMessages = async (_pool, options) => {
    calls.push({ name: 'listMessages', options });
    return {
      messages: [{
        id: '2', threadId: THREAD_ID, role: 'assistant', text: 'Done.',
        payload: {
          presentation: {
            message: 'Done.', resultRefs: ['00000000-0000-4000-8000-000000000001'],
            suggestions: [],
          },
        },
      }],
      hasMore: false,
      before: null,
    };
  };
  globalChatStore.loadToolResults = async (_pool, options) => {
    calls.push({ name: 'loadToolResults', options });
    return [{
      id: '00000000-0000-4000-8000-000000000001',
      renderer: 'issue',
      authoritativeResult: { ok: true, status: 200, data: { number: 7, title: 'Example' } },
      classicPath: '#app/demo/dev/issues/7',
    }];
  };
  globalChatStore.deleteThread = async (_pool, userId, threadId) => {
    calls.push({ name: 'deleteThread', userId, threadId });
    return threadId === THREAD_ID;
  };
  globalChatStore.turnState = async (_pool, options) => {
    calls.push({ name: 'turnState', options });
    return { active: true, turnId: NEXT_THREAD_ID, startedAt: '2026-09-18T12:00:00.000Z' };
  };

  const routePath = require.resolve('../src/routes/global-chat');
  delete require.cache[routePath];
  const { globalChatRoutes } = require(routePath);
  const { server, base } = await listen(globalChatRoutes({
    openrouterDefaultGlobalChatModel: 'cheap/global',
    openrouterDefaultGlobalChatReasoning: 'low',
    dataEncryptionKey: 'test-key',
  }), { authenticated });

  t.after(() => {
    server.close();
    poolModule.getPool = originals.getPool;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    profileService.readProfile = originals.readProfile;
    profileService.readMonthlyUsage = originals.readMonthlyUsage;
    globalChatStore.ensureThread = originals.ensureThread;
    globalChatStore.currentThread = originals.currentThread;
    globalChatStore.createThread = originals.createThread;
    globalChatStore.listMessages = originals.listMessages;
    globalChatStore.loadToolResults = originals.loadToolResults;
    globalChatStore.deleteThread = originals.deleteThread;
    globalChatStore.turnState = originals.turnState;
    delete require.cache[routePath];
  });
  return { base, calls };
}

test('bootstrap keeps Classic as startup and returns separate profiles with compact first-use actions', async (t) => {
  const { base, calls } = await mount(t);
  const response = await fetch(`${base}/api/global-chat/bootstrap`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  const body = await response.json();

  assert.equal(body.experimental, true);
  assert.equal(body.label, 'Chat (experimental)');
  assert.equal(body.startupMode, 'classic');
  assert.equal(body.parityReady, true);
  assert.equal(body.available, true);
  assert.equal(body.thread.id, THREAD_ID);
  assert.equal(body.profiles.globalChat.model, 'cheap/global');
  assert.equal(body.profiles.globalChat.enabled, true);
  assert.equal(body.profiles.globalChat.reasoningEffort, 'low');
  assert.deepEqual(body.profiles.development, {
    backend: 'codex', model: 'glm/dev', reasoningEffort: 'high',
  });
  assert.equal(body.firstUse.suggestions.length, 5);
  assert.deepEqual(
    body.firstUse.suggestions.map(({ label }) => label),
    ['Show my work', 'Explore apps', 'Find issues', 'Review proposals', 'Check messages'],
  );
  assert.ok(body.firstUse.suggestions.every((suggestion) => !Object.hasOwn(suggestion, 'description')));
  assert.equal(JSON.stringify(body).includes('sk-or-private'), false);
  assert.ok(calls.some((call) => call.name === 'ensureThread' && call.userId === 7));
});

test('disabled profiles can inspect bootstrap state but cannot create or use chat threads', async (t) => {
  const { base, calls } = await mount(t, { enabled: false });
  const bootstrap = await fetch(`${base}/api/global-chat/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const body = await bootstrap.json();
  assert.equal(body.profiles.globalChat.enabled, false);
  assert.equal(body.available, false);
  assert.equal(body.unavailableReason, 'global_chat_disabled');
  assert.equal(body.thread, null);
  assert.equal(calls.some((call) => call.name === 'ensureThread'), false);

  const current = await fetch(`${base}/api/global-chat/threads/current`);
  assert.equal(current.status, 403);
  assert.equal((await current.json()).code, 'global_chat_disabled');
});

test('thread endpoints use authenticated ownership and preserve append-only suggestion history', async (t) => {
  const { base, calls } = await mount(t);

  const current = await fetch(`${base}/api/global-chat/threads/current`);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).thread.id, THREAD_ID);

  const created = await fetch(`${base}/api/global-chat/threads`, { method: 'POST' });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.thread.id, NEXT_THREAD_ID);
  assert.equal(createdBody.firstUse.suggestions.length, 5);

  const status = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turn-status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    active: true,
    turnId: NEXT_THREAD_ID,
    startedAt: '2026-09-18T12:00:00.000Z',
  });
  assert.deepEqual(calls.find((call) => call.name === 'turnState').options, {
    userId: 7,
    threadId: THREAD_ID,
  });

  const messages = await fetch(
    `${base}/api/global-chat/threads/${THREAD_ID}/messages?before=12&limit=7`,
  );
  assert.equal(messages.status, 200);
  const messagePage = await messages.json();
  assert.equal(messagePage.messages[0].text, 'Done.');
  assert.equal(messagePage.results[0].renderer, 'issue');
  assert.deepEqual(
    calls.find((call) => call.name === 'listMessages').options,
    { userId: 7, threadId: THREAD_ID, before: '12', limit: '7' },
  );
  assert.deepEqual(
    calls.find((call) => call.name === 'loadToolResults').options,
    {
      userId: 7,
      threadId: THREAD_ID,
      resultIds: ['00000000-0000-4000-8000-000000000001'],
      dataKey: 'test-key',
    },
  );

  const deleted = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.ok(calls.some((call) => call.name === 'createThread'
    && call.userId === 7 && call.options.replace === true));
  assert.ok(calls.some((call) => call.name === 'deleteThread'
    && call.userId === 7 && call.threadId === THREAD_ID));
});

test('thread APIs fail closed for unauthenticated requests', async (t) => {
  const { base } = await mount(t, { authenticated: false });
  const responses = await Promise.all([
    fetch(`${base}/api/global-chat/bootstrap`),
    fetch(`${base}/api/global-chat/threads/current`),
    fetch(`${base}/api/global-chat/threads`, { method: 'POST' }),
    fetch(`${base}/api/global-chat/threads/${THREAD_ID}/messages`),
    fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turn-status`),
    fetch(`${base}/api/global-chat/threads/${THREAD_ID}/cancel`, { method: 'POST' }),
    fetch(`${base}/api/global-chat/threads/${THREAD_ID}`, { method: 'DELETE' }),
  ]);
  assert.deepEqual(responses.map(({ status }) => status), [401, 401, 401, 401, 401, 401, 401]);
});

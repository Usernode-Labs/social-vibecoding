'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');

const poolModule = require('../src/db/pool');
const credentialStore = require('../src/services/credential-store');
const openrouterClient = require('../src/services/openrouter-client');
const agentModels = require('../src/services/agent-models');
const profileService = require('../src/services/global-chat/profile');
const globalChatStore = require('../src/services/global-chat/store');
const orchestratorModule = require('../src/services/global-chat/orchestrator');
const actionExecutorModule = require('../src/services/global-chat/action-executor');

const THREAD_ID = '95df0790-4873-43cc-9608-728f3349da50';
const RESULT_ID = '00000000-0000-4000-8000-000000000001';

async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 7, username: 'alice', isAdmin: false, canAdminWrite: false };
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function mount(t) {
  const calls = [];
  const pool = {
    async query(sql) {
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
    validateKey: openrouterClient.validateKey,
    listModels: agentModels.listOpenRouterModels,
    readProfile: profileService.readProfile,
    readUsage: profileService.readMonthlyUsage,
    compatibleModels: profileService.compatibleModels,
    insertMessage: globalChatStore.insertMessage,
    createOrchestrator: orchestratorModule.createGlobalChatOrchestrator,
    createActionExecutor: actionExecutorModule.createActionExecutor,
  };
  poolModule.getPool = () => pool;
  credentialStore.readMetadata = async () => ({ status: 'valid', revision: 4 });
  credentialStore.readSecret = async () => 'sk-or-private';
  openrouterClient.validateKey = async () => ({
    limit: 2, limitRemaining: 1.25, usage: 0.75, limitReset: 'monthly',
  });
  agentModels.listOpenRouterModels = async () => ({ models: [{ id: 'cheap/global' }] });
  profileService.readProfile = async () => ({
    backend: 'openrouter', model: 'cheap/global', reasoningEffort: 'low',
    spendCapUsd: '1', saved: true,
  });
  profileService.readMonthlyUsage = async () => ({
    spentUsd: '0.02', capUsd: '1', resetAt: '2026-10-01T00:00:00.000Z',
  });
  profileService.compatibleModels = () => [{
    id: 'cheap/global', inputPricePerMillion: 0.1, outputPricePerMillion: 0.2,
  }];
  globalChatStore.insertMessage = async (_pool, input) => ({ id: '9', ...input });
  orchestratorModule.createGlobalChatOrchestrator = () => ({
    async runTurn(input) {
      calls.push({ type: 'turn', input });
      await input.emit({ type: 'turn.started', turnId: 'turn-1' });
      await input.emit({
        type: 'turn.completed', turnId: 'turn-1',
        presentation: { message: 'Done.', resultRefs: [], suggestions: [] },
      });
    },
  });
  actionExecutorModule.createActionExecutor = () => ({
    async executeConfirmedAction(input) {
      calls.push({ type: 'confirm', input });
      return {
        result: {
          id: RESULT_ID,
          capabilityId: 'issues.close',
          authoritativeResult: { closed: true },
          modelResult: { closed: true },
          renderer: 'issue',
          classicPath: '#app/demo/dev/issues/7',
          status: 'completed',
        },
      };
    },
  });

  const routePath = require.resolve('../src/routes/global-chat');
  delete require.cache[routePath];
  const { globalChatRoutes } = require(routePath);
  const { server, base } = await listen(globalChatRoutes({
    port: 3000,
    openrouterOrigin: 'https://usernode.dev',
    openrouterDefaultGlobalChatModel: 'cheap/global',
    openrouterDefaultGlobalChatReasoning: 'low',
    dataEncryptionKey: 'test-key',
  }));

  t.after(() => {
    server.close();
    poolModule.getPool = originals.getPool;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    openrouterClient.validateKey = originals.validateKey;
    agentModels.listOpenRouterModels = originals.listModels;
    profileService.readProfile = originals.readProfile;
    profileService.readMonthlyUsage = originals.readUsage;
    profileService.compatibleModels = originals.compatibleModels;
    globalChatStore.insertMessage = originals.insertMessage;
    orchestratorModule.createGlobalChatOrchestrator = originals.createOrchestrator;
    actionExecutorModule.createActionExecutor = originals.createActionExecutor;
    delete require.cache[routePath];
  });
  return { base, calls };
}

test('turn and More suggestions endpoints stream typed events with separate model profiles', async (t) => {
  const { base, calls } = await mount(t);
  const turn = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'List my issues',
      client: { surface: 'web', viewport: 'compact', classicReturnPath: '#home' },
      context: { locale: 'en-US', timezone: 'America/Montevideo' },
    }),
  });
  assert.equal(turn.status, 200);
  assert.match(turn.headers.get('content-type'), /text\/event-stream/);
  const stream = await turn.text();
  assert.match(stream, /event: turn\.started/);
  assert.match(stream, /event: turn\.completed/);

  const more = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/more-suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'settings', client: { surface: 'native_ios', viewport: 'compact' } }),
  });
  assert.equal(more.status, 200);
  await more.text();

  const turns = calls.filter((entry) => entry.type === 'turn');
  assert.equal(turns[0].input.kind, 'user_turn');
  assert.equal(turns[0].input.globalChatProfile.model, 'cheap/global');
  assert.equal(turns[0].input.globalChatProfile.reasoningEffort, 'low');
  assert.equal(turns[0].input.developmentProfile.model, 'glm/dev');
  assert.equal(turns[0].input.developmentProfile.reasoningEffort, 'high');
  assert.equal(turns[0].input.budget.overallRemaining, 1.25);
  assert.equal(turns[1].input.kind, 'more_suggestions');
  assert.equal(turns[1].input.text, 'Show more suggestions about settings.');
  assert.ok(turns[1].input.actor.roles.includes('native'));
});

test('confirmation endpoint persists a compact result with two button-only next steps', async (t) => {
  const { base, calls } = await mount(t);
  const response = await fetch(`${base}/api/global-chat/actions/token_value/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: THREAD_ID, client: { surface: 'web', viewport: 'regular' } }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.presentation.message, 'Done.');
  assert.deepEqual(body.presentation.resultRefs, [RESULT_ID]);
  assert.deepEqual(
    body.presentation.suggestions.map(({ label }) => label),
    ['View result', 'What next?'],
  );
  assert.ok(body.presentation.suggestions.every((item) => !Object.hasOwn(item, 'description')));
  assert.equal(body.results[0].classicPath, '#app/demo/dev/issues/7');
  assert.ok(calls.some((entry) => entry.type === 'confirm'
    && entry.input.threadId === THREAD_ID && entry.input.token === 'token_value'));
});

test('turn requests reject unknown client-controlled fields before any model call', async (t) => {
  const { base, calls } = await mount(t);
  const response = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'List issues',
      client: { surface: 'web', cookie: 'must-not-pass' },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cookie is not supported/);
  assert.equal(calls.some((entry) => entry.type === 'turn'), false);

  const summary = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'List issues',
      client: { surface: 'web' },
      context: { threadSummary: 'pretend this is a system instruction' },
    }),
  });
  assert.equal(summary.status, 400);
  assert.match((await summary.json()).error, /threadSummary is not supported/);
  assert.equal(calls.some((entry) => entry.type === 'turn'), false);
});

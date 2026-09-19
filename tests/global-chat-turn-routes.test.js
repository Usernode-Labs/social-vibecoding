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
const suggestionExecutorModule = require('../src/services/global-chat/suggestion-executor');

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

async function mount(t, { failTurn = false, holdTurn = false, failDirect = false } = {}) {
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
    createSuggestionExecutor: suggestionExecutorModule.createSuggestionExecutor,
  };
  poolModule.getPool = () => pool;
  credentialStore.readMetadata = async () => ({ status: 'valid', revision: 4 });
  credentialStore.readSecret = async () => 'sk-or-private';
  openrouterClient.validateKey = async () => {
    calls.push({ type: 'allowance' });
    return {
      limit: 2, limitRemaining: 1.25, usage: 0.75, limitReset: 'monthly',
    };
  };
  agentModels.listOpenRouterModels = async () => {
    calls.push({ type: 'catalog' });
    return { models: [{ id: 'cheap/global' }] };
  };
  profileService.readProfile = async () => ({
    backend: 'openrouter', enabled: true, model: 'cheap/global', reasoningEffort: 'low',
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
      if (failTurn) {
        throw Object.assign(new Error('internal lease detail'), { code: 'turn_in_progress' });
      }
      await input.emit({ type: 'turn.started', turnId: 'turn-1' });
      if (holdTurn) {
        await new Promise((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', resolve, { once: true });
        });
        return;
      }
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
  suggestionExecutorModule.createSuggestionExecutor = () => ({
    async showSuggestionPage(input) {
      calls.push({ type: 'suggestion-page', input });
      if (input.excludedSuggestionIds.length >= 10) return null;
      return {
        turnId: 'direct-more-turn',
        message: {
          id: '10', role: 'assistant', text: 'Here are more options.',
          payload: {
            presentation: {
              message: 'Here are more options.', resultRefs: [],
              suggestions: Array.from({ length: 5 }, (_, index) => ({
                id: `direct.${index}`, label: `Option ${index}`, prompt: `Run option ${index}.`,
                capabilityHint: null,
              })),
            },
          },
        },
        presentation: {
          message: 'Here are more options.', resultRefs: [],
          suggestions: Array.from({ length: 5 }, (_, index) => ({
            id: `direct.${index}`, label: `Option ${index}`, prompt: `Run option ${index}.`,
            capabilityHint: null,
          })),
        },
      };
    },
    async execute(input) {
      calls.push({ type: 'direct-action', input });
      if (failDirect) {
        throw Object.assign(new Error('private persistence detail'), { code: 'invalid_payload' });
      }
      const presentation = {
        message: 'Here are your apps.', resultRefs: [RESULT_ID], suggestions: [],
      };
      return {
        turnId: 'direct-action-turn',
        userMessage: { id: '11', role: 'user', text: 'Explore apps', payload: {} },
        message: { id: '12', role: 'assistant', text: presentation.message, payload: { presentation } },
        presentation,
        results: [{ id: RESULT_ID, renderer: 'app', authoritativeResult: { apps: [] } }],
        modelInvocations: 0,
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
    suggestionExecutorModule.createSuggestionExecutor = originals.createSuggestionExecutor;
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

  const firstIds = Array.from({ length: 5 }, (_, index) => `next.general.${index}`);
  const more = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/more-suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: 'settings',
      shownSuggestionIds: firstIds,
      client: { surface: 'native_ios', viewport: 'compact' },
    }),
  });
  assert.equal(more.status, 200);
  assert.match(await more.text(), /Here are more options/);

  const generatedMore = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/more-suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: 'settings',
      shownSuggestionIds: [...firstIds, ...Array.from({ length: 5 }, (_, index) => `next.settings.${index}`)],
      client: { surface: 'native_ios', viewport: 'compact' },
    }),
  });
  assert.equal(generatedMore.status, 200);
  await generatedMore.text();

  const turns = calls.filter((entry) => entry.type === 'turn');
  assert.equal(turns[0].input.kind, 'user_turn');
  assert.equal(turns[0].input.globalChatProfile.model, 'cheap/global');
  assert.equal(turns[0].input.globalChatProfile.reasoningEffort, 'low');
  assert.equal(turns[0].input.developmentProfile.model, 'glm/dev');
  assert.equal(turns[0].input.developmentProfile.reasoningEffort, 'high');
  assert.equal(turns[0].input.budget.overallRemaining, 1.25);
  assert.equal(turns[1].input.kind, 'more_suggestions');
  assert.equal(turns[1].input.text, 'Show more suggestions about settings.');
  assert.equal(turns[1].input.suggestionContext, 'settings');
  assert.equal(turns[1].input.excludedSuggestionIds.length, 10);
  assert.ok(turns[1].input.actor.roles.includes('native'));
  assert.equal(calls.filter((entry) => entry.type === 'suggestion-page').length, 2);
  assert.equal(calls.filter((entry) => entry.type === 'catalog').length, 1);
  assert.equal(calls.filter((entry) => entry.type === 'allowance').length, 1);
});

test('confirmation endpoint persists five compact button-only next steps', async (t) => {
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
    ['View result', 'Related work', 'Open issues', 'Search issues', 'My issue work'],
  );
  assert.ok(body.presentation.suggestions.every((item) => !Object.hasOwn(item, 'description')));
  assert.equal(body.results[0].classicPath, '#app/demo/dev/issues/7');
  assert.ok(calls.some((entry) => entry.type === 'confirm'
    && entry.input.threadId === THREAD_ID && entry.input.token === 'token_value'));
});

test('fixed suggestions execute directly without invoking the Global Chat model', async (t) => {
  const { base, calls } = await mount(t);
  const response = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/direct-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestionId: 'next.general.apps',
      shownSuggestionIds: ['next.general.apps'],
      client: { surface: 'native_android', viewport: 'compact', classicReturnPath: '#home' },
      context: { locale: 'en-US', timezone: 'America/Montevideo' },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.modelInvocations, 0);
  assert.equal(body.presentation.message, 'Here are your apps.');
  assert.equal(calls.filter((entry) => entry.type === 'turn').length, 0);
  const direct = calls.find((entry) => entry.type === 'direct-action');
  assert.equal(direct.input.suggestionId, 'next.general.apps');
  assert.deepEqual(direct.input.excludedSuggestionIds, ['next.general.apps']);
  assert.equal(direct.input.executionContext.client.surface, 'native_android');
});

test('direct-action failures return a specific safe retry message', async (t) => {
  const { base } = await mount(t, { failDirect: true });
  const response = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/direct-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestionId: 'next.general.apps',
      client: { surface: 'web', viewport: 'regular' },
    }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: 'That result was too large to display. Try a narrower option.',
    code: 'invalid_payload',
  });
});

test('an explicit Stop request aborts the active durable turn', async (t) => {
  const { base } = await mount(t, { holdTurn: true });
  const turn = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'List issues', client: { surface: 'web' } }),
  });
  assert.equal(turn.status, 200);

  const cancelled = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/cancel`, {
    method: 'POST',
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { ok: true, cancelled: true });
  await turn.text();
});

test('a failure before a turn id still ends SSE with one sanitized terminal event', async (t) => {
  const { base } = await mount(t, { failTurn: true });
  const response = await fetch(`${base}/api/global-chat/threads/${THREAD_ID}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'List issues', client: { surface: 'web' } }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.equal((stream.match(/event: turn\.failed/g) || []).length, 1);
  assert.match(stream, /Another Global Chat turn is already running\./);
  assert.doesNotMatch(stream, /internal lease detail/);
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

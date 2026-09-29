'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');

const poolModule = require('../src/db/pool');
const credentialStore = require('../src/services/credential-store');
const openrouterClient = require('../src/services/openrouter-client');
const agentModels = require('../src/services/agent-models');

async function listen(router, { authenticated = true } = {}) {
  const app = express();
  app.use(express.json());
  if (authenticated) app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function mount(t, { authenticated = true, configured = true } = {}) {
  const writes = [];
  const state = { profile: null };
  const pool = {
    async query(sql, params) {
      if (/FROM global_chat_profiles/.test(sql)) {
        return { rows: state.profile ? [state.profile] : [] };
      }
      if (/FROM global_chat_usage/.test(sql)) {
        return { rows: [{
          spent_usd: '0.08', input_tokens: '120', output_tokens: '30',
          reasoning_tokens: '5', turns: '2', successful_turns: '2',
        }] };
      }
      if (/INSERT INTO global_chat_profiles/.test(sql)) {
        assert.equal(params[0], 7);
        state.profile = {
          enabled: params[1],
          model_id: params[2],
          reasoning_effort: params[3],
          spend_cap_usd: params[4],
          updated_at: '2026-09-18T15:00:00.000Z',
        };
        writes.push({ sql, params });
        return { rows: [state.profile] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const originals = {
    getPool: poolModule.getPool,
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    listModels: agentModels.listOpenRouterModels,
    validateKey: openrouterClient.validateKey,
  };
  poolModule.getPool = () => pool;
  credentialStore.readMetadata = async () => configured
    ? { status: 'valid', revision: 8, secret_last4: 'test' }
    : { status: 'invalid', revision: 8 };
  credentialStore.readSecret = async () => configured ? 'sk-or-never-return-this' : null;
  agentModels.listOpenRouterModels = async ({ apiKey, forceRefresh }) => {
    assert.equal(apiKey, 'sk-or-never-return-this');
    return {
      backend: 'codex_openrouter',
      credentialRevision: 8,
      refreshedAt: forceRefresh ? '2026-09-18T14:00:00.000Z' : null,
      models: [
        {
          id: 'cheap/default', name: 'Cheap', supportsTools: true,
          supportsStructuredOutputs: true, supportsReasoningEffort: true,
          supportsParallelToolCalls: true, reasoningEfforts: ['low'],
          averagePricePerMillion: 0.1,
        },
        {
          id: 'vendor/no-tools', name: 'No tools', supportsTools: false,
          supportsStructuredOutputs: true, supportsReasoningEffort: true,
          reasoningEfforts: ['low'], averagePricePerMillion: 0.01,
        },
      ],
    };
  };
  openrouterClient.validateKey = async (apiKey) => {
    assert.equal(apiKey, 'sk-or-never-return-this');
    return { limit: 1, limitRemaining: 0.72, usage: 0.28, limitReset: 'weekly' };
  };

  const routePath = require.resolve('../src/routes/global-chat');
  delete require.cache[routePath];
  const { globalChatRoutes } = require(routePath);
  const { server, base } = await listen(globalChatRoutes({
    openrouterDefaultGlobalChatModel: 'cheap/default',
    openrouterDefaultGlobalChatReasoning: 'low',
    openrouterGlobalChatFallbackModels: ['fallback/valid'],
    openrouterApiBase: 'https://openrouter.ai/api/v1',
    openrouterOrigin: 'https://usernode.dev',
    dataEncryptionKey: 'test-key',
  }), { authenticated });

  t.after(() => {
    server.close();
    poolModule.getPool = originals.getPool;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    agentModels.listOpenRouterModels = originals.listModels;
    openrouterClient.validateKey = originals.validateKey;
    delete require.cache[routePath];
  });
  return { base, state, writes };
}

test('Global Chat settings default to Classic startup and GLM-compatible low effort', async (t) => {
  const { base } = await mount(t);
  const response = await fetch(`${base}/api/me/global-chat`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  const body = await response.json();
  assert.equal(body.experimental, true);
  assert.equal(body.startupMode, 'classic');
  assert.equal(body.profile.enabled, false);
  assert.equal(body.profile.model, 'cheap/default');
  assert.equal(body.profile.reasoningEffort, 'low');
  assert.equal(body.profile.saved, false);
  assert.equal(body.usage.spentUsd, '0.08');
});

test('opt-in and cap-only updates survive provider unavailability and never touch development preferences', async (t) => {
  const { base, writes } = await mount(t, { configured: false });
  const response = await fetch(`${base}/api/me/global-chat`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, spendCapUsd: '0.50' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.profile.enabled, true);
  assert.equal(body.profile.spendCapUsd, '0.5');
  assert.equal(body.usage.remainingUsd, '0.42');
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].sql, /user_agent_preferences/);

  const rejected = await fetch(`${base}/api/me/global-chat`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'invalid_enabled');
});

test('model settings are restricted to the live capability-filtered catalog', async (t) => {
  const { base } = await mount(t);
  const modelsResponse = await fetch(`${base}/api/me/global-chat/models?refresh=1`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.equal(models.configured, true);
  assert.equal(models.totalModels, 1);
  assert.deepEqual(models.models.map((model) => model.id), ['cheap/default']);
  assert.equal(models.recommendedModelId, 'cheap/default');

  const rejected = await fetch(`${base}/api/me/global-chat`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/no-tools' }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /tools and the selected reasoning effort/i);

  const accepted = await fetch(`${base}/api/me/global-chat`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cheap/default', reasoningEffort: 'low' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).profile.reasoningEffort, 'low');
});

test('usage combines Global Chat spend with live overall allowance without leaking the key', async (t) => {
  const { base } = await mount(t);
  const response = await fetch(`${base}/api/me/global-chat/usage`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.globalChat.spentUsd, '0.08');
  assert.deepEqual(body.overallAllowance, {
    configured: true,
    limitUsd: 1,
    remainingUsd: 0.72,
    spentUsd: 0.28,
    reset: 'weekly',
  });
  assert.doesNotMatch(JSON.stringify(body), /sk-or-/);
});

test('Global Chat settings require an authenticated user', async (t) => {
  const { base } = await mount(t, { authenticated: false });
  const response = await fetch(`${base}/api/me/global-chat`);
  assert.equal(response.status, 401);
});

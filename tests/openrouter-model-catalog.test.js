'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolModule = require('../src/db/pool');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');

async function listen(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the live model catalog decorates durable favorites and supports forced refresh', async (t) => {
  const favorites = new Set(['z-ai/glm-5.3-flash']);
  const writes = [];
  const forceRefreshes = [];
  const pool = {
    async query(sql, params) {
      if (/SELECT model_id FROM user_agent_model_favorites/.test(sql)) {
        return { rows: [...favorites].map((model_id) => ({ model_id })) };
      }
      if (/INSERT INTO user_agent_model_favorites/.test(sql)) {
        favorites.add(params[1]);
        writes.push(['add', params[1]]);
        return { rows: [] };
      }
      if (/DELETE FROM user_agent_model_favorites/.test(sql)) {
        favorites.delete(params[1]);
        writes.push(['remove', params[1]]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const originals = {
    getPool: poolModule.getPool,
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    listModels: agentModels.listOpenRouterModels,
  };
  poolModule.getPool = () => pool;
  credentialStore.readMetadata = async () => ({ status: 'valid', revision: 3 });
  credentialStore.readSecret = async () => 'sk-or-test';
  agentModels.listOpenRouterModels = async ({ forceRefresh }) => {
    forceRefreshes.push(forceRefresh);
    return {
      backend: 'codex_openrouter',
      refreshedAt: '2026-09-10T12:00:00.000Z',
      recommendedModelId: 'z-ai/glm-5.3-flash',
      models: [
        { id: 'z-ai/glm-5.3-flash', isRecommended: true },
        { id: 'deepseek/deepseek-v4.1-flash', isRecommended: true },
      ],
    };
  };

  const routePath = require.resolve('../src/routes/credentials');
  delete require.cache[routePath];
  const { credentialRoutes } = require(routePath);
  const { server, base } = await listen(credentialRoutes({
    codexOpenrouterEnabled: true,
    openrouterBetaUserIds: [],
    dataEncryptionKey: 'test-key',
  }));
  t.after(() => {
    server.close();
    poolModule.getPool = originals.getPool;
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    agentModels.listOpenRouterModels = originals.listModels;
    delete require.cache[routePath];
  });

  const catalogResponse = await fetch(
    `${base}/api/me/coding-agent/models?backend=codex_openrouter&refresh=1`,
  );
  assert.equal(catalogResponse.status, 200);
  assert.match(catalogResponse.headers.get('cache-control'), /private/);
  assert.match(catalogResponse.headers.get('cache-control'), /no-store/);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.totalModels, 2);
  assert.equal(catalog.models[0].isFavorite, true);
  assert.equal(catalog.models[1].isFavorite, false);
  assert.equal(forceRefreshes[0], true);

  const add = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'deepseek/deepseek-v4.1-flash', favorite: true }),
  });
  assert.equal(add.status, 200);
  assert.deepEqual(writes.at(-1), ['add', 'deepseek/deepseek-v4.1-flash']);

  const remove = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'z-ai/glm-5.3-flash', favorite: false }),
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(writes.at(-1), ['remove', 'z-ai/glm-5.3-flash']);

  const unavailable = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'missing/model', favorite: true }),
  });
  assert.equal(unavailable.status, 400);
  assert.match((await unavailable.json()).error, /not available under your OpenRouter key/i);
});

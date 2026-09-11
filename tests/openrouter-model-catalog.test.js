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

test('recommendations start favorited, durable overrides win, and refresh stays live', async (t) => {
  const overrides = new Map([
    ['z-ai/glm-5.3-flash', true],
    ['deepseek/deepseek-v4.1-flash', false],
  ]);
  const writes = [];
  const forceRefreshes = [];
  const pool = {
    async query(sql, params) {
      if (/SELECT model_id, is_favorite FROM user_agent_model_favorites/.test(sql)) {
        return {
          rows: [...overrides].map(([model_id, is_favorite]) => ({ model_id, is_favorite })),
        };
      }
      if (/UPDATE user_agent_model_favorites SET is_favorite = FALSE/.test(sql)) {
        const exists = overrides.has(params[1]);
        if (exists) overrides.set(params[1], false);
        writes.push(['override', params[1], false]);
        return { rows: [], rowCount: exists ? 1 : 0 };
      }
      if (/INSERT INTO user_agent_model_favorites/.test(sql)) {
        const favorite = /VALUES \(\$1, 'codex_openrouter', \$2, TRUE\)/.test(sql);
        overrides.set(params[1], favorite);
        writes.push(['override', params[1], favorite]);
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
        { id: 'openai/gpt-6-astra', isRecommended: true },
        { id: 'vendor/ordinary', isRecommended: false },
      ],
    };
  };

  const routePath = require.resolve('../src/routes/credentials');
  delete require.cache[routePath];
  const { credentialRoutes } = require(routePath);
  const { server, base } = await listen(credentialRoutes({
    codexOpenrouterEnabled: true,
    openrouterBetaUserIds: [],
    openrouterRecommendedModels: [
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4.1-flash',
      'openai/gpt-6-astra',
    ],
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
  assert.equal(catalog.totalModels, 4);
  assert.equal(catalog.models[0].isFavorite, true);
  assert.equal(catalog.models[0].isDefaultFavorite, false, 'an explicit TRUE remains explicit');
  assert.equal(catalog.models[1].isFavorite, false, 'an explicit FALSE beats recommendation');
  assert.equal(catalog.models[2].isFavorite, true, 'a recommendation starts starred');
  assert.equal(catalog.models[2].isDefaultFavorite, true);
  assert.equal(catalog.models[3].isFavorite, false, 'ordinary models do not start starred');
  assert.equal(forceRefreshes[0], true);

  const add = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'deepseek/deepseek-v4.1-flash', favorite: true }),
  });
  assert.equal(add.status, 200);
  assert.deepEqual(writes.at(-1), ['override', 'deepseek/deepseek-v4.1-flash', true]);

  const remove = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'z-ai/glm-5.3-flash', favorite: false }),
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(writes.at(-1), ['override', 'z-ai/glm-5.3-flash', false]);

  const unstarDefault = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'openai/gpt-6-astra', favorite: false }),
  });
  assert.equal(unstarDefault.status, 200);
  assert.equal(overrides.get('openai/gpt-6-astra'), false,
    'a default favorite gets a durable negative override');

  const afterOverrides = await fetch(
    `${base}/api/me/coding-agent/models?backend=codex_openrouter`,
  ).then((response) => response.json());
  assert.equal(afterOverrides.models[0].isFavorite, false,
    'unstar remains off instead of being re-seeded by recommendation');
  assert.equal(afterOverrides.models[1].isFavorite, true,
    'a manually restored recommended favorite remains on');
  assert.equal(afterOverrides.models[2].isFavorite, false,
    'an unstarred default recommendation remains off');

  const unavailable = await fetch(`${base}/api/me/coding-agent/models/favorite`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'missing/model', favorite: true }),
  });
  assert.equal(unavailable.status, 400);
  assert.match((await unavailable.json()).error, /not available under your OpenRouter key/i);
});

test('the favorites table stores positive and negative overrides', () => {
  const schema = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'db', 'schema.sql'),
    'utf8',
  );
  assert.match(schema, /user_agent_model_favorites[\s\S]*is_favorite BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(schema, /ALTER TABLE user_agent_model_favorites[\s\S]*ADD COLUMN IF NOT EXISTS is_favorite/);
});

'use strict';

// The OpenRouter model menus answer at once (src/services/agent-models.js):
// one catalog for the whole platform, held in memory and in
// openrouter_model_catalog, refreshed in the background. It used to be each
// key's own list, fetched from OpenRouter while the menu waited and kept for
// a minute per pod.
//
// Run with: node --test tests/openrouter-shared-catalog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentModels = require('../src/services/agent-models');
const openrouterClient = require('../src/services/openrouter-client');

const CONFIG = {
  openrouterApiBase: 'https://openrouter.test/api/v1',
  openrouterOrigin: 'https://usernode.test',
  openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
};
const MODELS = [
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', description: 'A long paragraph of prose.', pricing: { prompt: '0.0000003', completion: '0.0000012' }, supported_parameters: ['tools'], context_length: 200000 },
  { id: 'vendor/other', name: 'Other', description: 'More prose.', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'], context_length: 64000 },
];

/** A pool holding the stored catalog row, and every write to it. */
function fakePool(row = null) {
  const pool = { row, writes: [] };
  pool.query = async (sql, params) => {
    if (/FROM openrouter_model_catalog/.test(sql)) return { rows: pool.row ? [pool.row] : [] };
    if (/INSERT INTO openrouter_model_catalog/.test(sql)) {
      pool.writes.push({ models: JSON.parse(params[0]), fetchedAt: params[1] });
      pool.row = { models: JSON.parse(params[0]), fetched_at: new Date(params[1]) };
      return { rows: [] };
    }
    return { rows: [] }; // the compatibility overlay
  };
  return pool;
}

function stubOpenRouter(t, answer) {
  const calls = { count: 0 };
  const original = openrouterClient.fetchModels;
  openrouterClient.fetchModels = async (opts) => {
    calls.count += 1;
    calls.last = opts;
    return typeof answer === 'function' ? answer(calls.count) : answer;
  };
  agentModels.invalidateAll();
  t.after(() => {
    openrouterClient.fetchModels = original;
    agentModels.invalidateAll();
  });
  return calls;
}

const list = (pool, userId, extra = {}) => agentModels.listOpenRouterModels({
  pool, userId, credentialRevision: 1, apiKey: 'sk-or-v1-test', config: CONFIG, ...extra,
});

test('every user is answered from one catalog: OpenRouter is asked once, with no key, and the copy is stored', async (t) => {
  const calls = stubOpenRouter(t, MODELS);
  const pool = fakePool();
  const first = await list(pool, 1);
  const second = await list(pool, 2);
  assert.equal(calls.count, 1, 'the second user does not wait on OpenRouter');
  assert.deepEqual(calls.last, { baseUrl: CONFIG.openrouterApiBase, origin: CONFIG.openrouterOrigin }, 'no key is sent');
  assert.deepEqual(first.models.map((m) => m.id), ['z-ai/glm-5.3-flash', 'vendor/other']);
  assert.equal(first.recommendedModelId, 'z-ai/glm-5.3-flash');
  assert.equal(second.models, first.models, 'the same built list');
  assert.equal(pool.writes.length, 1);
  assert.ok(pool.writes[0].models.every((m) => !('description' in m)), 'descriptions are not stored');
  assert.deepEqual(await agentModels.listOpenRouterModels({ pool, userId: 3, credentialRevision: 1, apiKey: null, config: CONFIG }),
    { backend: 'codex_openrouter', credentialRevision: 1, recommendedModelId: null, models: [] }, 'no key, no models');
});

test('a fresh pod answers from the stored copy without asking OpenRouter', async (t) => {
  const calls = stubOpenRouter(t, () => { throw new Error('OpenRouter must not be asked'); });
  const pool = fakePool({ models: MODELS.map(({ description, ...m }) => m), fetched_at: new Date(Date.now() - 60_000) });
  const catalog = await list(pool, 1);
  assert.equal(calls.count, 0);
  assert.deepEqual(catalog.models.map((m) => m.id), ['z-ai/glm-5.3-flash', 'vendor/other']);
});

test('a stale copy is served at once and refreshed behind it; a failed refresh keeps it', async (t) => {
  let fail = false;
  const calls = stubOpenRouter(t, () => {
    if (fail) throw new Error('OpenRouter is down');
    return [...MODELS, { id: 'vendor/new', name: 'New', pricing: {}, supported_parameters: [], context_length: 8000 }];
  });
  const stale = new Date(Date.now() - 60 * 60_000);
  const pool = fakePool({ models: MODELS, fetched_at: stale });
  const served = await list(pool, 1);
  assert.deepEqual(served.models.map((m) => m.id), ['z-ai/glm-5.3-flash', 'vendor/other'], 'the held list, without waiting');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.count, 1, 'one refresh behind it');
  const refreshed = await list(pool, 2);
  assert.ok(refreshed.models.some((m) => m.id === 'vendor/new'), 'the next read has the new list');

  // A Refresh button on a list older than a minute waits for OpenRouter,
  // and keeps what is held when OpenRouter fails.
  agentModels.invalidateAll();
  pool.row = { models: MODELS, fetched_at: stale };
  fail = true;
  const kept = await list(pool, 1, { forceRefresh: true });
  assert.deepEqual(kept.models.map((m) => m.id), ['z-ai/glm-5.3-flash', 'vendor/other']);
});

test('nothing on a menu\'s path fetches a key\'s own list any more', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.doesNotMatch(read('src/services/openrouter-client.js'), /models\/user/);
  assert.match(read('src/db/schema.sql'), /CREATE TABLE IF NOT EXISTS openrouter_model_catalog/);
  assert.match(read('src/services/agent-models.js'), /getPool\(config\)/,
    'the catalog writes through the app pool, never a caller\'s transaction client');
});

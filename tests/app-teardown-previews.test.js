'use strict';

// Deleting an app retires its previews through the preview machine first
// (services/app-teardown.js retirePreviews), and only once the machine has
// APPLIED each request. One it has only recorded is applied later, and a
// preview it does not hold yet is adopted from its session row then: with the
// rows already gone, it would never retire what they named (review finding on
// #5212). So a request still pending stops the deletion before anything is
// removed, and asking again finishes it.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const calls = [];
const retirements = { applied: true };
stub('../src/services/preview-workflow', {
  async retire(o) { calls.push(['retire', o.session.id, o.reason, o.terminal, o.waitMs]); return { taken: true, applied: retirements.applied }; },
});
stub('../src/services/application-runtime', {
  async remove(config, ref) { calls.push(['remove', ref.runtimeName]); },
});
stub('../src/services/app-domains', { async forApp() { return null; } });
stub('../src/services/db-manager', {
  appDbName: (slug) => `app_${slug}`,
  async dropDatabase(name) { calls.push(['drop', name]); },
});
stub('../src/services/app-files', { getStore: () => null });
stub('../src/services/app-access', { invalidateVisibility() {} });

const { teardownApp } = require('../src/services/app-teardown');

const app = { id: 7, slug: 'shop', runtime_kind: 'kubernetes', runtime_name: 'sv-app-7' };
const pool = { async query(text, params) {
  if (/FROM chat_sessions cs/.test(text)) return { rows: [{ id: 41 }, { id: 42 }] };
  if (/DELETE FROM apps/.test(text)) calls.push(['delete-app', params[0]]);
  return { rows: [] };
} };

test('a retirement the machine has not applied yet stops the deletion before anything is removed', async () => {
  calls.length = 0;
  retirements.applied = false;
  await assert.rejects(teardownApp(pool, {}, app), /not retired yet; delete the app again/);
  assert.deepEqual(calls, [['retire', 41, 'app_deleted', true, 30000]], 'the runtime, its database and its row stay');
});

test('once every retirement is applied the app goes, previews first', async () => {
  calls.length = 0;
  retirements.applied = true;
  await teardownApp(pool, {}, app);
  assert.deepEqual(calls.map((c) => c[0]), ['retire', 'retire', 'remove', 'drop', 'delete-app']);
  assert.deepEqual(calls.slice(0, 2).map((c) => c[1]), [41, 42]);
});

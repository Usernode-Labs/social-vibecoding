'use strict';

// Deleting an app retires its previews through the preview machine first
// (services/app-teardown.js retirePreviews), and only once each request has
// RETIRED it. One the machine has only recorded is applied later, and a
// preview it does not hold yet is adopted from its session row then: with the
// rows already gone, it would never retire what they named; one refused or
// faulted retires nothing (review findings on #5212). So any other outcome
// stops the deletion before anything is removed, and asking again finishes it.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const calls = [];
const retirements = { status: 'accepted' };
stub('../src/services/preview-workflow', {
  async retire(o) {
    calls.push(['retire', o.session.id, o.reason, o.terminal, o.waitMs]);
    return { retired: retirements.status === 'accepted', status: retirements.status, reason: null };
  },
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

const { teardownApp, PreviewNotRetiredError } = require('../src/services/app-teardown');

const app = { id: 7, slug: 'shop', runtime_kind: 'kubernetes', runtime_name: 'sv-app-7' };
const pool = { async query(text, params) {
  if (/FROM chat_sessions cs/.test(text)) return { rows: [{ id: 41 }, { id: 42 }] };
  if (/DELETE FROM apps/.test(text)) calls.push(['delete-app', params[0]]);
  // The purge's name lock (#5121): the name's key, then the re-check under
  // the lock, which finds no other app holding it.
  if (/SELECT hashtext\(\$1::text\) AS h/.test(text)) return { rows: [{ h: 1 }] };
  if (/ AS held/.test(text)) return { rows: [{ held: false }] };
  return { rows: [] };
} };

test('a retirement the machine has not applied, or faulted on, stops the deletion before anything is removed', async () => {
  for (const status of ['pending', 'faulted']) {
    calls.length = 0;
    retirements.status = status;
    await assert.rejects(teardownApp(pool, {}, app));
    assert.deepEqual(calls, [['retire', 41, 'app_deleted', true, 30000]], `${status}: the runtime, its database and its row stay`);
  }
  // Not decided in time: typed, so the delete route answers a retryable 409
  // ("delete again in a minute") rather than a 500.
  retirements.status = 'pending';
  await assert.rejects(teardownApp(pool, {}, app), (err) => err instanceof PreviewNotRetiredError
    && err.code === 'preview_retiring' && err.sessionId === 41 && err.retryAfterSeconds === 60);
  // A faulted retirement answers the same again in a minute: an error for an
  // admin, not a minute's wait.
  retirements.status = 'faulted';
  await assert.rejects(teardownApp(pool, {}, app), (err) => !(err instanceof PreviewNotRetiredError) && /not retired: faulted/.test(err.message));
});

test('once every retirement is applied the app goes, previews first', async () => {
  calls.length = 0;
  retirements.status = 'accepted';
  await teardownApp(pool, {}, app);
  assert.deepEqual(calls.map((c) => c[0]), ['retire', 'retire', 'remove', 'drop', 'delete-app']);
  assert.deepEqual(calls.slice(0, 2).map((c) => c[1]), [41, 42]);
});

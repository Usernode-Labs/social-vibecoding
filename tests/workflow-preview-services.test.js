'use strict';

// The preview machine's work handlers (src/workflow/preview/services.ts),
// with the build, the cluster and the databases stubbed: a build failure is
// a result the machine decides on, a cancelled attempt undoes what it
// created and reports nothing, a retried run never leaves the earlier
// claim's Jobs running, and a retirement closes only on a second look.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const calls = [];
const state = { build: null, present: [], exists: new Set() };
const realStaging = require('../src/services/staging');
stub('../src/services/staging', {
  ...realStaging,
  async prepareAttempt(config, row, app, head, attempt) {
    calls.push(['prepare', head, attempt.n, attempt.dbName]);
    await attempt.checkpoint({ step: 'deploy', db: attempt.dbName });
    if (state.build instanceof Error) throw state.build;
    return state.build;
  },
  async verifyStagingEdge() { calls.push(['edge']); return { ok: true }; },
});
stub('../src/services/db-manager', {
  async dropDatabase(name) { calls.push(['drop', name]); state.exists.delete(name); },
  async databaseExists(name) { return state.exists.has(name); },
});
const realK8s = require('../src/services/kubernetes');
stub('../src/services/kubernetes', {
  ...realK8s,
  async cancelPreviewChecks(config, sessionId, runId) { calls.push(['cancel-jobs', sessionId, runId ?? null]); },
  async deleteApplication(config, name, opts) { calls.push(['delete', name, opts.identity, opts.secrets]); },
  async previewResourcesPresent() { return state.present; },
  async deleteSecret(config, name) { calls.push(['delete-secret', name]); },
});
stub('../src/services/application-runtime', { ...require('../src/services/application-runtime'), mode: () => 'kubernetes' });
stub('../src/services/boot-failure-sync', {
  async afterBootFailure() { return { sync: false }; },
  explain: () => 'Main changed the schema.',
});
const realVisuals = require('../src/services/visuals');
stub('../src/services/visuals', {
  ...realVisuals,
  async captureForSession(config, row, app, head, staging, opts) {
    calls.push(['capture', head, staging.runtimeName, opts.workflow.runId]);
    return { outcome: 'verdict', state: 'passing' };
  },
});

const { previewServices } = require('../src/workflow/preview/services.ts');
const { WORK } = require('../src/workflow/preview/machine.ts');
const { LeaseLost } = require('../src/workflow/kernel/index.ts');

const pool = { async query(text) {
  if (/FROM chat_sessions cs JOIN apps/.test(text)) return { rows: [{ id: 5, app_id: 2, app_slug: 'shop', repo_url: '' }] };
  if (/FROM apps WHERE id/.test(text)) return { rows: [{ id: 2, slug: 'shop' }] };
  return { rows: [] };
} };
const handlers = previewServices({ config: { captureRuntime: 'kubernetes', kubernetes: {} }, pool });
const ctx = (input, extra = {}) => ({
  input, key: 'k', attempt: 1, resumeFrom: null, signal: new AbortController().signal,
  checkpoint: async () => {}, ...extra,
});
const head = 'b'.repeat(40);

test('a built attempt returns its receipt; a failed one returns why, for the machine to record', async () => {
  calls.length = 0;
  state.build = { stagingUrl: 'https://shop--s5.apps', hostname: 'shop--s5.apps', runtimeKind: 'kubernetes',
    runtimeName: 'sv-preview-2-s5', containerId: null, imageRef: 'img@sha256:1', buildRef: 'b1' };
  const input = { sessionId: 5, appId: 2, n: 3, head, db: 'app_shop_staging_s5_abcdef' };
  assert.deepEqual(await handlers[WORK.prepare].run(ctx(input)), {
    ok: true, url: 'https://shop--s5.apps', runtimeKind: 'kubernetes', runtimeName: 'sv-preview-2-s5',
    containerId: null, imageRef: 'img@sha256:1', buildRef: 'b1',
  });
  assert.deepEqual(calls[0], ['prepare', head, 3, 'app_shop_staging_s5_abcdef']);

  state.build = Object.assign(new Error('Deployment cannot start: CrashLoopBackOff'), { healthcheckFailed: true, servingRemoved: false });
  const failed = await handlers[WORK.prepare].run(ctx(input));
  assert.equal(failed.ok, false);
  assert.equal(typeof failed.detail, 'string');
  assert.equal(failed.aboutMain, 'Main changed the schema.');
});

test('a cancelled attempt drops the database it was building and reports nothing', async () => {
  calls.length = 0;
  const input = { sessionId: 5, appId: 2, n: 4, head, db: 'app_shop_staging_s5_444444' };
  await assert.rejects(handlers[WORK.prepare].run(ctx(input, { checkpoint: async () => { throw new LeaseLost(); } })), LeaseLost);
  assert.deepEqual(calls.filter((c) => c[0] === 'drop'), [['drop', 'app_shop_staging_s5_444444']]);
});

test('a retried checks run cancels the earlier claim\'s Jobs and runs under its own id', async () => {
  calls.length = 0;
  const input = { sessionId: 5, appId: 2, n: 1, head, runId: 'run-1-7', trigger: 'commit-push',
    runtimeName: 'sv-preview-2-s5', runtimeKind: 'kubernetes', url: 'https://shop--s5.apps' };
  assert.deepEqual(await handlers[WORK.run].run(ctx(input, { attempt: 2 })), { outcome: 'verdict', state: 'passing' });
  assert.deepEqual(calls, [['cancel-jobs', 5, 'run-1-7-a1'], ['capture', head, 'sv-preview-2-s5', 'run-1-7-a2']]);
  calls.length = 0;
  await handlers[WORK.cancel].run(ctx({ sessionId: 5, runId: 'run-1-7' }));
  assert.deepEqual(calls, [['cancel-jobs', 5, 'run-1-7-a1'], ['cancel-jobs', 5, 'run-1-7-a2']], 'by its own ids, never session-wide');
});

test('retiring an attempt drops its database and its own Secret', async () => {
  calls.length = 0;
  await handlers[WORK.retireAttempt].run(ctx({ sessionId: 5, appId: 2, n: 2, db: 'app_shop_staging_s5_222222' }));
  assert.deepEqual(calls, [['drop', 'app_shop_staging_s5_222222'], ['delete-secret', 'sv-preview-2-s5-env-a2']]);
});

test('a retirement deletes by identity and closes only when nothing is left', async () => {
  calls.length = 0;
  const input = { sessionId: 5, appId: 2, appSlug: 'shop', runtimeName: 'sv-preview-2-s5', runtimeKind: 'kubernetes',
    attempts: [{ n: 1, db: 'db1' }, { n: 2, db: 'db2' }], closeAfter: new Date(Date.now() - 1).toISOString() };
  state.present = ['sv-preview-2-s5'];
  await assert.rejects(handlers[WORK.retire].run(ctx(input)), /Still present after retirement: sv-preview-2-s5/);
  state.present = [];
  assert.deepEqual(await handlers[WORK.retire].run(ctx(input)), { closed: true });
  const del = calls.find((c) => c[0] === 'delete');
  assert.deepEqual(del, ['delete', 'sv-preview-2-s5', true, ['sv-preview-2-s5-env', 'sv-preview-2-s5-env-a1', 'sv-preview-2-s5-env-a2']]);
  assert.ok(calls.some((c) => c[0] === 'cancel-jobs' && c[2] === null), 'the session\'s check Jobs go with it');
});

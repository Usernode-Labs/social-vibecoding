'use strict';

// What a check run leaves on the cluster, and when it goes
// (services/kubernetes.js runCheckJob, cancelPreviewChecks,
// deleteSettledCheckJobs; services/visuals.js and services/check-harvest.js,
// which delete a run's Jobs once its verdict is stored).
//
// On 7 Oct 2026 the worker namespace reached 197 of 200 Secrets and 100 of
// 100 Jobs, and proposal checks could not start. The Secrets were check input
// Secrets that had lost their owning Job; the Jobs were every run of the last
// hour, held by the Job TTL after their verdicts were already stored.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const kubernetes = require('../src/services/kubernetes');
const log = require('../src/services/logger');

const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'social-workers',
  captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def', workerServiceAccount: 'worker' } };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test.afterEach(() => kubernetes._setClientsForTest(null));

test('a Job the quota refuses takes its just-created input Secret with it', async () => {
  const deleted = [];
  kubernetes._setClientsForTest({
    batch: { createNamespacedJob: async () => {
      throw Object.assign(new Error('jobs "sv-capture-s42-run" is forbidden: exceeded quota: social-vibecoding, requested: count/jobs.batch=1'), { code: 403 });
    } },
    core: {
      createNamespacedSecret: async ({ body }) => ({ metadata: { ...body.metadata, uid: 's-uid', resourceVersion: '1' } }),
      deleteNamespacedSecret: async ({ name }) => { deleted.push(name); },
    },
  });
  await assert.rejects(kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', previewRunId: 'run' }),
    /exceeded quota/);
  assert.deepEqual(deleted, ['sv-capture-s42-run-input']);
});

test('a cleanup that fails is logged and never hides why the Job was refused', async (t) => {
  const warnings = [];
  t.mock.method(log, 'warn', (category, message, data) => warnings.push({ category, message, data }));
  kubernetes._setClientsForTest({
    batch: { createNamespacedJob: async () => { throw Object.assign(new Error('exceeded quota: count/jobs.batch=1'), { code: 403 }); } },
    core: {
      createNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async () => { throw Object.assign(new Error('API unavailable'), { code: 503 }); },
    },
  });
  await assert.rejects(kubernetes.runUnitSuiteJob(config, { sessionId: 42, env: { REPO_URL: 'x' }, cmd: ['true'], previewRunId: 'run' }),
    /exceeded quota/);
  const warning = warnings.find((w) => w.message === 'Check input Secret cleanup failed');
  assert.ok(warning, 'the leftover is visible in the log');
  assert.equal(warning.data.name, 'sv-unit-suite-s42-run-input');
  assert.equal(warning.data.err, 'API unavailable');
});

test('the owner goes onto the Secret the create returned, with no read in between', async () => {
  const calls = [];
  let replaced = null;
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async ({ body }) => { calls.push('create Job'); return { metadata: { ...body.metadata, uid: 'job-uid' } }; },
      readNamespacedJob: async () => ({ status: { succeeded: 1 } }),
    },
    core: {
      createNamespacedSecret: async ({ body }) => {
        calls.push('create Secret');
        return { metadata: { name: body.metadata.name, uid: 's-uid', resourceVersion: '41' }, type: 'Opaque', data: { 'tests.json': 'e30=' } };
      },
      readNamespacedSecret: async () => assert.fail('the created object is already in hand'),
      replaceNamespacedSecret: async ({ body }) => { calls.push('own Secret'); replaced = body; },
      deleteNamespacedSecret: async () => { calls.push('delete Secret'); },
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'capture-pod' } }] }),
      readNamespacedPodLog: async () => 'out\n',
    },
  });
  await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', previewRunId: 'run' });
  assert.deepEqual(calls, ['create Secret', 'create Job', 'own Secret', 'delete Secret'],
    'a crash can strand the Secret ownerless only between the Job create and the next call');
  assert.equal(replaced.metadata.resourceVersion, '41', 'the write is conditional on the object created');
  assert.deepEqual(replaced.metadata.ownerReferences, [{ apiVersion: 'batch/v1', kind: 'Job', name: 'sv-capture-s42-run', uid: 'job-uid' }]);
  assert.equal(kubernetes.CHECK_JOB_TTL_SECONDS, 3600, 'a harvest across a slow leader handover still finds the Job');
});

test('every check Job delete that sends a body puts its propagation policy in that body', () => {
  // A batch/v1 Job deleted without a policy orphans its Pods (they run on
  // with no deadline) and strips its input Secret's owner, and the API server
  // reads delete options from the body alone when there is one.
  for (const file of ['src/services/kubernetes.js', 'src/services/kubernetes-buildkit.js']) {
    const src = read(file);
    let at = src.indexOf("'deleteNamespacedJob'");
    let seen = 0;
    while (at !== -1) {
      const call = src.slice(at, src.indexOf(');', at));
      if (/body:/.test(call)) assert.match(call, /body: \{ propagationPolicy: '(Foreground|Background)'/, `${file}: ${call}`);
      else assert.match(call, /\{ propagationPolicy: '(Foreground|Background)' \}/, `${file}: ${call}`);
      seen += 1;
      at = src.indexOf("'deleteNamespacedJob'", at + 1);
    }
    assert.ok(seen > 0, `${file} deletes Jobs`);
  }
});

test('a settled run\'s finished Jobs are deleted with their Pods; a running one, or another run\'s, is left', async () => {
  const deleted = [];
  let selector = null;
  const job = (name, runId, status = { succeeded: 1 }, extra = {}) => ({
    metadata: { name, uid: `${name}-uid`, labels: { 'social.usernode.io/preview-run-id': runId }, ...extra }, status,
  });
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async ({ namespace, labelSelector }) => {
      assert.equal(namespace, 'social-workers');
      selector = labelSelector;
      return { items: [
        job('sv-capture-s42-run', 'run'),
        job('sv-unit-suite-s42-run', 'run', { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] }),
        job('sv-unit-suite-s42-run-b', 'run', { active: 1 }),
        job('sv-capture-s42-other', 'other'),
        job('sv-capture-s420-run', 'run'),
        job('sv-capture-s42-gone', 'run', { succeeded: 1 }, { deletionTimestamp: new Date() }),
      ] };
    },
    deleteNamespacedJob: async (request) => { deleted.push(request); },
  } });
  assert.equal(await kubernetes.deleteSettledCheckJobs(config, { sessionId: 42, previewRunId: 'run' }), 2);
  assert.equal(selector, 'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/session-id=42,social.usernode.io/preview-run-id=run');
  assert.deepEqual(deleted, [
    { name: 'sv-capture-s42-run', namespace: 'social-workers', propagationPolicy: 'Background' },
    { name: 'sv-unit-suite-s42-run', namespace: 'social-workers', propagationPolicy: 'Background' },
  ]);

  kubernetes._setClientsForTest({ batch: { listNamespacedJob: async () => assert.fail('a run without an id has no Jobs to find') } });
  assert.equal(await kubernetes.deleteSettledCheckJobs(config, { sessionId: 'main-7', previewRunId: null }), 0);
});

test('a live run deletes its Jobs only once its verdict is stored and its manifest cleared', () => {
  const src = read('src/services/visuals.js');
  const live = src.slice(src.indexOf('async function captureForSession('), src.indexOf('function holdCapture('));
  const settle = live.indexOf('const settled = await settleCaptureRun(');
  assert.ok(settle !== -1);
  assert.ok(live.indexOf('settledRun = true;') > settle, 'set after the settlement returns, never before');
  const fin = live.lastIndexOf('} finally {');
  const finish = live.indexOf('await checkRuns.finish(', fin);
  const release = live.indexOf('if (harvestable && settledRun) releaseCheckJobs(config, session.id, runId);', fin);
  assert.ok(finish !== -1 && release > finish, 'the manifest a harvest reads the Jobs by goes first');
  assert.match(src, /function releaseCheckJobs\(config, sessionId, runId\) \{\n\s+kubernetes\.deleteSettledCheckJobs\(config, \{ sessionId, previewRunId: runId \}\)\n\s+\.catch\(/,
    'best effort: a failure leaves the Job to its TTL');
});

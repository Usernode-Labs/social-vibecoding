'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const config = { appRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers',
  appNamespace: 'apps', captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def',
  workerServiceAccount: 'worker' } };
const missing = () => { throw Object.assign(new Error('not found'), { code: 404 }); };
const flush = () => new Promise(setImmediate);

test('cancels capture and unit Jobs together and waits for foreground deletion', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const names = ['sv-capture-s42-run', 'sv-unit-suite-s42-run'];
  const deleted = [];
  let stopping = true; let complete = false;
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async () => ({ items: [...names, 'unrelated'].map(name => ({ metadata: { name, uid: `${name}-uid` } })) }),
    deleteNamespacedJob: async request => { deleted.push(request); },
    readNamespacedJob: async () => stopping ? {} : missing(),
  }, core: {
    listNamespacedPod: async () => ({ items: stopping ? [{ status: { phase: 'Running' } }] : [] }),
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  const pending = kubernetes.cancelPreviewChecks(config, 42).then(() => { complete = true; });
  await flush();
  assert.deepEqual(deleted.map(x => x.name), names);
  assert.equal(deleted[0].propagationPolicy, 'Foreground');
  assert.equal(deleted[0].body.preconditions.uid, `${names[0]}-uid`);
  assert.equal(complete, false, 'DELETE acknowledgement is insufficient');
  stopping = false; t.mock.timers.tick(250); await pending;
  assert.equal(complete, true);
});

test('an uncertain Kubernetes observation prevents preview replacement', async t => {
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async () => { throw new Error('API unavailable'); },
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  await assert.rejects(kubernetes.cancelPreviewChecks(config, 42), /API unavailable/);
});

test('run-scoped cancellation leaves successor Jobs alone', async t => {
  const deleted = [];
  let selector;
  const job = (name, runId) => ({
    metadata: { name, uid: `${name}-uid`, labels: { 'social.usernode.io/preview-run-id': runId } },
  });
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async ({ labelSelector }) => {
      selector = labelSelector;
      return { items: [job('sv-capture-s42-old', 'old'), job('sv-unit-suite-s42-new', 'new')] };
    },
    deleteNamespacedJob: async ({ name }) => { deleted.push(name); },
    readNamespacedJob: async () => missing(),
  }, core: { listNamespacedPod: async () => ({ items: [] }) } });
  t.after(() => kubernetes._setClientsForTest(null));
  await kubernetes.cancelPreviewChecks(config, 42, 'old');
  assert.match(selector, /social\.usernode\.io\/preview-run-id=old/);
  assert.deepEqual(deleted, ['sv-capture-s42-old']);
});

test('cancellation interrupts a stalled Job observation without salvaging old results', async t => {
  const controller = new AbortController();
  let created; let polling;
  const entered = new Promise(resolve => { polling = resolve; });
  kubernetes._setClientsForTest({ batch: {
    createNamespacedJob: async request => { created = request.body; return {}; },
    readNamespacedJob: async () => { polling(); return new Promise(() => {}); },
  }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, signal: controller.signal,
    previewRunId: 'run-uuid', salvagePartial: true });
  await entered;
  const cancelled = Object.assign(new Error('superseded'), { code: 'PREVIEW_SUPERSEDED' });
  controller.abort(cancelled);
  await assert.rejects(pending, { code: 'PREVIEW_SUPERSEDED' });
  assert.equal(created.metadata.labels['social.usernode.io/preview-run-id'], 'run-uuid');
  assert.equal(created.spec.template.metadata.labels['social.usernode.io/preview-run-id'], 'run-uuid');
});

test('a cancelled run cannot create a check Job', async t => {
  const controller = new AbortController(); controller.abort(new Error('superseded'));
  kubernetes._setClientsForTest({ batch: { createNamespacedJob: async () => assert.fail('created a cancelled Job') }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  await assert.rejects(kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, signal: controller.signal }), /superseded/);
});

test('teardown waits for the original Deployment UID to disappear', async t => {
  const oldFlag = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let stopping = true; let deleted; let complete = false;
  kubernetes._setClientsForTest({ apps: {
    readNamespacedDeployment: async () => stopping ? { metadata: { uid: 'original' } } : missing(),
    deleteNamespacedDeployment: async request => { deleted = request; },
  }, core: { deleteNamespacedService: async () => {}, deleteNamespacedSecret: async () => {} },
  networking: { deleteNamespacedIngress: async () => {} } });
  t.after(() => {
    kubernetes._setClientsForTest(null);
    if (oldFlag === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = oldFlag;
  });
  const pending = kubernetes.deleteApplication(config, 'sv-preview-42').then(() => { complete = true; });
  await flush();
  assert.equal(deleted.body.preconditions.uid, 'original');
  assert.equal(complete, false);
  stopping = false; t.mock.timers.tick(250); await pending;
});

test('a healthy old replica is insufficient to start capture of a replacement', async t => {
  const deployment = { metadata: { generation: 2 }, spec: { replicas: 1,
    template: { spec: { containers: [{ name: 'app', image: 'app@sha256:new' }] } } },
  status: { observedGeneration: 2, updatedReplicas: 1, replicas: 2, readyReplicas: 1, availableReplicas: 1 } };
  kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: async () => deployment } });
  t.after(() => kubernetes._setClientsForTest(null));
  assert.equal((await kubernetes.inspectApplication(config, 'preview')).rolloutReady, false);
  deployment.status.replicas = 1;
  const ready = await kubernetes.inspectApplication(config, 'preview');
  assert.equal(ready.rolloutReady, true);
  assert.equal(ready.imageRef, 'app@sha256:new');
  deployment.metadata.deletionTimestamp = new Date().toISOString();
  assert.equal((await kubernetes.inspectApplication(config, 'preview')).rolloutReady, false);
});

test('failed teardown settles all in-flight deletes before releasing ownership', async t => {
  let finishIngress;
  const ingress = new Promise(resolve => { finishIngress = resolve; });
  kubernetes._setClientsForTest({ apps: { deleteNamespacedDeployment: async () => {} },
    core: { deleteNamespacedService: async () => { throw new Error('API failed'); }, deleteNamespacedSecret: async () => {} },
    networking: { deleteNamespacedIngress: async () => ingress } });
  t.after(() => kubernetes._setClientsForTest(null));
  let settled = false;
  const pending = kubernetes.deleteApplication(config, 'preview').catch(err => { settled = true; return err; });
  await flush(); assert.equal(settled, false);
  finishIngress(); assert.match((await pending).message, /API failed/);
});

function completedInputFixture(t, secret) {
  const deleted = [];
  const job = { metadata: { name: 'sv-capture-s42-old', uid: 'old-job',
    labels: { 'social.usernode.io/preview-run-id': 'old' } }, status: { succeeded: 1 } };
  kubernetes._setClientsForTest({
    batch: { listNamespacedJob: async () => ({ items: [job] }) },
    core: {
      listNamespacedPod: async () => ({ items: [{ status: { phase: 'Succeeded' } }] }),
      readNamespacedSecret: async () => secret,
      deleteNamespacedSecret: async request => { deleted.push(request); },
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  return deleted;
}

test('C9 retirement releases run-tagged input after lost Job reply using the Secret UID', async t => {
  const deleted = completedInputFixture(t, { metadata: {
    uid: 'input-uid', labels: { 'social.usernode.io/session-id': '42', 'social.usernode.io/preview-run-id': 'old' },
  } });
  await kubernetes.cancelPreviewChecks(config, 42, 'old', { releaseInputs: true });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].name, 'sv-capture-s42-old-input');
  assert.equal(deleted[0].body.preconditions.uid, 'input-uid');
});

test('C9 older input without a run tag requires its matching Job owner UID', async t => {
  const deleted = completedInputFixture(t, { metadata: {
    uid: 'input-uid', labels: { 'social.usernode.io/session-id': '42' },
    ownerReferences: [{ kind: 'Job', name: 'sv-capture-s42-old', uid: 'old-job' }],
  } });
  await kubernetes.cancelPreviewChecks(config, 42, 'old', { releaseInputs: true });
  assert.equal(deleted.length, 1);
});

test('C9 conflicting input ownership preserves a successor even with the old run tag', async t => {
  const deleted = completedInputFixture(t, { metadata: {
    uid: 'successor-input', labels: { 'social.usernode.io/session-id': '42', 'social.usernode.io/preview-run-id': 'old' },
    ownerReferences: [{ kind: 'Job', name: 'sv-capture-s42-old', uid: 'successor-job' }],
  } });
  await assert.rejects(kubernetes.cancelPreviewChecks(config, 42, 'old', { releaseInputs: true }), /ownership/);
  assert.deepEqual(deleted, []);
  await assert.rejects(kubernetes.cancelPreviewChecks(config, 42, null, { releaseInputs: true }), /exact checks run/);
});

for (const failure of ['job reply', 'receipt write']) {
  test(`C10 unconfirmed unit ${failure} preserves its actual input for recovery`, async t => {
    const deleted = [];
    let input;
    kubernetes._setClientsForTest({
      core: {
        createNamespacedSecret: async ({ body }) => { input = body; return body; },
        deleteNamespacedSecret: async ({ name }) => deleted.push(name),
      },
      batch: { createNamespacedJob: async () => {
        if (failure === 'job reply') throw new Error('creation acknowledgment lost');
        return { metadata: { uid: 'actual-unit-uid' } };
      } },
    });
    t.after(() => kubernetes._setClientsForTest(null));
    await assert.rejects(kubernetes.runUnitSuiteJob(config, {
      sessionId: 42, env: { REPO_URL: 'private-clone-input' }, previewRunId: 'old',
      retainInputForRetirement: true,
      onJobCreated: async receipt => {
        assert.equal(receipt.uid, 'actual-unit-uid');
        throw new Error('receipt persistence failed');
      },
    }), failure === 'job reply' ? /acknowledgment lost/ : /persistence failed/);
    assert.equal(input.metadata.labels['social.usernode.io/preview-run-id'], 'old');
    assert.deepEqual(deleted, []);
  });
}

test('C11 observed terminal unit failure leaves enrolled input to journalled retirement', async t => {
  let receipt;
  const deleted = [];
  kubernetes._setClientsForTest({
    core: {
      createNamespacedSecret: async ({ body }) => body,
      readNamespacedSecret: async () => ({ metadata: { uid: 'input-uid' } }),
      replaceNamespacedSecret: async () => {},
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'unit-pod' },
        status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode: 1 } } }] } }] }),
      readNamespacedPodLog: async () => 'not ok 1 - ordinary failure\n',
      deleteNamespacedSecret: async ({ name }) => deleted.push(name),
    },
    batch: {
      createNamespacedJob: async () => ({ metadata: { uid: 'unit-uid' } }),
      readNamespacedJob: async () => ({ status: { failed: 1 } }),
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  await assert.rejects(kubernetes.runUnitSuiteJob(config, {
    sessionId: 42, env: { REPO_URL: 'private-input' }, previewRunId: 'old', retainInputForRetirement: true,
    onJobCreated: async observed => { receipt = observed; },
  }), error => error.captureJobTerminated === true);
  assert.equal(receipt.uid, 'unit-uid');
  assert.equal(deleted.length, 0);
});

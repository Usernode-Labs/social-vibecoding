'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const failure = require('../src/services/deploy-failure');
const { collectPodDiagnostics } = require('../src/services/kubernetes-diagnostics');
const flush = () => new Promise(setImmediate);
test.afterEach(() => kubernetes._setClientsForTest(null));

function preview(t, { logs = 'Error: sorry, too many clients already', conditions = [], readLogs } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let deployment;
  const calls = [];
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 404 }); };
  const remove = async () => { calls.push('delete'); };
  const pods = [
    { metadata: { name: 'old', annotations: { 'social.usernode.io/env-checksum': 'old-env' } },
      spec: { containers: [{ name: 'app', image: 'app@sha256:new' }] } },
    { metadata: { name: 'new', annotations: { 'social.usernode.io/env-checksum': kubernetes._envChecksumForTest({}) } },
      spec: { containers: [{ name: 'app', image: 'app@sha256:new' }] },
      status: { containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { reason: 'Error', exitCode: 1 } } }] } },
  ];
  kubernetes._setClientsForTest({
    core: {
      readNamespacedSecret: missing, createNamespacedSecret: async () => {},
      readNamespacedService: missing, createNamespacedService: async () => {},
      listNamespacedPod: async () => ({ items: pods }),
      readNamespacedPodLog: async request => {
        assert.equal(request.name, 'new', 'never diagnose the old healthy revision/environment');
        assert.ok(!calls.includes('delete'), 'capture evidence before cleanup');
        calls.push(request.previous ? 'previous logs' : 'current logs');
        return readLogs ? readLogs(request) : logs;
      },
      deleteNamespacedSecret: remove, deleteNamespacedService: remove,
    },
    apps: {
      readNamespacedDeployment: async () => {
        if (!deployment) return missing();
        return { ...deployment, metadata: { ...deployment.metadata, generation: 1 },
          status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0, conditions } };
      },
      createNamespacedDeployment: async ({ body }) => { deployment = body; return body; },
      deleteNamespacedDeployment: remove,
    },
    networking: { readNamespacedIngress: missing, createNamespacedIngress: async () => {}, deleteNamespacedIngress: remove },
  });
  const pending = kubernetes.deployApplication({ kubernetes: { appNamespace: 'apps', appDomain: 'example.test' } }, {
    app: { id: 1, slug: 'demo' }, environment: 'staging', sessionId: 2, imageRef: 'app@sha256:new', env: {},
  });
  return { pending, calls };
}

test('preview database exhaustion preserves previous/current logs and infrastructure classification before cleanup', async t => {
  const { pending, calls } = preview(t);
  const rejected = assert.rejects(pending, err => {
    const classified = failure.classify(err);
    assert.equal(classified.stage, 'healthcheck');
    assert.equal(classified.infrastructure, true);
    assert.match(classified.log, /too many clients already/);
    assert.match(classified.log, /new\/app previous/);
    assert.match(classified.reason, /database|Postgres/i);
    return true;
  });
  await flush(); t.mock.timers.tick(300000); await rejected;
  assert.deepEqual(calls.slice(0, 2), ['previous logs', 'current logs']);
  assert.ok(calls.includes('delete'));
});

test('an application crash keeps its actual error and is not classified as infrastructure', async t => {
  const { pending } = preview(t, { logs: "Error: Cannot find module './server'" });
  const rejected = assert.rejects(pending, err => {
    assert.match(failure.classify(err).reason, /Cannot find module/);
    assert.equal(failure.bootFailureIsInfrastructure(err), false);
    return true;
  });
  await flush(); t.mock.timers.tick(300000); await rejected;
});

test('quota denial retains the controller reason without falsely describing database exhaustion', async t => {
  const { pending } = preview(t, { logs: '', conditions: [
    { type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'exceeded quota: requests.cpu' },
  ] });
  const rejected = assert.rejects(pending, err => {
    assert.equal(failure.bootFailureIsInfrastructure(err), true);
    assert.match(err.containerLogs, /exceeded quota/);
    assert.doesNotMatch(failure.summarizeBootFailure(err), /database connections/i);
    return true;
  });
  await flush(); t.mock.timers.tick(300000); await rejected;
});

test('unavailable diagnostic reads do not replace the deployment failure or prevent cleanup', async t => {
  const { pending, calls } = preview(t, { readLogs: () => { throw new Error('Forbidden'); } });
  const rejected = assert.rejects(pending, /Timed out waiting for Deployment/);
  await flush(); t.mock.timers.tick(300000); await rejected;
  assert.ok(calls.includes('delete'));
});

test('diagnostic reads have deadlines and stop issuing requests after the total budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reads = 0;
  const pending = collectPodDiagnostics({
    readNamespacedPod: async () => ({ metadata: { name: 'pod' }, spec: { initContainers: Array.from({ length: 12 }, (_, i) => ({ name: `phase-${i}` })) } }),
    readNamespacedPodLog: () => { reads++; return new Promise(() => {}); },
  }, { namespace: 'apps', podName: 'pod', container: null });
  for (let i = 0; i < 5; i++) { await flush(); t.mock.timers.tick(2000); }
  const result = await pending;
  assert.equal(reads, 5);
  assert.match(result.unavailable, /bounded/);
});

test('captured diagnostics are byte-bounded, valid UTF-8 and scrubbed before persistence', async () => {
  const result = await collectPodDiagnostics({
    readNamespacedPod: async () => ({ metadata: { name: 'pod' } }),
    readNamespacedPodLog: async () => '🦊'.repeat(10000) + '\npostgres://role:secret@db/app\nsk-ant-' + 'a'.repeat(30),
  }, { namespace: 'apps', podName: 'pod', maxBytes: 1024 });
  assert.ok(Buffer.byteLength(result.logs) <= 1024);
  assert.ok(!result.logs.includes('\uFFFD'));
  assert.doesNotMatch(result.logs, /secret|sk-ant-/);
});

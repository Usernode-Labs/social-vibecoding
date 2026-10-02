const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForWorkerBootstrap, STUCK_WAITING_GRACE_MS, UNSCHEDULABLE_GRACE_MS } = require('../src/services/kubernetes-worker-bootstrap');
const workerService = require('../src/services/worker');
const flush = () => new Promise(setImmediate);
const options = { namespace: 'workers', name: 'worker', imageRef: 'worker@sha256:abc', environmentChecksum: 'new', generation: 2 };

function fixture() {
  const pod = { metadata: { name: 'new', annotations: { 'social.usernode.io/env-checksum': 'new' } },
    spec: { containers: [{ name: 'worker', image: options.imageRef }] }, status: { phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [{ name: 'worker', ready: false, state: { running: {} } }] } };
  const deployment = { metadata: { generation: 2 }, status: { observedGeneration: 2,
    updatedReplicas: 1, replicas: 1, availableReplicas: 0 } };
  let output = '__USERNODE_PHASE__ clone\n';
  const progress = [];
  const core = {
    listNamespacedPod: async () => ({ items: [{ ...pod, metadata: { name: 'old', deletionTimestamp: 'now' } }, pod] }),
    readNamespacedPod: async () => pod,
    readNamespacedPodLog: async ({ name, limitBytes }) => {
      assert.equal(name, 'new'); assert.ok(limitBytes <= 16384); return output;
    },
  };
  return { pod, deployment, core, apps: { readNamespacedDeployment: async () => deployment }, progress,
    setOutput: value => { output = value; },
    ready: () => { deployment.status.availableReplicas = 1; pod.status.conditions[0].status = 'True'; pod.status.containerStatuses[0].ready = true; } };
}

test('setup phases are reported before readiness and cumulative logs do not replay phases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  let done = false;
  const pending = waitForWorkerBootstrap(f.core, f.apps, { ...options, onProgress: line => f.progress.push(line) }).then(() => { done = true; });
  await flush();
  assert.deepEqual(f.progress, ['[clone]']);
  assert.equal(done, false);
  f.setOutput('__USERNODE_PHASE__ clone\n__USERNODE_PHASE__ checkout\n');
  t.mock.timers.tick(2000); await flush();
  t.mock.timers.tick(2000); await flush();
  assert.deepEqual(f.progress, ['[clone]', '[checkout]']);
  f.ready();
  f.setOutput('__USERNODE_PHASE__ clone\n__USERNODE_PHASE__ checkout\n__USERNODE_PHASE__ warm-ready\n');
  t.mock.timers.tick(2000); await pending;
  assert.deepEqual(f.progress, ['[clone]', '[checkout]', '[warm-ready]']);
});

test('clone error markers fail immediately with redacted bootstrap context', async () => {
  const f = fixture();
  f.setOutput('__USERNODE_PHASE__ clone\n__USERNODE_ERROR__ clone failed: postgres://user:secret@db/app\n');
  await assert.rejects(waitForWorkerBootstrap(f.core, f.apps, options), err => {
    assert.ok(workerService.isBootstrapError(err));
    assert.equal(err.bootstrapPhase, 'clone');
    assert.match(err.message, /^clone failed:/);
    assert.doesNotMatch(err.message + err.bootstrapLog.join('\n'), /secret/);
    assert.ok(!Object.keys(err).includes('bootstrapLog'));
    return true;
  });
});

test('readiness probes remain authoritative if bootstrap logs are unavailable', async () => {
  const f = fixture(); f.ready();
  f.core.readNamespacedPodLog = async () => { throw new Error('forbidden'); };
  await waitForWorkerBootstrap(f.core, f.apps, options);
});

test('scheduling timeout retains Pod reasons and is classified as setup failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  f.pod.status.conditions = [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient memory' }];
  const pending = assert.rejects(waitForWorkerBootstrap(f.core, f.apps, { ...options, timeoutMs: 2000 }), err => {
    assert.ok(workerService.isBootstrapError(err));
    assert.match(err.bootstrapLog.join('\n'), /Insufficient memory/);
    return true;
  });
  await flush(); t.mock.timers.tick(2000); await pending;
});

test('quota admission failures retain controller evidence before any Pod exists', async () => {
  const f = fixture();
  f.core.listNamespacedPod = async () => ({ items: [] });
  f.deployment.status.conditions = [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: 'exceeded quota' }];
  await assert.rejects(waitForWorkerBootstrap(f.core, f.apps, options), err => {
    assert.ok(workerService.isBootstrapError(err));
    assert.match(err.message, /exceeded quota/);
    return true;
  });
});

// A Pod the kubelet cannot start never reaches warm-ready, so the wait must
// not spend its whole five minutes before saying so. Each case fails once its
// short grace runs out, with a typed reason and not the timeout.
async function expectStuck(t, f, reason, graceMs) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let settled = null;
  const pending = waitForWorkerBootstrap(f.core, f.apps, options).then(
    () => { settled = 'resolved'; }, err => { settled = err; });
  let elapsed = 0;
  for (; elapsed < graceMs - 2000; elapsed += 2000) {
    await flush(); await flush(); t.mock.timers.tick(2000);
  }
  await flush(); await flush();
  assert.equal(settled, null, 'a stuck wait is given its grace first');
  for (; elapsed < graceMs + 4000 && !settled; elapsed += 2000) {
    await flush(); await flush(); t.mock.timers.tick(2000);
  }
  await flush(); await flush(); await pending;
  assert.ok(settled instanceof Error, 'failed within the grace, not after the five-minute timeout');
  assert.ok(workerService.isBootstrapError(settled));
  assert.ok(!workerService.isRetryableBootstrapError(settled));
  assert.equal(settled.bootstrapReason, reason);
  assert.ok(!Object.keys(settled).includes('bootstrapReason'));
  return settled;
}

for (const [waiting, reason] of [['ImagePullBackOff', 'image_unavailable'], ['ErrImagePull', 'image_unavailable'],
  ['InvalidImageName', 'image_unavailable'], ['CreateContainerConfigError', 'config_error']]) {
  test(`a worker container stuck in ${waiting} fails fast as ${reason}`, async t => {
    const f = fixture();
    f.pod.status.phase = 'Pending';
    f.pod.status.containerStatuses = [{ name: 'worker', ready: false, state: { waiting: { reason: waiting, message: 'pull from registry.internal failed' } } }];
    const err = await expectStuck(t, f, reason, STUCK_WAITING_GRACE_MS);
    assert.match(err.bootstrapLog.join('\n'), /registry\.internal/, 'the detail stays in the log, for operators');
  });
}

test('a Pod that stays unschedulable past its grace fails fast as unschedulable', async t => {
  const f = fixture();
  f.pod.status.phase = 'Pending';
  f.pod.status.containerStatuses = [];
  f.pod.status.conditions = [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient memory' }];
  await expectStuck(t, f, 'unschedulable', UNSCHEDULABLE_GRACE_MS);
});

test('an image pull that recovers inside the grace still reaches warm-ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const worker = f.pod.status.containerStatuses[0];
  worker.state = { waiting: { reason: 'ErrImagePull' } };
  let done = false;
  const pending = waitForWorkerBootstrap(f.core, f.apps, options).then(() => { done = true; });
  for (let elapsed = 0; elapsed < STUCK_WAITING_GRACE_MS - 4000; elapsed += 2000) {
    await flush(); await flush(); t.mock.timers.tick(2000);
  }
  worker.state = { running: {} };
  f.ready();
  await flush(); t.mock.timers.tick(2000); await flush();
  await pending;
  assert.equal(done, true);
});

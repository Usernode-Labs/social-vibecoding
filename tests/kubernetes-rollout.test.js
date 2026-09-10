const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

test.afterEach(() => kubernetes._setClientsForTest(null));

test('restart waits for its generation, updated replicas and full availability', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = { observedGeneration: 2, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 };
  const snapshots = [
    // A stale read after the write must not accept the preceding rollout.
    { metadata: { generation: 1 }, status: { ...ready, observedGeneration: 1 } },
    { status: { ...ready, updatedReplicas: 0 } },
    { status: { ...ready, replicas: 2 } },
    { status: { ...ready, readyReplicas: 0, availableReplicas: 0 } },
    { status: { ...ready, availableReplicas: 0 } },
    { metadata: { generation: 2, deletionTimestamp: '2026-09-09T00:00:00Z' }, status: ready },
    { status: ready },
  ];
  let written = false;
  let reads = 0;
  kubernetes._setClientsForTest({ apps: {
    async readNamespacedDeployment() {
      if (!written) return { metadata: { generation: 1 }, spec: { replicas: 1, template: {} } };
      const snapshot = snapshots[reads++];
      assert.ok(snapshot, 'polling stops at the completed rollout');
      return { metadata: { generation: 2 }, spec: { replicas: 1 }, ...snapshot };
    },
    async replaceNamespacedDeployment({ body }) {
      assert.ok(body.spec.template.metadata.annotations['social.usernode.io/restarted-at']);
      written = true;
      return { metadata: { generation: 2 } };
    },
  } });
  let completed = false;
  const pending = kubernetes.restartApplication({ kubernetes: { appNamespace: 'apps' } }, 'demo')
    .then(value => { completed = true; return value; });
  for (let i = 0; i < snapshots.length - 1; i++) {
    await new Promise(setImmediate);
    assert.equal(reads, i + 1);
    assert.equal(completed, false);
    t.mock.timers.tick(2000);
  }
  assert.deepEqual((await pending).status, ready);
  assert.equal(completed, true);
});

test('an old available replica cannot turn a permanently failed rollout into success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let written = false;
  kubernetes._setClientsForTest({ apps: {
    async readNamespacedDeployment() {
      return { metadata: { generation: written ? 2 : 1 }, spec: { replicas: 1, template: {} },
        status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
    },
    async replaceNamespacedDeployment() { written = true; return { metadata: { generation: 2 } }; },
  } });
  const pending = assert.rejects(
    kubernetes.restartApplication({ kubernetes: { appNamespace: 'apps' } }, 'demo'),
    /Timed out waiting for Deployment apps\/demo/,
  );
  await new Promise(setImmediate);
  t.mock.timers.tick(5 * 60 * 1000);
  await pending;
});

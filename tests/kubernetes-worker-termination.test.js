const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const config = { kubernetes: { workerNamespace: 'workers' } };
const since = '2026-09-10T15:00:00Z';
test.afterEach(() => kubernetes._setClientsForTest(null));

for (const [label, terminated, oomKilled] of [
  ['current OOM', { reason: 'OOMKilled', finishedAt: '2026-09-10T15:01:00Z' }, true],
  ['earlier OOM', { reason: 'OOMKilled', finishedAt: '2026-09-10T14:00:00Z' }, false],
  ['unknown timestamp', { reason: 'OOMKilled' }, false],
  ['ordinary exit 137', { reason: 'Error', exitCode: 137, finishedAt: '2026-09-10T15:01:00Z' }, false],
]) {
  test(`termination attribution: ${label}`, async () => {
    kubernetes._setClientsForTest({ core: { listNamespacedPod: async request => {
      assert.equal(request.namespace, 'workers');
      assert.match(request.labelSelector, /managed-by=social-vibecoding-runtime/);
      return { items: [{ status: { containerStatuses: [{ name: 'worker',
        state: { running: {} }, lastState: { terminated } }] } }] };
    } } });
    assert.equal((await kubernetes.inspectWorkerTermination(config, 'worker', { since })).oomKilled, oomKilled);
  });
}

test('an inaccessible Pod API stays unknown and its wait is bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  kubernetes._setClientsForTest({ core: { listNamespacedPod: () => new Promise(() => {}) } });
  const pending = kubernetes.inspectWorkerTermination(config, 'worker', { since, timeoutMs: 20 });
  t.mock.timers.tick(20);
  assert.equal(await pending, null);
});

test('account workspace erasure requires Deployment, Secret, PVC and Pods to be absent', async () => {
  const missing = async () => { throw Object.assign(new Error('not found'), { code: 404 }); };
  const clients = {
    apps: { deleteNamespacedDeployment: async () => {}, readNamespacedDeployment: missing },
    core: {
      deleteNamespacedSecret: async () => {}, deleteNamespacedPersistentVolumeClaim: async () => {},
      readNamespacedSecret: missing, readNamespacedPersistentVolumeClaim: async () => ({ metadata: { deletionTimestamp: 'pending' } }),
      listNamespacedPod: async () => ({ items: [] }),
    },
  };
  kubernetes._setClientsForTest(clients);
  await assert.rejects(kubernetes.eraseWorker(config, 42), /worker_erasure_pending/);
  clients.core.readNamespacedPersistentVolumeClaim = missing;
  clients.core.listNamespacedPod = async () => ({ items: [{ metadata: { deletionTimestamp: 'pending' } }] });
  await assert.rejects(kubernetes.eraseWorker(config, 42), /worker_erasure_pending/);
  clients.core.listNamespacedPod = async () => ({ items: [] });
  await kubernetes.eraseWorker(config, 42);
  clients.apps.readNamespacedDeployment = async () => { throw Object.assign(new Error('unauthorized'), { code: 403 }); };
  await assert.rejects(kubernetes.eraseWorker(config, 42), /unauthorized/);
});

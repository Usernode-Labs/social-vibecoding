const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const debugAccess = require('../src/services/debug-access');
const config = { kubernetes: { appNamespace: 'apps', workerNamespace: 'workers' } };
const owner = { 'app.kubernetes.io/managed-by': 'social-vibecoding-runtime' };
test.afterEach(() => kubernetes._setClientsForTest(null));

for (const name of ['sv-app-7-demo', 'sv-preview-7-s42', 'sv-worker-s42']) {
  test(`debug logs resolve ${name} within its owned namespace`, async () => {
    const namespace = name.startsWith('sv-worker') ? 'workers' : 'apps';
    kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: async request => {
      assert.deepEqual(request, { name, namespace });
      return { metadata: { labels: owner } };
    } }, core: {
      listNamespacedPod: async request => {
        assert.equal(request.namespace, namespace);
        assert.match(request.labelSelector, /managed-by=social-vibecoding-runtime/);
        return { items: [
          { metadata: { name: 'old', creationTimestamp: '2026-01-01T00:00:00Z' } },
          { metadata: { name: 'new', creationTimestamp: '2026-02-01T00:00:00Z' } },
        ] };
      },
      readNamespacedPodLog: async request => {
        assert.deepEqual(request, { name: 'new', namespace, container: namespace === 'workers' ? 'worker' : 'app', tailLines: 12, limitBytes: 101 });
        return 'logs';
      },
    } });
    assert.equal(debugAccess.isAllowedLogContainer(name, 'kubernetes'), true);
    assert.equal(await kubernetes.getDebugLogs(config, name, { tailLines: 12, maxBytes: 100 }), 'logs');
  });
}

test('matching names do not authorize unmanaged workloads or arbitrary namespaces', async () => {
  kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: async () => ({ metadata: { labels: {} } }) },
    core: { listNamespacedPod: () => assert.fail('must not list Pods of another owner') } });
  await assert.rejects(kubernetes.getDebugLogs(config, 'sv-app-7-demo'), /not managed/);
  for (const name of ['kube-system', 'sv-worker-s1/other', 'sv-app-1-x.namespace', 'sv-worker-s1;id']) {
    assert.equal(debugAccess.isAllowedLogContainer(name, 'kubernetes'), false);
    await assert.rejects(kubernetes.getDebugLogs(config, name), /Invalid runtime/);
  }
});

test('debug log API stalls are bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: () => new Promise(() => {}) }, core: {} });
  const rejected = assert.rejects(kubernetes.getDebugLogs(config, 'sv-worker-s42', { timeoutMs: 50 }), /timed out/);
  t.mock.timers.tick(50);
  await rejected;
});

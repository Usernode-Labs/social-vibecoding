'use strict';

// A worker evicted on Kubernetes is gone before the eviction lets go
// (services/kubernetes.js deleteWorker `waitGone`, used by worker.js
// evictWorker): Foreground propagation keeps the Deployment, marked for
// deletion, until its Pods have terminated, and a turn waiting on the
// eviction's lock (services/worker-eviction.js) would otherwise update the
// Deployment about to go and wait for a bootstrap that never comes.

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

const config = { kubernetes: { workerNamespace: 'social-workers' } };

function fakeClients(readsUntilGone) {
  const calls = { reads: 0, deleted: [] };
  const notFound = () => Object.assign(new Error('not found'), { code: 404 });
  kubernetes._setClientsForTest({
    apps: {
      deleteNamespacedDeployment: async (o) => { calls.deleted.push(['deployment', o.name]); },
      readNamespacedDeployment: async () => {
        calls.reads += 1;
        if (calls.reads > readsUntilGone) throw notFound();
        return { metadata: { name: 'sv-worker-s5', deletionTimestamp: new Date().toISOString() } };
      },
    },
    core: {
      deleteNamespacedSecret: async (o) => { calls.deleted.push(['secret', o.name]); },
      deleteNamespacedPersistentVolumeClaim: async (o) => { calls.deleted.push(['pvc', o.name]); },
    },
  });
  return calls;
}

test('a deletion that waits returns only once the Deployment is gone, and gives up past its bound', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const calls = fakeClients(3);
  await kubernetes.deleteWorker(config, 5, { waitGone: true, pollMs: 5 });
  assert.equal(calls.reads, 4, 'read until it is not found');
  assert.deepEqual(calls.deleted.map(([kind]) => kind).sort(), ['deployment', 'secret']);

  const plain = fakeClients(3);
  await kubernetes.deleteWorker(config, 5);
  assert.equal(plain.reads, 0, 'a teardown does not wait');

  fakeClients(Infinity);
  await assert.rejects(kubernetes.deleteWorker(config, 5, { waitGone: true, waitMs: 30, pollMs: 5 }), /still being deleted/);
});

test('an eviction waits for its worker to be gone', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/worker.js'), 'utf8');
  const evict = src.slice(src.indexOf('async function evictWorker('), src.indexOf('\n}\n', src.indexOf('async function evictWorker(')));
  assert.match(evict, /kubernetes\.deleteWorker\(kubernetesWorkerConfig\(\), sessionId, \{ deleteVolume: false, waitGone: true \}\)/);
});

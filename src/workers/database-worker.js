'use strict';

const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { loadPolicy, createStore, reconcileRequest } = require('../services/database-control-plane');

async function run({ store, policy, getPolicy = () => policy, signal, intervalMs = 5000, health, onError }) {
  while (!signal.aborted) {
    try {
      policy = getPolicy();
      if (!policy) throw new Error('Database control plane is disabled');
      const requests = await store.list(policy.namespace);
      for (const request of requests) {
        if (signal.aborted) break;
        try { await reconcileRequest(store, policy, request); }
        catch (error) {
          // Conflicts are normal if two rollout pods overlap. Never log API
          // response bodies, which may contain arbitrary resource contents.
          onError(error);
        }
      }
      health.lastPoll = Date.now();
    } catch (error) { onError(error); }
    await delay(intervalMs, undefined, { signal }).catch((error) => {
      if (error.name !== 'AbortError') throw error;
    });
  }
}

async function main() {
  const policy = loadPolicy();
  if (!policy) throw new Error('Database control plane is disabled');
  const k8s = require('@kubernetes/client-node');
  const config = new k8s.KubeConfig();
  config.loadFromCluster();
  const store = createStore(config.makeApiClient(k8s.CustomObjectsApi));
  const controller = new AbortController();
  const health = { lastPoll: 0 };
  const server = http.createServer((req, res) => {
    const ready = !controller.signal.aborted && Date.now() - health.lastPoll < 60000;
    res.writeHead(req.url === '/health' ? 200 : req.url === '/ready' ? (ready ? 200 : 503) : 404);
    res.end();
  });
  server.listen(3001, '0.0.0.0');
  const stop = () => { controller.abort(); server.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await run({ store, policy, getPolicy: loadPolicy, signal: controller.signal, health,
    onError: (error) => console.error('database-worker: reconciliation failed',
      Number(error?.code) || 'request-failed') });
}

if (require.main === module) main().catch(() => {
  console.error('database-worker: startup failed; check policy and Kubernetes access');
  process.exitCode = 1;
});

module.exports = { run };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kubernetes = require('../src/services/kubernetes');
const config = { kubernetes: { workerNamespace: 'workers' } };
test.afterEach(() => kubernetes._setClientsForTest(null));

test('stale available replicas do not authorize a turn in a restarting or cloning Pod', async () => {
  let pod = { metadata: { name: 'replacement' }, status: { phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False' }],
    containerStatuses: [{ name: 'worker', ready: false, state: { running: {} } }] } };
  kubernetes._setClientsForTest({
    apps: { readNamespacedDeployment: async () => ({ metadata: { generation: 1 },
      status: { availableReplicas: 1, observedGeneration: 1 } }) },
    core: { listNamespacedPod: async () => ({ items: [pod] }) },
  });
  assert.equal(await kubernetes.getWorkerStatus(config, 'worker'), 'created');
  pod.status.conditions[0].status = 'True';
  assert.equal(await kubernetes.getWorkerStatus(config, 'worker'), 'created', 'container readiness must agree');
  pod.status.containerStatuses[0].ready = true;
  assert.equal(await kubernetes.getWorkerStatus(config, 'worker'), 'running');
  pod.metadata.deletionTimestamp = new Date().toISOString();
  assert.equal(await kubernetes.getWorkerStatus(config, 'worker'), 'created', 'terminating old Pod cannot authorize reuse');
});

test('missing deployments remain distinguishable from unready workers', async () => {
  kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: async () => { throw Object.assign(new Error('missing'), { code: 404 }); } } });
  assert.equal(await kubernetes.getWorkerStatus(config, 'worker'), 'not_found');
});

test('a turn racing container restart exits before touching the incomplete Git checkout', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-readiness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = fs.readFileSync(path.join(__dirname, '../worker/run-cc.sh'), 'utf8')
    .replaceAll('/tmp/usernode-worker-ready', path.join(dir, 'ready'));
  const result = spawnSync('/bin/sh', ['-c', script], {
    cwd: dir, env: { PATH: process.env.PATH, USERNODE_WORKER_REQUIRE_READY: '1' }, encoding: 'utf8', timeout: 1000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /__USERNODE_ERROR__ worker bootstrap is not ready/);
  assert.equal(result.stderr, '', 'must stop before even the prompt/Git setup guards');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const os = require('node:os');
const kubernetes = require('../src/services/kubernetes');
const docker = require('../src/services/docker');
const worker = require('../src/services/worker');
const deployStatus = require('../src/services/deploy-status');

function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
}

for (const runtime of [undefined, 'docker', 'kubernetes']) {
  test(`preview skips runtime access with APP_RUNTIME=${runtime || 'unset'}`, async (t) => {
    env(t, { USERNODE_ENV: 'staging', APP_RUNTIME: runtime, WORKER_RUNTIME: runtime });
    // Load the provider after replacing execFile: promisify captures its
    // reference at module initialization. Even a swallowed failure counts.
    const exec = t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected Docker access'); });
    const id = require.resolve('../src/services/runtime-status');
    const prior = require.cache[id];
    delete require.cache[id];
    t.after(() => { if (prior) require.cache[id] = prior; else delete require.cache[id]; });
    const provider = require(id);
    const resources = t.mock.method(kubernetes, 'listStatusResources', async () => { throw new Error('unexpected cluster access'); });
    const capacity = t.mock.method(kubernetes, 'listNamespaceCapacity', async () => { throw new Error('unexpected cluster access'); });
    const host = t.mock.method(os, 'totalmem', () => { throw new Error('unexpected host metrics'); });
    const build = t.mock.method(docker, 'buildImage', async () => { throw new Error('unexpected worker build'); });
    const deployment = t.mock.method(kubernetes, 'getPlatformDeployStatus', async () => { throw new Error('unexpected rollout access'); });
    const config = { appRuntime: runtime };

    assert.deepEqual(await provider.snapshot(config), {
      runtimeKind: 'preview', available: false,
      resources: [], stats: {}, host: null, namespaceCapacity: [],
    });
    assert.deepEqual(await provider.listDockerContainers(config), []);
    assert.deepEqual(await provider.getDockerStats(config), {});
    assert.equal(await provider._inspectDockerStartedForTest('a-preview', config), null);
    await worker.ensureWorkerImage();
    assert.equal(await deployStatus.read(config), null);
    for (const mock of [exec, resources, capacity, host, build, deployment]) {
      assert.equal(mock.mock.callCount(), 0);
    }
  });
}

test('production Kubernetes status still observes real runtime resources', async (t) => {
  env(t, { USERNODE_ENV: 'production' });
  const resources = [{ name: 'sv-app-1-demo', state: 'running' }];
  const namespaces = [{ namespace: 'social-apps' }];
  t.mock.method(kubernetes, 'listStatusResources', async () => resources);
  t.mock.method(kubernetes, 'listNamespaceCapacity', async () => namespaces);
  const provider = require('../src/services/runtime-status');
  const result = await provider.snapshot({ appRuntime: 'kubernetes' });
  assert.equal(result.runtimeKind, 'kubernetes');
  assert.deepEqual(result.resources, resources);
  assert.deepEqual(result.namespaceCapacity, namespaces);
  assert.notEqual(result.available, false);
});

test('production Docker still prepares its worker image', async (t) => {
  env(t, { USERNODE_ENV: 'production', APP_RUNTIME: 'docker', WORKER_RUNTIME: 'docker' });
  const build = t.mock.method(docker, 'buildImage', async () => {});
  await worker.ensureWorkerImage();
  assert.equal(build.mock.callCount(), 1);
  assert.equal(build.mock.calls[0].arguments[1], 'usernode-worker:latest');
});

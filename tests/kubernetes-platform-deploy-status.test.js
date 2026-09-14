const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const kubernetes = require('../src/services/kubernetes');
const config = { appRuntime: 'kubernetes', kubernetes: { platformNamespace: 'platform', platformDeployment: 'custom-platform' } };
test.afterEach(() => kubernetes._setClientsForTest(null));

test('platform status follows the desired Deployment through rollout, failure, and completion', async () => {
  const deployment = { metadata: { generation: 2 }, spec: { replicas: 1,
    template: { metadata: { annotations: { 'social.usernode.io/source-revision': 'b'.repeat(40) } } } },
    status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
  kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: async request => {
    assert.deepEqual(request, { namespace: 'platform', name: 'custom-platform' });
    return deployment;
  } } });
  const read = () => kubernetes.getPlatformDeployStatus(config);
  assert.equal((await read()).deploying, true);
  assert.equal((await read()).sha, 'b'.repeat(40));
  deployment.status.conditions = [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'new replica never became ready' }];
  assert.equal((await read()).failed, true);
  assert.equal((await read()).deploying, false);
  assert.match((await read()).message, /never became ready/);
  deployment.status.observedGeneration = 1;
  assert.equal((await read()).failed, false, 'old conditions cannot describe an unobserved new generation');
  deployment.status.observedGeneration = 2;
  deployment.status.conditions = [];
  deployment.status.replicas = 1;
  assert.equal((await read()).phase, 'complete');
  deployment.spec.paused = true;
  assert.equal((await read()).phase, 'paused');
  deployment.spec.replicas = 0;
  assert.equal((await read()).phase, 'stopped');
  assert.equal((await read()).deploying, false);
});

test('a stalled rollout API is bounded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: () => new Promise(() => {}) } });
  const pending = assert.rejects(kubernetes.getPlatformDeployStatus(config, { timeoutMs: 20 }), /timed out/);
  t.mock.timers.tick(20); await pending;
});

test('cluster deploy status coalesces reads and reports unavailable instead of idle', async t => {
  const id = require.resolve('../src/services/deploy-status');
  delete require.cache[id];
  t.after(() => delete require.cache[id]);
  let reads = 0;
  t.mock.method(kubernetes, 'getPlatformDeployStatus', async () => { reads++; throw new Error('forbidden'); });
  const { read } = require(id);
  const [a, b] = await Promise.all([read(config), read(config)]);
  assert.equal(reads, 1);
  assert.equal(a.unavailable, true);
  assert.deepEqual(a, b);
  await read(config);
  assert.equal(reads, 1);
});

test('Kubernetes cannot write a host-deployer nudge even with a writable mount', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-nudge-'));
  const old = { APP_RUNTIME: process.env.APP_RUNTIME, USERNODE_DEPLOY_NUDGE_PATH: process.env.USERNODE_DEPLOY_NUDGE_PATH };
  process.env.APP_RUNTIME = 'kubernetes';
  process.env.USERNODE_DEPLOY_NUDGE_PATH = dir;
  const id = require.resolve('../src/services/deploy-nudge');
  delete require.cache[id];
  t.after(() => {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete require.cache[id]; fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(require(id).nudgeHostDeployer({ sha: 'a'.repeat(40) }), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

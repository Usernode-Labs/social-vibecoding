const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const { classify } = require('../src/services/deploy-failure');

const config = { kubernetes: {
  buildNamespace: 'builds', repositoryPrefix: 'registry.test/apps', cacheRepositoryPrefix: 'registry.test/cache',
  builderImage: 'builder:latest', buildServiceAccount: 'builder', nodeVersion: '22.*', activeDeadlineSeconds: 30,
} };
const app = { id: 12, slug: 'demo', repo_url: 'https://github.com/example/demo' };
const request = { app, revision: 'b'.repeat(40), environment: 'staging', sessionId: 42 };

function fixture({ reason = 'BuildFailed', podReason, podError, createError } = {}) {
  const calls = [];
  kubernetes._setClientsForTest({ custom: {
    async createNamespacedCustomObject() { if (createError) throw createError; },
    async getNamespacedCustomObject() { return { status: { podName: 'lifecycle', conditions: [
      { type: 'Succeeded', status: 'False', reason, message: 'lifecycle failed' },
    ] } }; },
    async deleteNamespacedCustomObject() { calls.push('delete'); },
  }, core: {
    async readNamespacedPod({ namespace, name }) {
      calls.push('pod');
      assert.equal(namespace, 'builds');
      assert.equal(name, 'lifecycle');
      if (podError) throw podError;
      return { metadata: { name }, spec: { initContainers: [{ name: 'prepare' }, { name: 'build' }],
        containers: [{ name: 'completion' }] }, status: { reason: podReason, initContainerStatuses: [
        { name: 'build', state: { terminated: { reason: 'Error', exitCode: 1 } } },
      ] } };
    },
    async readNamespacedPodLog({ container, limitBytes }) {
      calls.push(container);
      assert.equal(limitBytes, 16384);
      return container === 'build' ? 'postgres://user:secret@db/app\nError: Cannot find module widget' : '';
    },
  } });
  return calls;
}
test.afterEach(() => kubernetes._setClientsForTest(null));

test('captures failed lifecycle logs before Build deletion without a progress observer', async () => {
  const calls = fixture();
  await assert.rejects(kubernetes.createBuild(config, request), err => {
    assert.equal(err.buildFailed, true);
    assert.match(err.buildRef, /^builds\//);
    const failure = classify(err);
    assert.equal(failure.stage, 'build');
    assert.match(failure.reason, /Cannot find module widget/);
    assert.match(failure.log, /build: Error: exit=1/);
    assert.match(failure.log, /lifecycle\/build/);
    assert.doesNotMatch(failure.log, /secret/);
    return true;
  });
  assert.deepEqual(calls, ['pod', 'prepare', 'build', 'completion', 'delete']);
});

test('unavailable Pod diagnostics preserve build classification and the controller error', async () => {
  const calls = fixture({ podError: new Error('forbidden') });
  await assert.rejects(kubernetes.createBuild(config, request), err => {
    assert.equal(classify(err).stage, 'build');
    assert.match(classify(err).log, /lifecycle failed/);
    assert.doesNotMatch(err.message, /forbidden/);
    return true;
  });
  assert.deepEqual(calls, ['pod', 'delete']);
});

test('controller deadline failures report the configured kpack budget', async () => {
  fixture({ reason: 'DeadlineExceeded' });
  await assert.rejects(kubernetes.createBuild(config, request), err => {
    assert.equal(classify(err).reason, 'Build timed out after 30 seconds');
    assert.match(classify(err).log, /Cannot find module widget/);
    return true;
  });
});

test('Pod deadline evidence survives a generic kpack failure condition', async () => {
  fixture({ podReason: 'DeadlineExceeded' });
  await assert.rejects(kubernetes.createBuild(config, request), err => {
    assert.equal(classify(err).reason, 'Build timed out after 30 seconds');
    assert.match(classify(err).log, /DeadlineExceeded/);
    return true;
  });
});

test('admission rejection is a build failure with useful redacted evidence', async () => {
  const calls = fixture({ createError: new Error('exceeded quota for postgres://user:secret@db/app') });
  await assert.rejects(kubernetes.createBuild(config, request), err => {
    assert.equal(classify(err).stage, 'build');
    assert.match(classify(err).log, /exceeded quota/);
    assert.doesNotMatch(classify(err).log, /secret/);
    return true;
  });
  assert.deepEqual(calls, [], 'a rejected create owns no Build to delete');
});

test('runtime polling deadline reports its actual budget with controller evidence', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  fixture();
  kubernetes._setClientsForTest({ custom: {
    async createNamespacedCustomObject() {},
    async getNamespacedCustomObject() {
      t.mock.timers.tick(90000);
      return { status: { conditions: [{ type: 'Succeeded', status: 'Unknown' }] } };
    },
    async deleteNamespacedCustomObject() {},
  } });
  const pending = assert.rejects(kubernetes.createBuild(config, request), err => {
    assert.equal(classify(err).reason, 'Build timed out after 90 seconds');
    assert.match(classify(err).log, /Timed out waiting/);
    return true;
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await pending;
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'test-worker-secret';
process.env.WORKER_RUNTIME = 'kubernetes';
process.env.KUBERNETES_WORKER_IMAGE = `ghcr.io/example/worker@sha256:${'b'.repeat(64)}`;

const kubernetes = require('../src/services/kubernetes');
const github = require('../src/services/github');
const worker = require('../src/services/worker');

const workerSource = fs.readFileSync(path.join(__dirname, '../src/services/worker.js'), 'utf8');
const contractVersion = workerSource.match(/const WORKER_BOOTSTRAP_ENV_VERSION = '(v\d+)'/)[1];
const ensureArgs = { repoOwner: 'owner', repoName: 'repo', branchName: 'dev/test' };

function runtimeName(sessionId) {
  return `sv-worker-s${sessionId}`;
}

function mockWarmWorker(t, { imageRef }) {
  const deleted = [];
  const bootstrapped = [];
  t.mock.method(kubernetes, 'getWorkerStatus', async () => 'running');
  t.mock.method(kubernetes, 'getWorkerRuntimeMetadata', async () => ({
    contractVersion,
    imageRef,
  }));
  t.mock.method(kubernetes, 'deleteWorker', async (_config, sessionId, options) => {
    deleted.push({ sessionId, options });
  });
  t.mock.method(kubernetes, 'ensureWorker', async (config, { sessionId }) => {
    bootstrapped.push({ sessionId, imageRef: config.kubernetes.workerImage });
    return { runtimeName: runtimeName(sessionId), pvcName: `${runtimeName(sessionId)}-state` };
  });
  t.mock.method(github, 'checkRepoPublic', async () => ({ ok: true, private: false }));
  t.mock.method(github, 'getCloneUrl', async () => 'https://github.com/owner/repo.git');
  return { deleted, bootstrapped };
}

test('a warm Kubernetes worker on the release image is reused', async (t) => {
  const sessionId = 9101;
  const calls = mockWarmWorker(t, { imageRef: process.env.KUBERNETES_WORKER_IMAGE });
  worker.adoptWarmWorker(sessionId, runtimeName(sessionId));

  assert.equal(await worker.ensureWorker(sessionId, ensureArgs), runtimeName(sessionId));
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.bootstrapped, []);
});

test('a warm Kubernetes worker on an old image is reconciled without deleting its volume', async (t) => {
  const sessionId = 9102;
  const calls = mockWarmWorker(t, {
    imageRef: `ghcr.io/example/worker@sha256:${'a'.repeat(64)}`,
  });
  worker.adoptWarmWorker(sessionId, runtimeName(sessionId));

  assert.equal(await worker.ensureWorker(sessionId, ensureArgs), runtimeName(sessionId));
  assert.deepEqual(calls.deleted, [], 'the Deployment is updated in place and its PVC stays attached');
  assert.deepEqual(calls.bootstrapped, [{
    sessionId,
    imageRef: process.env.KUBERNETES_WORKER_IMAGE,
  }]);
});

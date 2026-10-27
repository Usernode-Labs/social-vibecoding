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

function mockWarmWorker(t, { imageRef, storageMode = 'persistent' }) {
  const deleted = [];
  const bootstrapped = [];
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({ query: async () => ({ rows: [] }) }));
  t.mock.method(kubernetes, 'getWorkerStatus', async () => 'running');
  t.mock.method(kubernetes, 'getWorkerRuntimeMetadata', async () => ({
    contractVersion,
    imageRef,
    storageMode,
  }));
  t.mock.method(kubernetes, 'deleteWorker', async (_config, sessionId, options) => {
    deleted.push({ sessionId, options });
  });
  t.mock.method(kubernetes, 'ensureWorker', async (config, { sessionId, temporary }) => {
    bootstrapped.push({ sessionId, imageRef: config.kubernetes.workerImage, temporary });
    return { runtimeName: runtimeName(sessionId),
      pvcName: temporary ? null : `${runtimeName(sessionId)}-state` };
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
    temporary: false,
  }]);
});

test('a temporary shots worker reconciles a persistent warm worker without deleting its PVC first', async (t) => {
  const sessionId = 9103;
  const calls = mockWarmWorker(t, { imageRef: process.env.KUBERNETES_WORKER_IMAGE });
  worker.adoptWarmWorker(sessionId, runtimeName(sessionId));

  assert.equal(await worker.ensureWorker(sessionId, { ...ensureArgs, temporary: true }), runtimeName(sessionId));
  assert.deepEqual(calls.deleted, []);
  assert.deepEqual(calls.bootstrapped, [{
    sessionId, imageRef: process.env.KUBERNETES_WORKER_IMAGE, temporary: true,
  }]);
});

test('a temporary shots worker is reused for a repair turn', async (t) => {
  const sessionId = 9104;
  const calls = mockWarmWorker(t, {
    imageRef: process.env.KUBERNETES_WORKER_IMAGE, storageMode: 'temporary',
  });
  worker.adoptWarmWorker(sessionId, runtimeName(sessionId));

  assert.equal(await worker.ensureWorker(sessionId, { ...ensureArgs, temporary: true }), runtimeName(sessionId));
  assert.deepEqual(calls.bootstrapped, [], 'repair keeps the same model thread on pod storage');
});

// 14 Oct 2026: a newcomer's first version (bot run 2027) lost its worker
// between its build turn and its review's fix turn. No turn was in flight,
// so a newer worker image replaced the Pod and its scratch workspace, and
// the fix turn's resume failed. A durable build holds its session for its
// whole run (services/build-runs.js holdsSession): its worker keeps the image
// it has until the build ends, and is replaced at the first ensure after.
function heldBy(t, state) {
  const asked = [];
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({
    async query(sql, params) {
      // What a worker's use notes for every process (session_workers) is not
      // the hold this asks about.
      if (/session_workers/.test(String(sql)) || String(sql).includes("mc.machine = 'worker-memory-copy'")) return { rows: [] };
      asked.push({ sql: String(sql), params });
      return { rows: [{ held: state.building }] };
    },
  }));
  return asked;
}

test('a durable build\'s worker on an old image is kept until the build ends, then replaced', async (t) => {
  const sessionId = 9105;
  const calls = mockWarmWorker(t, {
    imageRef: `ghcr.io/example/worker@sha256:${'a'.repeat(64)}`, storageMode: 'temporary',
  });
  const state = { building: true };
  const asked = heldBy(t, state);
  worker.adoptWarmWorker(sessionId, runtimeName(sessionId));

  assert.equal(await worker.ensureWorker(sessionId, { ...ensureArgs, temporary: true }), runtimeName(sessionId));
  assert.deepEqual(calls.bootstrapped, [], 'the run keeps its worker, and its workspace with it');
  assert.equal(asked.length, 1);
  assert.match(asked[0].sql, /cs\.workflow_owner IS NOT NULL AND EXISTS/);
  assert.match(asked[0].sql, /w\.state = 'building'/);
  assert.deepEqual(asked[0].params, [sessionId]);

  // A process with no record of the worker (a restart carried the build
  // here) keeps it too, and records it as warm.
  worker._registryForgetForTests(sessionId);
  assert.equal(await worker.ensureWorker(sessionId, { ...ensureArgs, temporary: true }), runtimeName(sessionId));
  assert.deepEqual(calls.bootstrapped, []);
  assert.ok(worker.warmRegistrySnapshot().some((w) => w.sessionId === sessionId), 'registered as this process\'s warm worker');

  // The build ended: the next ensure moves it onto the release's image.
  state.building = false;
  assert.equal(await worker.ensureWorker(sessionId, { ...ensureArgs, temporary: true }), runtimeName(sessionId));
  assert.deepEqual(calls.bootstrapped, [{
    sessionId, imageRef: process.env.KUBERNETES_WORKER_IMAGE, temporary: true,
  }]);
});

test('a run keeps its worker only for a newer image: a storage change or a contract change still replaces it', async (t) => {
  // A storage change: as before, whoever holds the session.
  const storage = mockWarmWorker(t, {
    imageRef: `ghcr.io/example/worker@sha256:${'a'.repeat(64)}`, storageMode: 'persistent',
  });
  const asked = heldBy(t, { building: true });
  worker.adoptWarmWorker(9106, runtimeName(9106));
  await worker.ensureWorker(9106, { ...ensureArgs, temporary: true });
  assert.equal(storage.bootstrapped.length, 1);
  assert.deepEqual(asked, [], 'not even asked: a storage change is never deferred for a run');
  t.mock.restoreAll();

  // An older contract cannot serve this host's turns.
  const contract = mockWarmWorker(t, { imageRef: process.env.KUBERNETES_WORKER_IMAGE, storageMode: 'temporary' });
  t.mock.method(kubernetes, 'getWorkerRuntimeMetadata', async () => ({
    contractVersion: 'v1', imageRef: process.env.KUBERNETES_WORKER_IMAGE, storageMode: 'temporary',
  }));
  const askedAgain = heldBy(t, { building: true });
  worker.adoptWarmWorker(9107, runtimeName(9107));
  await worker.ensureWorker(9107, { ...ensureArgs, temporary: true });
  assert.equal(contract.bootstrapped.length, 1);
  assert.deepEqual(askedAgain, []);
});

test('a database failure keeps the old worker because an unpushed commit cannot be ruled out', async (t) => {
  const calls = mockWarmWorker(t, { imageRef: `ghcr.io/example/worker@sha256:${'a'.repeat(64)}`, storageMode: 'temporary' });
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({ async query() { throw new Error('connection refused'); } }));
  worker.adoptWarmWorker(9108, runtimeName(9108));
  await assert.rejects(worker.ensureWorker(9108, { ...ensureArgs, temporary: true }), /connection refused/);
  assert.deepEqual(calls.bootstrapped, []);
  assert.deepEqual(calls.deleted, []);
});

test('a failed durable rescue prevents stale Kubernetes replacement', async t => {
  const calls = mockWarmWorker(t, { imageRef: `ghcr.io/example/worker@sha256:${'a'.repeat(64)}` });
  t.mock.method(require('../src/services/worker-unpushed-commit'), 'read', async () => ({ sha: 'a'.repeat(40), branchName: 'dev/test' }));
  worker.adoptWarmWorker(9109, runtimeName(9109));
  // No stored push target in this fixture: rescue fails without publishing.
  await assert.rejects(worker.ensureWorker(9109, ensureArgs), /An earlier build's commit aaaaaaaa on dev\/test could not be pushed/);
  assert.deepEqual(calls.bootstrapped, []);
  assert.deepEqual(calls.deleted, []);
});

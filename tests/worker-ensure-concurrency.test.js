'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.WORKER_JWT_SECRET = 'worker-ensure-fixture';
process.env.WORKER_RUNTIME = 'kubernetes';
process.env.KUBERNETES_WORKER_IMAGE = `ghcr.io/example/worker@sha256:${'b'.repeat(64)}`;

const kubernetes = require('../src/services/kubernetes');
const github = require('../src/services/github');
const worker = require('../src/services/worker');
const source = fs.readFileSync(path.join(__dirname, '../src/services/worker.js'), 'utf8');
const contractVersion = source.match(/const WORKER_BOOTSTRAP_ENV_VERSION = '(v\d+)'/)[1];
const args = { repoOwner: 'owner', repoName: 'repo', branchName: 'dev/test' };
const nameOf = id => `sv-worker-s${id}`;

// Exercise the real worker module; only its external runtime/GitHub calls
// are fake. Keep the runtime state so a waiter must inspect the worker it
// actually receives, including the first caller's storage choice.
function runtime(t, { beforeStatus, beforeBootstrap } = {}) {
  const workers = new Map();
  const boots = [];
  t.mock.method(kubernetes, 'getWorkerStatus', async (_config, name) => {
    await beforeStatus?.(name);
    return workers.has(name) ? 'running' : 'not_found';
  });
  t.mock.method(kubernetes, 'getWorkerRuntimeMetadata', async (_config, name) => workers.get(name));
  t.mock.method(kubernetes, 'ensureWorker', async (config, options) => {
    const { sessionId, temporary } = options;
    boots.push({ sessionId, temporary });
    await beforeBootstrap?.(options);
    workers.set(nameOf(sessionId), { contractVersion, imageRef: config.kubernetes.workerImage,
      storageMode: temporary ? 'temporary' : 'persistent' });
    return { runtimeName: nameOf(sessionId), pvcName: temporary ? null : `${nameOf(sessionId)}-state` };
  });
  t.mock.method(github, 'checkRepoPublic', async () => ({ ok: true, private: false }));
  t.mock.method(github, 'getCloneUrl', async () => 'https://github.com/owner/repo.git');
  return boots;
}

const nextTurn = () => new Promise(setImmediate);

test('concurrent cold ensures join before the asynchronous status probe', async t => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const boots = runtime(t, { beforeStatus: async () => { entered.resolve(); await gate.promise; } });

  const first = worker.ensureWorker(96001, args);
  await entered.promise;
  const second = worker.ensureWorker(96001, args);
  const third = worker.ensureWorker(96001, args);
  await nextTurn();
  gate.resolve();

  assert.deepEqual(await Promise.all([first, second, third]), Array(3).fill(nameOf(96001)));
  assert.deepEqual(boots, [{ sessionId: 96001, temporary: false }]);
});

test('a successful waiter rechecks its own storage option', async t => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const boots = runtime(t, { beforeBootstrap: async () => { entered.resolve(); await gate.promise; } });

  const first = worker.ensureWorker(96002, args);
  await entered.promise;
  const second = worker.ensureWorker(96002, { ...args, temporary: true });
  await nextTurn();
  gate.resolve();

  assert.deepEqual(await Promise.all([first, second]), Array(2).fill(nameOf(96002)));
  assert.deepEqual(boots, [
    { sessionId: 96002, temporary: false },
    { sessionId: 96002, temporary: true },
  ]);
});

test('a blocked start leaves other sessions free to start', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const boots = runtime(t, { beforeBootstrap: async ({ sessionId }) => {
    if (sessionId === 96003) { entered.resolve(); await gate.promise; }
  } });

  const first = worker.ensureWorker(96003, args);
  await entered.promise;
  try {
    assert.equal(await worker.ensureWorker(96004, args), nameOf(96004));
    assert.deepEqual(boots.map(b => b.sessionId), [96003, 96004]);
  } finally { gate.resolve(); await first; }
});

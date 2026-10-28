const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const worker = require('../src/services/worker');

const originalWorkerRuntime = process.env.WORKER_RUNTIME;
const originalAppRuntime = process.env.APP_RUNTIME;

test.afterEach(() => {
  if (originalWorkerRuntime === undefined) delete process.env.WORKER_RUNTIME;
  else process.env.WORKER_RUNTIME = originalWorkerRuntime;
  if (originalAppRuntime === undefined) delete process.env.APP_RUNTIME;
  else process.env.APP_RUNTIME = originalAppRuntime;
});

test('worker runtime name preserves the Docker single-server name', () => {
  process.env.WORKER_RUNTIME = 'docker';
  assert.equal(worker.workerRuntimeName(17), 'usernode-worker-17');
});

test('worker runtime name matches the Kubernetes worker Deployment', () => {
  process.env.WORKER_RUNTIME = 'kubernetes';
  assert.equal(worker.workerRuntimeName(17), 'sv-worker-s17');
});

test('a pending Stop on a fresh conductor keeps the Kubernetes name for its later signal', async t => {
  process.env.WORKER_RUNTIME = 'kubernetes';
  const kubernetes = require('../src/services/kubernetes'); const names = [];
  t.mock.method(kubernetes, 'execInWorker', async (_config, runtimeName) => { names.push(runtimeName); return { stdout: '' }; });
  worker.noteStopPending(85019);
  assert.equal(await worker.stopTurnByJournal(85019, '/home/node/.claude/turn-fresh.log', { force: false }), 'signalled');
  assert.deepEqual(names, ['sv-worker-s85019']);
});

test('journal signalling on a fresh conductor uses the runtime name without registry or last-use writes', async t => {
  process.env.WORKER_RUNTIME = 'kubernetes';
  const names = []; const queries = [];
  t.mock.method(require('../src/services/kubernetes'), 'execInWorker', async (_config, name) => { names.push(name); return { stdout: '' }; });
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({ query: async sql => { queries.push(sql); return { rows: [] }; } }));
  assert.equal(worker.warmRegistrySnapshot().some(e => e.sessionId === 85020), false);
  await worker.stopTurnByJournal(85020, '/home/node/.claude/turn-current.log', { force: false });
  assert.deepEqual(names, ['sv-worker-s85020']);
  assert.equal(worker.warmRegistrySnapshot().some(e => e.sessionId === 85020), false);
  assert.equal(worker.getPendingStop(85020), null); assert.deepEqual(queries, []);
});

test('push proxy resolves the active runtime name instead of the Docker-only name', () => {
  const source = fs.readFileSync(require.resolve('../src/services/worker'), 'utf8');
  const start = source.indexOf('async function execPushFromWorker');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.match(body, /_registryGet\(sessionId\)\?\.containerName \|\| workerRuntimeName\(sessionId\)/);
  assert.doesNotMatch(body, /const containerName = workerContainerName\(sessionId\)/);
});

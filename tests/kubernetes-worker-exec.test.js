const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');

const config = { kubernetes: { workerNamespace: 'test-workers' } };
const flush = () => new Promise(setImmediate);

function setup(t, { discovery } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.terminations = 0;
  socket.terminate = () => {
    socket.terminations++;
    socket.readyState = 3;
    socket.emit('close');
  };
  const fx = { socket, calls: [], open: null };
  kubernetes._setClientsForTest({
    core: { listNamespacedPod: discovery || (async () => ({ items: [{ metadata: { name: 'worker-pod' } }] })) },
    exec: { exec: async (namespace, pod, container, command, stdout, stderr, input, tty, status) => {
      fx.calls.push({ namespace, pod, container, command, stdout, stderr, input, tty, status });
      return fx.open ? fx.open(fx.calls.at(-1)) : socket;
    } },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  return fx;
}

test('worker exec requires explicit success and preserves UTF-8 output across chunks', async (t) => {
  const fx = setup(t);
  const pending = kubernetes.execInWorker(config, 'test-worker', ['cat', '/journal']);
  await flush();
  const call = fx.calls[0];
  assert.equal(call.namespace, 'test-workers');
  assert.equal(call.pod, 'worker-pod');
  assert.equal(call.container, 'worker');
  assert.deepEqual(call.command, ['cat', '/journal']);
  const bytes = Buffer.from('café 🚀\n');
  for (const byte of bytes) call.stdout.write(Buffer.from([byte]));
  call.stderr.write('diagnostic');
  call.status({ status: 'Success' });
  fx.socket.terminate();
  assert.deepEqual(await pending, { stdout: 'café 🚀\n', stderr: 'diagnostic' });
  t.mock.timers.tick(30000);
  assert.equal(fx.socket.terminations, 1, 'completed command must not time out later');
});

test('worker exec rejects a nonzero remote exit with captured output and exit code', async (t) => {
  const fx = setup(t);
  const pending = kubernetes.execInWorker(config, 'test-worker', ['false']);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout, 'partial output');
    assert.equal(error.stderr, 'command failed');
    return true;
  });
  await flush();
  fx.calls[0].stdout.write('partial output');
  fx.calls[0].stderr.write('command failed');
  fx.calls[0].status({ status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '7' }] } });
  fx.socket.terminate();
  await rejected;
});

for (const early of [false, true]) {
  test(`worker exec rejects a status-less close ${early ? 'before' : 'after'} socket attachment`, async (t) => {
    const fx = setup(t);
    if (early) fx.open = () => { fx.socket.terminate(); return fx.socket; };
    const rejected = assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['true']), /without a successful exit status/);
    await flush();
    if (!early) fx.socket.terminate();
    await rejected;
  });
}

test('worker exec observes a successful command that closes before socket attachment', async (t) => {
  const fx = setup(t);
  fx.open = call => {
    call.status({ status: 'Success' });
    fx.socket.terminate();
    return fx.socket;
  };
  assert.deepEqual(await kubernetes.execInWorker(config, 'test-worker', ['true']), { stdout: '', stderr: '' });
});

test('worker exec rejects transport errors and terminates its socket', async (t) => {
  const fx = setup(t);
  const rejected = assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['true']), /connection lost/);
  await flush();
  fx.socket.emit('error', new Error('connection lost'));
  await rejected;
  assert.equal(fx.socket.terminations, 1);
  fx.socket.emit('error', new Error('late transport error'));
});

test('worker exec times out a hung command and disposes streams and transport', async (t) => {
  const fx = setup(t);
  const rejected = assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['sh', '-s'], 'sleep 60', { timeoutMs: 50 }), error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.stdout, 'started');
    return true;
  });
  await flush();
  fx.calls[0].stdout.write('started');
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(fx.socket.terminations, 1);
  assert.equal(fx.calls[0].input.destroyed, true);
  assert.equal(fx.calls[0].stdout.destroyed, true);
  assert.equal(fx.calls[0].stderr.destroyed, true);
});

test('worker exec deadline includes pod discovery and never starts after it expires', async (t) => {
  let discover;
  const fx = setup(t, { discovery: () => new Promise(resolve => { discover = resolve; }) });
  const rejected = assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['true'], null, { timeoutMs: 50 }), { code: 'ETIMEDOUT' });
  t.mock.timers.tick(50);
  await rejected;
  discover({ items: [{ metadata: { name: 'late-pod' } }] });
  await flush();
  assert.equal(fx.calls.length, 0);
});

test('worker exec deadline includes connection setup and terminates a late socket', async (t) => {
  const fx = setup(t);
  let connect;
  fx.open = () => new Promise(resolve => { connect = resolve; });
  const rejected = assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['true'], 'input', { timeoutMs: 50 }), { code: 'ETIMEDOUT' });
  await flush();
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(fx.calls[0].input.destroyed, true);
  connect(fx.socket);
  await flush();
  assert.equal(fx.socket.terminations, 1);
});

test('worker exec rejects setup failures and invalid deadlines', async (t) => {
  const fx = setup(t, { discovery: async () => { throw new Error('discovery failed'); } });
  await assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['true']), /discovery failed/);
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(kubernetes.execInWorker(config, 'test-worker', ['true'], null, { timeoutMs }), /positive finite/);
  }
  assert.equal(fx.calls.length, 0);
});

test('Kubernetes probes and push proxy preserve Docker operation deadlines', async (t) => {
  const originalRuntime = process.env.WORKER_RUNTIME;
  const originalToken = process.env.GITHUB_BOT_TOKEN;
  process.env.WORKER_RUNTIME = 'kubernetes';
  process.env.GITHUB_BOT_TOKEN = 'fake-test-token';
  t.after(() => {
    if (originalRuntime === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = originalRuntime;
    if (originalToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = originalToken;
  });
  const deadlines = [];
  t.mock.method(kubernetes, 'execInWorker', async (_config, _runtime, command, _input, options) => {
    deadlines.push(options.timeoutMs);
    return { stdout: command[0] === 'bash' ? 'abcdef\n' : 'busy', stderr: '' };
  });
  assert.equal(await worker.isWorkerExecuting('test-worker'), true);
  assert.equal(await worker.isWorkerExecuting('test-worker', { timeoutMs: 12345 }), true);
  assert.equal((await worker.execPushFromWorker(70003, 'test-branch')).sha, 'abcdef');
  assert.deepEqual(deadlines, [5000, 12345, 60000]);
});


test('legacy recovery and stop helpers never invoke Docker in Kubernetes mode', async (t) => {
  const prior = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = 'kubernetes';
  t.after(() => { if (prior === undefined) delete process.env.WORKER_RUNTIME; else process.env.WORKER_RUNTIME = prior; });
  const docker = require('../src/services/docker');
  t.mock.method(docker, 'execFileAsync', async () => assert.fail('must not call Docker'));
  t.mock.method(docker, 'stopAndRemove', async () => assert.fail('must not call Docker'));
  const removed = [];
  t.mock.method(kubernetes, 'deleteWorker', async (cfg, id, options) => removed.push({ id, options }));
  await assert.rejects(worker.watchWorker('sv-worker-s42'), /requires a turn journal/);
  await worker.stopWorker('sv-worker-s42');
  assert.deepEqual(removed, [{ id: 42, options: { deleteVolume: false } }]);
  await assert.rejects(worker.destroyWorker('unexpected-name'), /Invalid Kubernetes worker name/);
});

test('legacy Docker stop preserves its existing stop-only behavior', async (t) => {
  const prior = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = 'docker';
  t.after(() => { if (prior === undefined) delete process.env.WORKER_RUNTIME; else process.env.WORKER_RUNTIME = prior; });
  const docker = require('../src/services/docker');
  const calls = [];
  t.mock.method(docker, 'execFileAsync', async (...args) => { calls.push(args); });
  await worker.stopWorker('usernode-worker-42');
  assert.deepEqual(calls, [['docker', ['stop', 'usernode-worker-42'], { timeout: 15000 }]]);
});


for (const scenario of ['absent', 'starting', 'pod-replacement', 'api-error']) {
  test(`Kubernetes liveness distinguishes ${scenario} when no Pod is listed`, async (t) => {
    const prior = process.env.WORKER_RUNTIME;
    process.env.WORKER_RUNTIME = 'kubernetes';
    t.after(() => {
      if (prior === undefined) delete process.env.WORKER_RUNTIME; else process.env.WORKER_RUNTIME = prior;
      kubernetes._setClientsForTest(null);
    });
    kubernetes._setClientsForTest({
      core: { listNamespacedPod: async () => ({ items: [] }) },
      apps: { readNamespacedDeployment: async ({ name }) => {
        assert.equal(name, 'sv-worker-s42');
        if (scenario === 'absent') throw Object.assign(new Error('not found'), { code: 404 });
        if (scenario === 'api-error') throw Object.assign(new Error('unavailable'), { code: 503 });
        return { status: { availableReplicas: scenario === 'starting' ? 0 : 1 } };
      } },
    });
    assert.equal(await worker.isWorkerExecuting('sv-worker-s42'), scenario === 'absent' ? false : null);
  });
}

test('the missing-worker existence check shares the exec deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  kubernetes._setClientsForTest({
    core: { listNamespacedPod: async () => ({ items: [] }) },
    apps: { readNamespacedDeployment: () => new Promise(() => {}) },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  const rejected = assert.rejects(kubernetes.execInWorker(config, 'sv-worker-s42', ['true'], null,
    { timeoutMs: 25 }), error => error.code === 'ETIMEDOUT');
  await flush();
  t.mock.timers.tick(25);
  await rejected;
});

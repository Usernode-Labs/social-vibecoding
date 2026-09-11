const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const visuals = require('../src/services/visuals');
const config = { kubernetes: { captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def',
  workerNamespace: 'workers', workerServiceAccount: 'worker' } };
const frame = '__USERNODE_TEST__ index=0 status=pass loadStatus=200\ne30=\n__USERNODE_TEST_END__\n';
const incomplete = '__USERNODE_TEST__ index=1 status=pass loadStatus=200\ne30=';
const flush = () => new Promise(setImmediate);

function setup(t, { status = { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] },
  output = frame + incomplete, reason = 'Error', logFailure = false, logStall = false, streamOutput = null } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const events = [];
  let polls = 0;
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async () => ({}),
      readNamespacedJob: async () => ({ status: typeof status === 'function' ? status(++polls) : status }),
      deleteNamespacedJob: async () => { events.push('delete-job'); },
    },
    core: {
      createNamespacedSecret: async () => { events.push('create-secret'); },
      deleteNamespacedSecret: async () => { events.push('delete-secret'); },
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'capture-pod' }, status: {
        containerStatuses: [{ name: 'capture', state: { terminated: { reason, exitCode: reason === 'OOMKilled' ? 137 : 1 } } }],
      } }] }),
      readNamespacedPodLog: async () => {
        events.push('read-log');
        if (logStall) return new Promise(() => {});
        if (logFailure) throw new Error('log API unavailable');
        return output;
      },
    },
    ...(streamOutput === null ? {} : { logs: { log: async (_ns, _pod, _container, sink) => {
      sink.write(streamOutput);
      return { abort: () => events.push('abort-follow') };
    } } }),
  });
  t.after(() => kubernetes._setClientsForTest(null));
  return { events };
}

test('capture deadline salvages complete frames while missing checks remain an error', async (t) => {
  const shot = '__USERNODE_SHOT__ kind=after media=png status=200 bytes=3 index=0\nYWJj\n__USERNODE_SHOT_END__\n';
  const { events } = setup(t, { output: shot + frame + incomplete });
  const result = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', salvagePartial: true });
  assert.equal(result.partial, true);
  assert.equal(result.partialReason, 'run timed out');
  const { shots } = visuals.parseShots(result.stdout);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].buf.toString(), 'abc', 'a completed artifact survives the Job failure');
  const parsed = visuals.parseTests(result.stdout);
  assert.equal(parsed.length, 1, 'the incomplete second frame must not be accepted');
  assert.equal(visuals.classifyTests(parsed, 2).state, 'error');
  assert.ok(events.includes('delete-secret'));
});

test('capture OOM retains emitted frames and identifies the interruption', async (t) => {
  setup(t, { status: { failed: 1 }, reason: 'OOMKilled' });
  const result = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, salvagePartial: true });
  assert.equal(result.partialReason, 'capture OOM killed');
  assert.equal(visuals.parseTests(result.stdout).length, 1);
});

test('client deadline reads output before deleting the Job and input Secret', async (t) => {
  const { events } = setup(t, { status: {} });
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', timeoutMs: 1, salvagePartial: true });
  await flush();
  t.mock.timers.tick(16000);
  const result = await pending;
  assert.equal(result.partial, true);
  assert.equal(result.stdout, frame + incomplete);
  assert.ok(events.indexOf('read-log') < events.indexOf('delete-job'));
  assert.ok(events.indexOf('delete-job') < events.indexOf('delete-secret'));
});

test('already-followed frames survive when the final pod log cannot be read', async (t) => {
  const { events } = setup(t, { status: n => n < 2 ? {} : { succeeded: 1 }, logFailure: true, streamOutput: frame });
  const seen = [];
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, salvagePartial: true, onStdoutLine: line => seen.push(line) });
  await flush();
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.stdout, frame);
  assert.equal(result.partialReason, 'capture log unavailable');
  assert.equal(seen.filter(line => line.startsWith('__USERNODE_TEST__')).length, 1);
  assert.ok(events.includes('abort-follow'));
});

test('a stalled salvage read cannot block timed-out Job cleanup', async (t) => {
  const { events } = setup(t, { status: {}, logStall: true, streamOutput: frame });
  const pending = kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', timeoutMs: 1, salvagePartial: true });
  await flush();
  t.mock.timers.tick(16000);
  await flush();
  assert.equal(events.includes('delete-job'), false, 'attempt the final read before removing the Pod');
  t.mock.timers.tick(15000);
  const result = await pending;
  assert.equal(result.stdout, frame);
  assert.equal(result.partial, true);
  assert.ok(events.includes('delete-job'));
  assert.ok(events.includes('delete-secret'));
});

test('capture output truncation is explicit and byte-bounded', async (t) => {
  setup(t, { status: { succeeded: 1 }, output: frame + '🚀'.repeat(20) });
  const maxBuffer = Buffer.byteLength(frame) + 3;
  const result = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, salvagePartial: true, maxBuffer });
  assert.equal(result.partialReason, 'output over maxBuffer');
  assert.ok(Buffer.byteLength(result.stdout) <= maxBuffer);
  assert.equal(visuals.parseTests(result.stdout).length, 1);
});

for (const scenario of ['opt-out', 'ordinary-failure', 'empty-output', 'unit-suite']) {
  test(`partial salvage preserves throwing behavior for ${scenario}`, async (t) => {
    setup(t, { ...(scenario === 'ordinary-failure' ? { status: { failed: 1 } } : {}),
      ...(scenario === 'empty-output' ? { output: '' } : {}) });
    const run = scenario === 'unit-suite' ? kubernetes.runUnitSuiteJob : kubernetes.runCaptureJob;
    await assert.rejects(run(config, { sessionId: 42, env: {}, salvagePartial: scenario !== 'opt-out' }), /Job .* failed/);
  });
}

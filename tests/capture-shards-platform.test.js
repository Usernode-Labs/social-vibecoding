'use strict';

// services/visuals.js runCaptureShards — the platform's side of splitting
// one run's browser checks across several pods (capture/capture.js has the
// pod's side, tests/capture-shards.test.js pins it).
//
//   * shard 0 takes the screenshots, the others check only, and every pod
//     is told its shard and asks the scheduler for a shard's CPU share;
//   * the pods' output is joined in shard order and read as one pod's;
//   * a check no shard reported is run once more in a sweep pod, never left
//     to read as "produced no result", unless the run ran out of time;
//   * the done lines add up, the progress is done when every shard is, and
//     the harvest joins the shards it finds the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const visuals = require('../src/services/visuals');
const kubernetes = require('../src/services/kubernetes');
const checkHarvest = require('../src/services/check-harvest');

const frame = (index, status = 'pass') =>
  `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200\n${Buffer.from(JSON.stringify({ name: `c${index}` })).toString('base64')}\n__USERNODE_TEST_END__`;
const done = (ran, expected, { shard = null, deadline = false } = {}) =>
  `__USERNODE_TESTS_DONE__ ran=${ran} expected=${expected} deadline=${deadline ? 1 : 0}${shard ? ` shard=${shard}` : ''}`;

const tests = Array.from({ length: 9 }, (_, index) => ({ index, name: `c${index}`, path: `/p${index}`, url: `http://s/p${index}` }));
const env = {
  TARGETS: JSON.stringify([{ index: 0, afterUrl: 'http://s/' }]), BEFORE_URL: 'http://prod/', AFTER_URL: 'http://s/',
  BEFORE_FALLBACK_URL: '', BEFORE_COOKIE: 'c', AFTER_COOKIE: '', MEDIA: '1', TESTS: 'ignored',
  DEVICE_SCALE_FACTOR: '2', TEST_DEVICE_SCALE_FACTOR: '1', TEST_CONCURRENCY: '8',
};

// A fake Job runner: shard i reports the checks whose index % shards === i,
// unless `answer` says otherwise for that call.
function fakeRunner({ shards = 3, answer = {} } = {}) {
  const calls = [];
  const runJob = async (opts) => {
    calls.push(opts);
    const shard = opts.shard;
    if (answer[shard] instanceof Error) throw answer[shard];
    if (typeof answer[shard] === 'string') return { stdout: answer[shard] };
    const list = shard < shards
      ? tests.filter((t) => t.index % shards === shard)
      : JSON.parse(opts.env.TESTS === '@stdin' ? opts.stdinPayload : opts.env.TESTS);
    return {
      stdout: [...list.map((t) => frame(t.index)), done(list.length, list.length,
        shard < shards ? { shard: `${shard}/${shards}` } : {})].join('\n'),
    };
  };
  return { calls, runJob };
}

test('each shard is told its share; only the first takes the screenshots', async () => {
  const { calls, runJob } = fakeRunner();
  const out = await visuals.runCaptureShards({}, { shards: 3, tests, env, sessionId: 7, previewRunId: 'run-1', runJob });
  assert.equal(calls.length, 3, 'no sweep when every check reported');
  assert.deepEqual(calls.map((c) => [c.env.TEST_SHARD_INDEX, c.env.TEST_SHARD_COUNT]), [['0', '3'], ['1', '3'], ['2', '3']]);
  assert.deepEqual(calls.map((c) => c.nameSuffix), [null, 'k1', 'k2']);
  assert.deepEqual(calls.map((c) => c.shard), [0, 1, 2]);
  assert.ok(calls.every((c) => c.previewRunId === 'run-1' && c.sessionId === 7), 'one run, one session');
  assert.ok(calls.every((c) => c.cpuRequest === '2'), 'a shard asks for its share of the scheduler');
  assert.equal(calls[0].env.MEDIA, '1');
  assert.equal(calls[0].env.TARGETS, env.TARGETS);
  for (const c of calls.slice(1)) {
    assert.equal(c.env.MEDIA, '0');
    assert.equal(c.env.TARGETS, '[]');
    assert.equal(c.env.AFTER_URL, '', 'no scalar fallback target either');
    assert.equal(c.env.BEFORE_URL, '');
  }
  assert.ok(calls.every((c) => c.env.TEST_DEVICE_SCALE_FACTOR === '1'));
  assert.ok(calls.every((c) => c.env.TEST_CONCURRENCY === '5'),
    'a shard keeps fewer pages open than one pod did: the preview and the shared primary take them all');
  assert.ok(calls.every((c) => JSON.parse(c.env.TESTS).length === tests.length), 'every pod gets the whole list');
  assert.deepEqual([...visuals.reportedTestIndexes(out.stdout)].sort((a, b) => a - b), tests.map((t) => t.index));
  assert.deepEqual(visuals.parseTestsDone(out.stdout), { ran: 9, expected: 9, deadline: false });
  assert.equal(out.shards, 3);
});

test('a large list rides each pod\'s input Secret', async () => {
  const big = Array.from({ length: 700 }, (_, index) => ({ index, name: `c${index}`, url: `http://s/${'x'.repeat(150)}${index}` }));
  const calls = [];
  await visuals.runCaptureShards({}, {
    shards: 2, tests: big, env, sessionId: 7,
    runJob: async (opts) => { calls.push(opts); return { stdout: big.filter((t) => t.index % 2 === opts.shard).map((t) => frame(t.index)).join('\n') }; },
  });
  assert.ok(calls.every((c) => c.env.TESTS === '@stdin' && JSON.parse(c.stdinPayload).length === 700));
});

test('a lost shard\'s checks are run once more; losing the first retakes the screenshots', async () => {
  for (const lostShard of [1, 0]) {
    const { calls, runJob } = fakeRunner({ answer: { [lostShard]: new Error('exceeded quota') } });
    const out = await visuals.runCaptureShards({}, { shards: 3, tests, env, sessionId: 7, runJob });
    assert.equal(calls.length, 4, 'three shards and a sweep');
    const sweep = calls[3];
    assert.equal(sweep.nameSuffix, 'r');
    assert.equal(sweep.env.TEST_SHARD_INDEX, undefined, 'the sweep runs its list whole');
    assert.equal(sweep.env.TEST_RETRY_SLOT, '3', 'with retries numbered past every shard\'s');
    assert.deepEqual(JSON.parse(sweep.env.TESTS).map((t) => t.index), tests.filter((t) => t.index % 3 === lostShard).map((t) => t.index));
    assert.equal(sweep.env.MEDIA, lostShard === 0 ? '1' : '0');
    assert.equal(sweep.env.TARGETS, lostShard === 0 ? env.TARGETS : '[]');
    assert.deepEqual([...visuals.reportedTestIndexes(out.stdout)].sort((a, b) => a - b), tests.map((t) => t.index));
  }
});

test('a shard that came back short is swept too; one that ran out of time is not', async () => {
  const short = fakeRunner({ answer: { 2: [frame(2), done(1, 3, { shard: '2/3' })].join('\n') } });
  await visuals.runCaptureShards({}, { shards: 3, tests, env, sessionId: 7, runJob: short.runJob });
  assert.equal(short.calls.length, 4);
  assert.deepEqual(JSON.parse(short.calls[3].env.TESTS).map((t) => t.index), [5, 8]);

  const late = fakeRunner({ answer: { 2: [frame(2), done(1, 3, { shard: '2/3', deadline: true })].join('\n') } });
  const out = await visuals.runCaptureShards({}, { shards: 3, tests, env, sessionId: 7, runJob: late.runJob });
  assert.equal(late.calls.length, 3, 'the deadline already says why they are missing');
  assert.equal(visuals.parseTestsDone(out.stdout).deadline, true);
});

test('a cancelled run throws its reason, and a sweep that cannot run throws', async () => {
  const controller = new AbortController();
  const reason = new Error('superseded');
  const runJob = async () => { controller.abort(reason); throw reason; };
  await assert.rejects(visuals.runCaptureShards({}, { shards: 3, tests, env, sessionId: 7, signal: controller.signal, runJob }),
    (err) => err === reason);
  const broken = fakeRunner({ answer: { 0: new Error('no'), 1: new Error('no'), 2: new Error('no'), 3: new Error('quota') } });
  await assert.rejects(visuals.runCaptureShards({}, { shards: 3, tests, env, sessionId: 7, runJob: broken.runJob }), /quota/);
});

test('done lines: shards add up with the sweep; one pod\'s lines still keep the last', () => {
  const sharded = [done(3, 3, { shard: '0/3' }), done(2, 3, { shard: '1/3' }), done(3, 3, { shard: '2/3' }), done(1, 1)].join('\n');
  assert.deepEqual(visuals.parseTestsDone(sharded), { ran: 9, expected: 10, deadline: false });
  assert.equal(visuals.parseTestsDone([done(3, 3, { shard: '0/2', deadline: true }), done(3, 3, { shard: '1/2' })].join('\n')).deadline, true);
  assert.deepEqual(visuals.parseTestsDone([done(1, 2), done(2, 2)].join('\n')), { ran: 2, expected: 2, deadline: false });
  assert.equal(visuals.parseTestsDone(''), null);
});

test('the card is done when every shard is', () => {
  const flushes = [];
  const progress = visuals.makeChecksProgressState({ expected: 9, shards: 3, minGapMs: 0, flush: (s) => flushes.push(s) });
  progress.observeCapture(done(3, 3, { shard: '0/3' }));
  progress.observeCapture(done(3, 3, { shard: '1/3' }));
  assert.ok(flushes.every((s) => !s.done));
  progress.observeCapture(done(3, 3, { shard: '2/3' }));
  assert.equal(flushes[flushes.length - 1].done, true);
  progress.close();
  const one = visuals.makeChecksProgressState({ expected: 2, minGapMs: 0, flush: (s) => flushes.push(s) });
  one.observeCapture(done(2, 2));
  assert.equal(flushes[flushes.length - 1].done, true, 'one pod, one line, as before');
  one.close();
});

test('how many shards: three by default, CAPTURE_SHARDS=1 runs one pod', () => {
  assert.equal(visuals.captureShardCount(undefined), 3);
  assert.equal(visuals.captureShardCount(''), 3);
  assert.equal(visuals.captureShardCount('1'), 1);
  assert.equal(visuals.captureShardCount('4'), 4);
  assert.equal(visuals.captureShardCount('40'), 8);
  assert.equal(visuals.captureShardCount('nope'), 3);
  assert.equal(visuals.CAPTURE_SHARD_MIN_TESTS, 60);
});

test('captureForSession shards a large suite on Kubernetes and records it for the harvest', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const body = src.slice(src.indexOf('async function captureForSession'), src.indexOf('async function settleCaptureRun'));
  assert.match(body, /const captureShards = kubernetesCapture && !\(shotsOnly && !media\)\s+&& tests\.length >= CAPTURE_SHARD_MIN_TESTS \? captureShardCount\(\) : 1;/);
  assert.match(body, /\} else if \(kubernetesCapture && captureShards > 1\) \{\s+\(\{ stdout, \.\.\.res \} = await runCaptureShards\(config, \{/);
  assert.match(body, /captureShards,\n/, 'the manifest says how many');
  assert.match(body, /TEST_DEVICE_SCALE_FACTOR: CAPTURE_TEST_DEVICE_SCALE,/);
});

// ── The Jobs ─────────────────────────────────────────────────────────────

test('a shard\'s Job: suffixed name, shard label, its CPU request; an early unit suite\'s: its own prefix', async (t) => {
  const created = [];
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async ({ body }) => { created.push(body); return { metadata: { uid: 'u' } }; },
      readNamespacedJob: async () => ({ status: { succeeded: 1 } }),
      deleteNamespacedJob: async () => {},
    },
    core: {
      createNamespacedSecret: async ({ body }) => body,
      readNamespacedSecret: async () => ({ metadata: {} }),
      replaceNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async () => {},
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'p' }, status: {} }] }),
      readNamespacedPodLog: async () => '',
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  const config = { kubernetes: { captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def',
    workerNamespace: 'workers', workerServiceAccount: 'worker' } };
  const runId = '26a0269b-fc1c-4906-8c31-387e7e0f946c';
  await kubernetes.runCaptureJob(config, { sessionId: 7652, env: {}, previewRunId: runId, shard: 2, nameSuffix: 'k2', cpuRequest: '2', cpus: '8' });
  await kubernetes.runCaptureJob(config, { sessionId: 7652, env: {}, previewRunId: runId });
  await kubernetes.runUnitSuiteJob(config, { sessionId: 7652, env: {}, cmd: ['true'], previewRunId: runId, namePrefix: 'sv-unit-early' });
  const [shard, plain, early] = created;
  assert.equal(shard.metadata.name, `sv-capture-s7652-${runId}-k2`);
  assert.ok(shard.metadata.name.length <= 63);
  assert.equal(shard.metadata.labels['social.usernode.io/capture-shard'], '2');
  assert.equal(shard.spec.template.spec.containers[0].resources.requests.cpu, '2');
  assert.equal(plain.metadata.name, `sv-capture-s7652-${runId}`, 'unsharded, the name it always had');
  assert.equal(plain.metadata.labels['social.usernode.io/capture-shard'], undefined);
  assert.equal(plain.spec.template.spec.containers[0].resources.requests.cpu, '4');
  assert.equal(early.metadata.name, `sv-unit-early-s7652-${runId}`);
  assert.equal(early.spec.template.spec.containers[0].name, 'unit-suite', 'the container keeps its name, so its log reads as one');
});

test('findCheckJobs: every capture shard, and an early unit suite counts as the run\'s', async (t) => {
  const job = (name, status = {}) => ({ metadata: { name, labels: {} }, status });
  kubernetes._setClientsForTest({ batch: { listNamespacedJob: async () => ({ items: [
    job('sv-capture-s7-r1-k2'), job('sv-capture-s7-r1'), job('sv-capture-s7-r1-k1'), job('sv-unit-early-s7-r1', { succeeded: 1 }),
  ] }) }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const found = await kubernetes.findCheckJobs({ kubernetes: { workerNamespace: 'w' } }, { sessionId: 7, previewRunId: 'r1' });
  assert.deepEqual(found.captures.map((j) => j.name), ['sv-capture-s7-r1', 'sv-capture-s7-r1-k1', 'sv-capture-s7-r1-k2']);
  assert.equal(found.capture.name, 'sv-capture-s7-r1');
  assert.equal(found.unitSuite.name, 'sv-unit-early-s7-r1');
});

test('the preview lifecycle\'s cancellation leaves an early unit suite alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'kubernetes.js'), 'utf8');
  const cancel = src.slice(src.indexOf('async function cancelPreviewChecks'), src.indexOf('function observeCheck'));
  assert.match(cancel, /if \(!name\.startsWith\(`sv-capture-s\$\{sessionId\}-`\)\s+&& !name\.startsWith\(`sv-unit-suite-s\$\{sessionId\}-`\)\) return;/);
  assert.doesNotMatch(cancel, /sv-unit-early/);
});

// ── The harvest ──────────────────────────────────────────────────────────

test('the harvest joins a run\'s shards as the live run does', () => {
  assert.equal(checkHarvest.joinCaptures([]), null);
  const one = { state: 'succeeded', stdout: 'a' };
  assert.equal(checkHarvest.joinCaptures([one]), one, 'one capture Job reads as it always has');
  const joined = checkHarvest.joinCaptures([
    { state: 'succeeded', stdout: frame(0), stderr: '' },
    { state: 'failed', stdout: frame(1), stderr: 'x', partial: true, partialReason: 'run timed out' },
  ]);
  assert.equal(joined.state, 'succeeded');
  assert.equal(joined.stdout, `${frame(0)}\n${frame(1)}`);
  assert.equal(joined.partial, true);
  assert.equal(joined.partialReason, 'run timed out');
  assert.equal(checkHarvest.joinCaptures([{ state: 'succeeded', stdout: '' }, { state: 'gone', stdout: '' }]).state, 'gone');
  assert.equal(checkHarvest.joinCaptures([{ state: 'failed', stdout: '' }, { state: 'failed', stdout: '' }]).state, 'failed');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'check-harvest.js'), 'utf8');
  assert.match(src, /if \(captureExpected && captureJobs\.length < \(Number\(manifest\.captureShards\) \|\| 1\)\) \{\s+return await redrive\(session, 'a capture shard Job not found'\);/);
  assert.match(src, /if \(manifest\.unitRunId\) \{\s+const early = await kubernetes\.findCheckJobs\(config, \{ sessionId, previewRunId: manifest\.unitRunId \}\);/);
});

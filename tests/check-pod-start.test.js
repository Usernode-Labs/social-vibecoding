'use strict';

// A check Job whose Pod never started its container (#5054, part 2):
// services/check-pod-start.js reads the Pod's start state and names the
// cause, kubernetes.runCheckJob and collectCheckJob keep that state on what
// they return and throw, and the unit suite reads a Pod that never started
// as the platform's fault (unit-suite-row isPlatformNotRun), which the error
// lane keeps retrying past the proposal's own retries.
//
// On 12 Oct 2026 one browser-check shard of PR #4883's run was scheduled
// within a minute and then sat in ContainerCreating for thirteen minutes; the
// run was stored as an error that spent the proposal's retries, and the
// re-run two minutes later passed. tests/checks-platform-fault.test.js holds
// the browser-check side: the shards, the settle step, the harvest and the
// merge gate.
//
// Run with: node --test tests/check-pod-start.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const podStart = require('../src/services/check-pod-start');
const unitSuite = require('../src/services/unit-suite');
const unitSuiteRow = require('../src/services/unit-suite-row');
const kubernetes = require('../src/services/kubernetes');

const NOW = Date.UTC(2026, 9, 12, 14, 29, 0);
const createdAgo = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();

// A V1Pod as the API returns it.
function pod({ scheduled = true, state = { waiting: { reason: 'ContainerCreating' } }, container = 'capture', minutes = 13, reason } = {}) {
  return {
    metadata: { name: 'sv-capture-s7975-x-k1-dvbq9', creationTimestamp: createdAgo(minutes) },
    spec: scheduled ? { nodeName: 'talos-2cc-re6' } : {},
    status: {
      ...(reason ? { reason } : {}),
      conditions: [{ type: 'PodScheduled', status: scheduled ? 'True' : 'False', reason: scheduled ? undefined : 'Unschedulable' }],
      containerStatuses: state ? [{ name: container, state }] : [],
    },
  };
}

// ── Reading a Pod ───────────────────────────────────────────────────────

test('readPodStart reads whether the Pod was scheduled, whether its container started, and how long it has waited', () => {
  assert.deepEqual(podStart.readPodStart(pod(), 'capture', NOW),
    { scheduled: true, started: false, waitingReason: 'ContainerCreating', evicted: false, waitedMs: 13 * 60 * 1000 });
  assert.deepEqual(podStart.readPodStart(pod({ scheduled: false, state: null }), 'capture', NOW),
    { scheduled: false, started: false, waitingReason: null, evicted: false, waitedMs: 13 * 60 * 1000 });
  const running = podStart.readPodStart(pod({ state: { running: { startedAt: createdAgo(12) } } }), 'capture', NOW);
  assert.equal(running.started, true);
  const ended = podStart.readPodStart(pod({ state: { terminated: { startedAt: createdAgo(5), exitCode: 1 } } }), 'capture', NOW);
  assert.equal(ended.started, true, 'a container that ran and ended had started');
  assert.equal(podStart.readPodStart(pod({ reason: 'Evicted', state: null }), 'capture', NOW).evicted, true);
  assert.equal(podStart.readPodStart(null, 'capture'), null, 'no Pod, no reading');
});

test('mergePodStart: once the container has started it stays started; otherwise the latest reading wins', () => {
  const waiting = podStart.readPodStart(pod({ minutes: 1 }), 'capture', NOW);
  const later = podStart.readPodStart(pod({ minutes: 9, state: { waiting: { reason: 'ErrImagePull' } } }), 'capture', NOW);
  assert.equal(podStart.mergePodStart(waiting, later).waitingReason, 'ErrImagePull');
  assert.equal(podStart.mergePodStart(waiting, later).waitedMs, 9 * 60 * 1000);
  const started = podStart.readPodStart(pod({ state: { running: { startedAt: createdAgo(1) } } }), 'capture', NOW);
  const merged = podStart.mergePodStart(started, waiting);
  assert.equal(merged.started, true, 'a later reading can never un-start a container');
  assert.equal(merged.waitingReason, null);
  assert.equal(podStart.mergePodStart(null, waiting), waiting);
  assert.equal(podStart.mergePodStart(waiting, null), waiting);
  assert.equal(podStart.mergePodStart({ ...waiting, evicted: true }, waiting).evicted, true);
});

// ── The cause ───────────────────────────────────────────────────────────

test('podStartCause names why nothing ran, and says nothing about a container that started', () => {
  const cause = (p) => podStart.podStartCause(podStart.readPodStart(p, 'capture', NOW));
  assert.deepEqual(cause(pod()), { lead: 'start', cause: 'a test pod waited 13 minutes for its container to start' });
  assert.deepEqual(cause(pod({ scheduled: false, state: null, minutes: 10 })),
    { lead: 'start', cause: 'a test pod was not scheduled onto a node within 10 minutes' });
  assert.deepEqual(cause(pod({ state: { waiting: { reason: 'ImagePullBackOff' } } })),
    { lead: 'start', cause: 'a test pod could not pull its image (ImagePullBackOff)' });
  assert.deepEqual(cause(pod({ state: { waiting: { reason: 'CreateContainerConfigError' } } })),
    { lead: 'start', cause: 'a test pod\'s container could not be configured (CreateContainerConfigError)' });
  assert.deepEqual(cause(pod({ reason: 'Evicted', state: { terminated: { startedAt: createdAgo(4) } } })),
    { lead: 'run', cause: 'its test pod was evicted' }, 'an evicted Pod is the platform\'s, started or not');
  assert.equal(cause(pod({ state: { running: { startedAt: createdAgo(12) } } })), null,
    'a container that started and then ran out of time may be the proposal\'s own load');
  assert.equal(cause(pod({ state: { terminated: { startedAt: createdAgo(9), reason: 'OOMKilled' } } })), null);
  assert.equal(podStart.podStartCause(null), null, 'an unknown Pod is never guessed to be the platform\'s fault');
  assert.deepEqual(podStart.podStartCause({ scheduled: true, started: false, waitingReason: null, evicted: false, waitedMs: null }),
    { lead: 'start', cause: 'a test pod\'s container never started' });
  assert.match(podStart.podStartCause({ scheduled: true, started: false, waitedMs: 50 * 1000 }).cause, /waited 1 minute for/);
});

test('checkStartFault reads what the runner threw: a refused create, an API lost after it, or a Pod that never started', () => {
  const refused = Object.assign(new Error('jobs is forbidden: exceeded quota: count/jobs.batch=1'), { code: 403, checkJobNotCreated: true });
  assert.deepEqual(podStart.checkStartFault(refused), { lead: 'start', cause: 'the cluster\'s job quota was full' });
  const lost = Object.assign(new Error('connect ECONNREFUSED 10.96.0.1:443'), { code: 'ECONNREFUSED', checkJobApiLost: true });
  assert.deepEqual(podStart.checkStartFault(lost), { lead: 'run', cause: 'the cluster could not be reached' });
  const never = Object.assign(new Error('Timed out waiting for capture Job'), {
    killed: true, podStart: podStart.readPodStart(pod(), 'capture', NOW),
  });
  assert.deepEqual(podStart.checkStartFault(never), { lead: 'start', cause: 'a test pod waited 13 minutes for its container to start' });
  assert.equal(podStart.checkStartFault(new Error('Preview revision is not ready for capture')), null);
  assert.equal(podStart.checkStartFault(Object.assign(new Error('x'), {
    killed: true, podStart: podStart.readPodStart(pod({ state: { running: { startedAt: createdAgo(12) } } }), 'capture', NOW),
  })), null);
  assert.equal(podStart.checkStartFault(null), null);
});

test('the browser checks\' sentence leads the way the unit suite\'s does, and fits the card', () => {
  const sentence = podStart.browserNotRunSentence({ lead: 'start', cause: 'a test pod waited 13 minutes for its container to start' });
  assert.equal(sentence, 'The browser checks could not start: a test pod waited 13 minutes for its container to start.');
  assert.equal(podStart.browserNotRunSentence({ lead: 'run', cause: 'its test pod was evicted' }),
    'The browser checks could not run: its test pod was evicted.');
  assert.ok(sentence.length <= 280, 'the card caps check_error_detail at 280 characters');
  assert.doesNotMatch(sentence, /—/, 'user-facing copy carries no em dash');
  assert.equal(podStart.browserNotRunSentence(null), null);
});

// ── The unit suite ──────────────────────────────────────────────────────

// The unit-suite row a not-run outcome becomes (unit-suite shapeOutcome).
const notRunRow = (outcome) => ({
  index: unitSuite.UNIT_CHECK_INDEX, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH,
  couldNotRun: true, failureReason: outcome.reason,
});

test('a unit-suite Pod that never started is the platform\'s fault, as a refused Job already was', () => {
  const never = Object.assign(new Error('Timed out waiting for unit-suite Job'), {
    killed: true, stdout: '', stderr: '', podStart: podStart.readPodStart(pod({ container: 'unit-suite' }), 'unit-suite', NOW),
  });
  const outcome = unitSuite.notRunOutcome({ stdout: '', stderr: '', error: never, timedOut: true });
  assert.equal(outcome.detail, 'The unit suite could not start: a test pod waited 13 minutes for its container to start.');
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(outcome)), true,
    'the error lane keeps retrying it past the proposal\'s own retries');

  const evicted = unitSuite.notRunOutcome({
    stdout: '', stderr: 'Evicted', error: Object.assign(new Error('unit-suite Job failed'), {
      captureJobTerminated: true, podStart: { scheduled: true, started: true, evicted: true, waitingReason: null, waitedMs: 1000 },
    }),
  });
  assert.match(evicted.detail, /^The unit suite could not run: its test pod was evicted\./);
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(evicted)), true);
});

test('a unit suite whose container started keeps today\'s reading, and an unknown Pod changes nothing', () => {
  const setupLog = `${unitSuite.ROOT_SENTINEL}=/work\nCloning into 'repo'...\n`;
  const started = unitSuite.notRunOutcome({
    stdout: setupLog, timedOut: true,
    error: Object.assign(new Error('Timed out'), { killed: true, podStart: { scheduled: true, started: false, waitedMs: 600000 } }),
  });
  assert.match(started.detail, /^The unit suite stopped before any test ran: cloning the repository did not finish/,
    'a log from the script means the container ran: the setup rules stay first');
  const unknown = unitSuite.notRunOutcome({ stdout: '', timedOut: true, error: Object.assign(new Error('Timed out'), { killed: true }) });
  assert.equal(unknown.detail, 'The unit suite stopped before any test ran: its job ran out of time without printing anything.');
  assert.equal(unitSuiteRow.isPlatformNotRun(notRunRow(unknown)), false);
});

test('the harvest reads a never-started Pod the same way, and one shard that never ran makes the suite one that never ran', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const tracker = unitSuite.makeUnitSuiteTracker(null);
  // Another shard reached its tests, so the tracker says the suite did.
  tracker.feed('TAP version 13');
  tracker.feed('ok 1 - a test');
  const neverStarted = podStart.readPodStart(pod({ container: 'unit-suite' }), 'unit-suite', NOW);
  const outcome = await unitSuite.outcomeFromLog({
    pool, appId: 9, sessionId: 42, succeeded: false, stdout: '', stderr: 'DeadlineExceeded', timedOut: true,
    tracker, podStart: neverStarted, shardNotRun: true,
  });
  assert.equal(outcome.row.couldNotRun, true);
  assert.equal(outcome.notRun, 'The unit suite could not start: a test pod waited 13 minutes for its container to start.');
});

// ── The runner keeps the state ──────────────────────────────────────────

const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'social-workers',
  captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def', workerServiceAccount: 'worker' } };

test.afterEach(() => kubernetes._setClientsForTest(null));

// Fake clients: the Job reads as `jobs[n]` on its n-th read (the last one
// repeats), the Pod list as `pods[n]` on its n-th list.
function fakeClients({ jobs, pods }) {
  let jobReads = 0;
  let podLists = 0;
  return {
    batch: {
      createNamespacedJob: async ({ body }) => ({ metadata: { ...body.metadata, uid: 'job-uid' } }),
      readNamespacedJob: async () => {
        const next = jobs[Math.min(jobReads, jobs.length - 1)];
        jobReads += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      deleteNamespacedJob: async () => ({}),
    },
    core: {
      createNamespacedSecret: async ({ body }) => ({ metadata: { ...body.metadata, uid: 's-uid', resourceVersion: '1' } }),
      replaceNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async () => ({}),
      listNamespacedPod: async () => {
        const next = pods[Math.min(podLists, pods.length - 1)];
        podLists += 1;
        return { items: next ? [next] : [] };
      },
      readNamespacedPodLog: async () => '',
    },
  };
}

const RUNNING = { status: {} };
const DEADLINE = { status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] } };

test('a Job that failed by its deadline while its Pod waited for its container throws with the Pod\'s start state', async () => {
  kubernetes._setClientsForTest(fakeClients({
    jobs: [DEADLINE],
    pods: [pod({ container: 'unit-suite', state: { waiting: { reason: 'ContainerCreating' } } })],
  }));
  const err = await kubernetes.runUnitSuiteJob(config, { sessionId: 42, env: { REPO_URL: 'x' }, cmd: ['true'], previewRunId: 'run' })
    .then(() => assert.fail('a failed Job throws'), (e) => e);
  assert.equal(err.killed, true);
  assert.equal(err.podStart.started, false);
  assert.equal(err.podStart.waitingReason, 'ContainerCreating');
  assert.deepEqual(podStart.checkStartFault(err).lead, 'start');
});

test('the start state read while the Job waited is kept when the Pod is gone by the time the failure is read', async () => {
  kubernetes._setClientsForTest(fakeClients({
    jobs: [RUNNING, DEADLINE],
    pods: [pod({ container: 'unit-suite' }), null],
  }));
  const err = await kubernetes.runUnitSuiteJob(config, { sessionId: 42, env: { REPO_URL: 'x' }, cmd: ['true'], previewRunId: 'run' })
    .then(() => assert.fail('a failed Job throws'), (e) => e);
  assert.ok(err.podStart, 'remembered from the reading taken while it ran');
  assert.equal(err.podStart.started, false);
  assert.equal(err.podStart.waitingReason, 'ContainerCreating');
});

test('a capture Job\'s partial result carries the start state, and an API lost after the create is marked', async () => {
  kubernetes._setClientsForTest(fakeClients({ jobs: [DEADLINE], pods: [pod()] }));
  const res = await kubernetes.runCaptureJob(config, {
    sessionId: 42, env: {}, stdinPayload: '{}', previewRunId: 'run', salvagePartial: true, timeoutMs: 60000,
  });
  assert.equal(res.partial, true);
  assert.equal(res.partialReason, 'run timed out');
  assert.equal(res.podStart.started, false);
  assert.deepEqual(podStart.podStartCause(res.podStart).lead, 'start');

  kubernetes._setClientsForTest(fakeClients({
    jobs: [Object.assign(new Error('connect ECONNREFUSED 10.96.0.1:443'), { code: 'ECONNREFUSED' })], pods: [null],
  }));
  const lost = await kubernetes.runCaptureJob(config, { sessionId: 42, env: {}, stdinPayload: '{}', previewRunId: 'run', salvagePartial: true })
    .then(() => assert.fail('the lost API throws'), (e) => e);
  assert.equal(lost.checkJobApiLost, true);
  assert.equal(lost.checkJobNotCreated, undefined, 'the Job was created; it was the read after it that failed');
  assert.deepEqual(podStart.checkStartFault(lost), { lead: 'run', cause: 'the cluster could not be reached' });
});

test('collectCheckJob returns the start state with every outcome', async () => {
  kubernetes._setClientsForTest({
    batch: { readNamespacedJob: async () => DEADLINE },
    core: { listNamespacedPod: async () => ({ items: [pod({ container: 'capture' })] }), readNamespacedPodLog: async () => '' },
  });
  const failed = await kubernetes.collectCheckJob(config, { name: 'sv-capture-s42-x', kind: 'capture' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.podStart.started, false);
  kubernetes._setClientsForTest({
    batch: { readNamespacedJob: async () => { throw Object.assign(new Error('not found'), { code: 404 }); } },
    core: { listNamespacedPod: async () => ({ items: [] }) },
  });
  const gone = await kubernetes.collectCheckJob(config, { name: 'sv-capture-s42-x', kind: 'capture' });
  assert.equal(gone.state, 'gone');
  assert.equal(gone.podStart, null, 'nothing was seen, so nothing is guessed');
});

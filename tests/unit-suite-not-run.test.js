'use strict';

// A unit suite that never ran is not a proposal whose tests failed.
//
// On 7 Oct 2026 the worker namespace hit its quota, and the unit suite's
// input Secret or Job create was refused ("exceeded quota: … requested:
// secrets=1", "count/jobs.batch=1"). The refusal carried no output, so the
// row read "Suite setup failed (clone / npm ci), so the tests never ran.",
// the quota message was lost, and a merge-blocking suite made the run
// 'failing': blamed on the proposal, never retried, and written to its check
// history. Proposal 7022 reached the same row from a pod that ended with
// "BackoffLimitExceeded: Error" and no test output.
//
// The rules pinned here:
//
//   * a suite that never reached `npm test` (a refused or unanswered create,
//     a pod that stopped while cloning or installing, a Job whose log held
//     nothing) keeps a row marked `couldNotRun` whose reason names the cause
//     in plain words, and records no check history;
//   * when that suite is merge-blocking the run is 'error', the same lane a
//     refused capture takes: storeChecks bumps the streak and schedules the
//     retry, and check_error_detail is the row's sentence;
//   * an advisory one leaves the verdict alone;
//   * an install that failed is split by npm's own error code
//     (unit-suite.js INSTALL_FAILURES): the proposal's own package files
//     (ETARGET, E404, ERESOLVE, an out-of-sync lockfile, a failing install
//     script, …) make a failing row with history, worded the same way; the
//     network, the registry, the disk or the machine make a not-run row;
//     output nothing listed knows is the platform's, and is logged;
//   * anything that says `npm test` started (the setup sentinel, a test
//     line, a summary counter above zero, or the live stream having seen
//     one) keeps the verdict the exit code gave. A real failure stays
//     'failing'.
//
// Run with: node --test tests/unit-suite-not-run.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const unitSuite = require('../src/services/unit-suite');
const unitSuiteRow = require('../src/services/unit-suite-row');
const visuals = require('../src/services/visuals');
const kubernetes = require('../src/services/kubernetes');
const github = require('../src/services/github');
const checkHistory = require('../src/services/check-history');
const lifecycle = require('../src/services/preview-lifecycle');
const ws = require('../src/services/ws');
const appManifest = require('../src/services/app-manifest');
const tools = require('../src/services/mcp-tools');
const mergeRequirements = require('../src/services/merge-requirements');

const { ROOT_SENTINEL, CLONED_SENTINEL, SETUP_DONE_SENTINEL } = unitSuite;
const UNIT_KEY = appManifest.checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
const SHA = 'abc123';

// What @kubernetes/client-node 1.x throws when the namespace quota refuses a
// create: the Status body JSON-encoded inside the message.
function apiError(code, status, extra = {}) {
  const body = JSON.stringify({ kind: 'Status', status: 'Failure', message: status, reason: 'Forbidden', code });
  return Object.assign(new Error(`HTTP-Code: ${code}\nMessage: Unknown API Status Code!\nBody: ${JSON.stringify(body)}\nHeaders: {"audit-id":"a1"}`),
    { code, body, ...extra });
}
const JOB_QUOTA = 'jobs.batch "sv-unit-suite-s7022-run" is forbidden: exceeded quota: social-workers, '
  + 'requested: count/jobs.batch=1, used: count/jobs.batch=100, limited: count/jobs.batch=100';
const SECRET_QUOTA = 'secrets "sv-unit-suite-s7022-run-input" is forbidden: exceeded quota: social-workers, '
  + 'requested: secrets=1, used: secrets=200, limited: secrets=200';
const JOB_FAILED = 'BackoffLimitExceeded: Error';
const terminated = (extra = {}) => ({ captureJobTerminated: true, code: 1, ...extra });
const setupLog = (...lines) => [`${ROOT_SENTINEL}=/tmp/tmp.Ws`, ...lines].join('\n');

// ── Where the line is drawn ─────────────────────────────────────────────

test('a create the quota refused could not start, and the quota message is kept', () => {
  for (const [message, raw] of [[JOB_QUOTA, JOB_QUOTA], [SECRET_QUOTA, SECRET_QUOTA]]) {
    const out = unitSuite.notRunOutcome({ error: apiError(403, message, { checkJobNotCreated: true }) });
    assert.equal(out.detail, 'The unit suite could not start: the cluster\'s job quota was full.');
    assert.equal(out.reason, `${out.detail} | ${raw}`, 'the API\'s own words follow the sentence, without the client\'s wrapper');
  }
  // A plain Error, as some refusals arrive, reads the same.
  const plain = Object.assign(new Error(`exceeded quota: ${SECRET_QUOTA}`), { code: 403, checkJobNotCreated: true });
  assert.match(unitSuite.notRunOutcome({ error: plain }).detail, /job quota was full/);
});

test('other refused or unanswered creates say which, in plain words', () => {
  const start = (err) => unitSuite.notRunOutcome({ error: Object.assign(err, { checkJobNotCreated: true }) }).detail;
  assert.equal(start(apiError(403, 'jobs.batch is forbidden: User "worker" cannot create resource "jobs"')),
    'The unit suite could not start: the cluster refused to create its job.');
  assert.equal(start(apiError(409, 'jobs.batch "sv-unit-suite-s1-run" already exists')),
    'The unit suite could not start: a job with the same name was already there.');
  assert.equal(start(Object.assign(new Error('request to https://10.0.0.1:443/apis/batch/v1 failed, reason: connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })),
    'The unit suite could not start: the cluster could not be reached.');
  assert.equal(start(apiError(500, 'etcdserver: request timed out')),
    'The unit suite could not start: the cluster answered with an error (HTTP 500).');
});

test('a runner that failed before the Job ended could not run, and says what it said', () => {
  const out = unitSuite.notRunOutcome({ error: new Error('KUBERNETES_WORKER_IMAGE must be an immutable digest') });
  assert.equal(out.detail, 'The unit suite could not run: its runner failed (KUBERNETES_WORKER_IMAGE must be an immutable digest).');
  assert.equal(out.reason, out.detail, 'its words are in the sentence already');
  assert.equal(unitSuite.notRunOutcome({ error: apiError(503, 'the server is currently unable to handle the request') }).detail,
    'The unit suite could not run: the cluster answered with an error (HTTP 503).');
});

test('a pod that stopped in setup names the step, and npm\'s last line', () => {
  const install = unitSuite.notRunOutcome({
    stdout: setupLog(CLONED_SENTINEL, 'npm error code ECONNRESET', 'npm error network aborted'),
    stderr: JOB_FAILED, error: terminated(),
  });
  assert.equal(install.detail, 'The unit suite stopped before any test ran: installing its dependencies failed: '
    + 'the package registry could not be reached (npm error code ECONNRESET). Last output: npm error network aborted');
  assert.equal(install.reason, `${install.detail} | npm error code ECONNRESET | npm error network aborted | ${JOB_FAILED}`);
  assert.equal(install.ownFailure, undefined, 'the network is the platform\'s');

  const clone = unitSuite.notRunOutcome({ stdout: setupLog('unit-suite: could not fetch usernode/s42'), stderr: JOB_FAILED, error: terminated({ code: 90 }) });
  assert.match(clone.detail, /^The unit suite stopped before any test ran: the repository could not be cloned\. Last output: unit-suite: could not fetch/);

  const slow = unitSuite.notRunOutcome({ stdout: setupLog(CLONED_SENTINEL), stderr: 'DeadlineExceeded', timedOut: true, error: terminated({ killed: true }) });
  assert.equal(slow.detail, `The unit suite stopped before any test ran: installing its dependencies did not finish in ${unitSuite.UNIT_SUITE_TIMEOUT_MS / 1000}s.`);
  const oom = unitSuite.notRunOutcome({ stdout: setupLog(CLONED_SENTINEL), stderr: 'BackoffLimitExceeded: OOMKilled', timedOut: true, error: terminated({ killed: true }) });
  assert.equal(oom.detail, 'The unit suite stopped before any test ran: it ran out of memory while installing its dependencies.');
});

test('proposal 7022: a Job that ended with nothing in its log never ran the suite', () => {
  const out = unitSuite.notRunOutcome({ stdout: '', stderr: JOB_FAILED, error: terminated() });
  assert.equal(out.detail, 'The unit suite stopped before any test ran: its job ended without printing anything.');
  assert.match(out.reason, /\| BackoffLimitExceeded: Error/);
  // Pending until its deadline on a full cluster.
  assert.equal(unitSuite.notRunOutcome({ stdout: '', stderr: 'DeadlineExceeded', timedOut: true, error: terminated({ killed: true }) }).detail,
    'The unit suite stopped before any test ran: its job ran out of time without printing anything.');
});

test('Docker: a container that never started could not start', () => {
  const out = unitSuite.notRunOutcome({
    runtime: 'docker', stdout: '', stderr: 'docker: Error response from daemon: No such image: usernode-worker:latest.',
    error: { code: 125 },
  });
  assert.equal(out.detail, 'The unit suite could not start: Docker could not run its container.');
  assert.match(out.reason, /No such image/);
  // npm's errors arrive on Docker's own stderr, and are read there.
  const install = unitSuite.notRunOutcome({
    runtime: 'docker', stdout: setupLog(CLONED_SENTINEL), stderr: 'npm error code ERESOLVE', error: { code: 1 },
  });
  assert.match(install.detail, /installing its dependencies failed \(npm error code ERESOLVE\)\. Last output: npm error code ERESOLVE$/);
  assert.equal(install.ownFailure, true);
  // Docker's own word for a container killed for memory is exit 137.
  assert.match(unitSuite.notRunOutcome({
    runtime: 'docker', stdout: setupLog(CLONED_SENTINEL), stderr: 'npm error code 1', error: { code: 137 },
  }).detail, /it ran out of memory while installing its dependencies\./);
});

// ── An install that failed: the proposal's, or the platform's ────────────

const install = (...npm) => unitSuite.notRunOutcome({
  stdout: setupLog(CLONED_SENTINEL, ...npm), stderr: JOB_FAILED, error: terminated(),
});

test('an install that failed on the proposal\'s own package files is the proposal\'s failure', () => {
  const cases = [
    [['npm error code ETARGET', 'npm error notarget No matching version found for left-pad@^99.0.0.'], 'npm error code ETARGET'],
    [['npm error code E404', 'npm error 404 Not Found - GET https://registry.npmjs.org/no-such-pkg - Not found'], 'npm error code E404'],
    [['npm error code ERESOLVE', 'npm error ERESOLVE unable to resolve dependency tree'], 'npm error code ERESOLVE'],
    [['npm error code EJSONPARSE', 'npm error JSON.parse Unexpected token "}" in package.json'], 'npm error code EJSONPARSE'],
    [['npm error code EBADENGINE', 'npm error engine Unsupported engine'], 'npm error code EBADENGINE'],
    [['npm error code EINTEGRITY', 'npm error sha512-… integrity checksum failed'], 'npm error code EINTEGRITY'],
    [['npm error code ENOVERSIONS', 'npm error No versions available for x'], 'npm error code ENOVERSIONS'],
    [['npm error code EUSAGE', 'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'],
      'npm error code EUSAGE'],
    // npm 6 words a failed lifecycle script with its own code.
    [['npm ERR! code ELIFECYCLE', 'npm ERR! errno 1'], 'npm error code ELIFECYCLE'],
    // npm 10: a postinstall that exits non-zero prints a numeric code.
    [['npm error code 1', 'npm error path /tmp/tmp.Ws/node_modules/thing', 'npm error command failed', 'npm error command sh -c node postinstall.js'],
      'an install script exited with an error'],
    // An old npm that names no code for an out-of-sync lockfile.
    [['npm ERR! cipm can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'],
      'its package.json and package-lock.json are out of sync'],
  ];
  for (const [lines, said] of cases) {
    const out = install(...lines);
    assert.equal(out.ownFailure, true, said);
    assert.ok(out.detail.startsWith(`The unit suite stopped before any test ran: installing its dependencies failed (${said}).`), out.detail);
  }
  assert.equal(install('npm error code ETARGET', 'npm error notarget No matching version found for left-pad@^99.0.0.').detail,
    'The unit suite stopped before any test ran: installing its dependencies failed (npm error code ETARGET). '
    + 'Last output: npm error notarget No matching version found for left-pad@^99.0.0.');
});

test('an install the network, registry, disk or machine failed is the platform\'s', () => {
  const cases = [
    [['npm error code ECONNRESET', 'npm error network aborted'], 'the package registry could not be reached (npm error code ECONNRESET)'],
    [['npm error code ETIMEDOUT'], 'the package registry could not be reached (npm error code ETIMEDOUT)'],
    [['npm error code EAI_AGAIN', 'npm error request to https://registry.npmjs.org/x failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org'],
      'the package registry could not be reached (npm error code EAI_AGAIN)'],
    [['npm error code ENOTFOUND'], 'the package registry could not be reached (npm error code ENOTFOUND)'],
    [['npm error code ECONNREFUSED'], 'the package registry could not be reached (npm error code ECONNREFUSED)'],
    [['npm error network socket hang up'], 'the package registry could not be reached'],
    [['npm error code E503', 'npm error 503 Service Unavailable - GET https://registry.npmjs.org/x'],
      'the package registry answered with an error (npm error code E503)'],
    [['npm error code E429', 'npm error 429 Too Many Requests - GET https://registry.npmjs.org/x'],
      'the package registry answered with an error (npm error code E429)'],
    [['npm error code ENOSPC', 'npm error nospc ENOSPC: no space left on device, write'], 'the machine ran out of disk space (npm error code ENOSPC)'],
    [['<--- JS stacktrace --->', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'], 'the machine ran out of memory'],
  ];
  for (const [lines, said] of cases) {
    const out = install(...lines);
    assert.equal(out.ownFailure, undefined, said);
    assert.equal(out.unrecognised, undefined, said);
    assert.ok(out.detail.startsWith(`The unit suite stopped before any test ran: installing its dependencies failed: ${said}.`), out.detail);
  }
  // The code npm ends on decides, over a word that appears earlier.
  assert.equal(install('npm warn retry ECONNRESET, retrying', 'npm error code ETARGET').ownFailure, true);
});

test('an install failure nothing listed knows is the platform\'s, and its last line is kept for the log', () => {
  const out = install('npm error code EWHATEVER', 'npm error something new went wrong');
  assert.equal(out.ownFailure, undefined);
  assert.equal(out.unrecognised, 'npm error something new went wrong');
  assert.equal(out.detail, 'The unit suite stopped before any test ran: installing its dependencies failed. '
    + 'Last output: npm error something new went wrong');
  assert.ok(Object.isFrozen(unitSuite.INSTALL_FAILURES), 'one list, in one place');
});

test('anything that says `npm test` started keeps its verdict', () => {
  const ran = [
    // The setup sentinel, with or without a test after it.
    { stdout: setupLog(CLONED_SENTINEL, SETUP_DONE_SENTINEL, 'something broke'), stderr: JOB_FAILED, error: terminated() },
    // A failing test line, the start of the log lost (#4265).
    { stdout: 'not ok 1 - regression\n# fail 1', stderr: JOB_FAILED, error: terminated() },
    // Only a summary that counts tests.
    { stdout: '# tests 21748\n# pass 21730\n# fail 18', stderr: JOB_FAILED, error: terminated() },
    // Killed at the deadline while the tests ran.
    { stdout: setupLog(CLONED_SENTINEL, SETUP_DONE_SENTINEL, 'ok 1 - a'), stderr: 'DeadlineExceeded', timedOut: true, error: terminated({ killed: true }) },
    // The final log came back empty, but the live stream saw the suite start.
    { stdout: '', stderr: JOB_FAILED, error: terminated(), reachedTests: true },
    // Docker: the suite's own failure on stderr after the sentinel.
    { runtime: 'docker', stdout: setupLog(CLONED_SENTINEL, SETUP_DONE_SENTINEL), stderr: 'npm error Test failed.', error: { code: 1 } },
  ];
  for (const input of ran) assert.equal(unitSuite.notRunOutcome(input), null, JSON.stringify(input).slice(0, 120));
});

test('output it cannot place keeps the failing verdict it had before', () => {
  // A non-TAP runner whose log lost its start: no workspace line, no
  // sentinel, no test line. It may have been a red suite.
  assert.equal(unitSuite.notRunOutcome({ stdout: 'FAIL src/cart.test.js\n  expected 2, got 3', stderr: JOB_FAILED, error: terminated() }), null);
});

test('the copy is plain, short, and carries no em dash or secret', () => {
  const out = unitSuite.notRunOutcome({
    stdout: setupLog('fatal: could not read from https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/o/r.git'),
    stderr: JOB_FAILED, error: terminated({ code: 90 }),
  });
  assert.doesNotMatch(out.reason, /ghs_abcdefghijklmnopqrstuvwxyz/);
  for (const d of [out.detail, unitSuite.notRunOutcome({ error: apiError(403, JOB_QUOTA, { checkJobNotCreated: true }) }).detail]) {
    assert.ok(d.length <= 280, 'the card caps check_error_detail at 280 characters');
    assert.doesNotMatch(d, /—|&mdash;/);
    assert.doesNotMatch(d, / \| /, 'the sentence never splits where the row\'s reason does');
  }
});

// ── kubernetes.runCheckJob marks a create that never happened ────────────

const k8sConfig = {
  workerRuntime: 'kubernetes', captureRuntime: 'kubernetes',
  kubernetes: { workerNamespace: 'social-workers', captureImage: 'capture@sha256:abc', workerImage: 'worker@sha256:def', workerServiceAccount: 'worker' },
};

test('a refused Secret or Job create is marked; a Job that ran and failed is not', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const quiet = { deleteNamespacedSecret: async () => {} };
  kubernetes._setClientsForTest({
    batch: {},
    core: { ...quiet, createNamespacedSecret: async () => { throw apiError(403, SECRET_QUOTA); } },
  });
  const secret = await kubernetes.runUnitSuiteJob(k8sConfig, { sessionId: 1, env: { REPO_URL: 'x' }, cmd: ['true'], previewRunId: 'run' })
    .then(() => assert.fail('refused'), (err) => err);
  assert.equal(secret.checkJobNotCreated, true);

  kubernetes._setClientsForTest({
    batch: { createNamespacedJob: async () => { throw apiError(403, JOB_QUOTA); } },
    core: { ...quiet, createNamespacedSecret: async ({ body }) => ({ metadata: { ...body.metadata, resourceVersion: '1' } }) },
  });
  const job = await kubernetes.runUnitSuiteJob(k8sConfig, { sessionId: 1, env: { REPO_URL: 'x' }, cmd: ['true'], previewRunId: 'run' })
    .then(() => assert.fail('refused'), (err) => err);
  assert.equal(job.checkJobNotCreated, true);
  assert.match(job.message, /exceeded quota/, 'the error itself is untouched');

  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async ({ body }) => ({ metadata: { ...body.metadata, uid: 'j1' } }),
      readNamespacedJob: async () => ({ status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } }),
    },
    core: {
      ...quiet,
      createNamespacedSecret: async ({ body }) => ({ metadata: { ...body.metadata, resourceVersion: '1' } }),
      replaceNamespacedSecret: async () => ({}),
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'p' }, status: { containerStatuses: [{ name: 'unit-suite', state: { terminated: { exitCode: 1, reason: 'Error' } } }] } }] }),
      readNamespacedPodLog: async () => `${SETUP_DONE_SENTINEL}\nnot ok 1 - x\n`,
    },
  });
  const ran = await kubernetes.runUnitSuiteJob(k8sConfig, { sessionId: 1, env: { REPO_URL: 'x' }, cmd: ['true'], previewRunId: 'run' })
    .then(() => assert.fail('failed'), (err) => err);
  assert.equal(ran.checkJobNotCreated, undefined);
  assert.equal(ran.captureJobTerminated, true);
});

// ── maybeRunUnitSuite: the row it writes ─────────────────────────────────

function suiteEnv(t, { graduated = true } = {}) {
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getFileContent', async () => '{"scripts":{"test":"node --test"}}');
  t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
  t.mock.method(checkHistory, 'loadGraduated', async () => new Set(graduated ? [UNIT_KEY] : []));
}
const runSuite = (extra = {}) => unitSuite.maybeRunUnitSuite({
  config: k8sConfig, pool: { query: async () => ({ rows: [] }) }, appId: 9, sessionId: 7022,
  repoOwner: 'example', repoName: 'repo', ref: 'a'.repeat(40), ...extra,
});

test('a quota refusal on the live path: a not-run row, no history, and the card is told', async (t) => {
  suiteEnv(t);
  t.after(() => kubernetes._setClientsForTest(null));
  kubernetes._setClientsForTest({
    batch: { createNamespacedJob: async () => { throw apiError(403, JOB_QUOTA); } },
    core: { createNamespacedSecret: async ({ body }) => ({ metadata: { ...body.metadata, resourceVersion: '1' } }), deleteNamespacedSecret: async () => {} },
  });
  const snaps = [];
  const out = await runSuite({ onProgress: (s) => snaps.push(s) });
  assert.equal(out.row.status, 'fail', 'it did not pass');
  assert.equal(out.row.couldNotRun, true);
  assert.equal(out.row.advisory, false, 'graduated: it still guards the merge');
  assert.equal(out.row.failureReason, `The unit suite could not start: the cluster's job quota was full. | ${JOB_QUOTA}`);
  assert.equal(out.row.failureDetails, undefined);
  assert.equal(out.history, null, 'nothing observed, nothing recorded');
  assert.equal(out.notRun, 'The unit suite could not start: the cluster\'s job quota was full.');
  assert.equal(unitSuiteRow.notRunDetail(out.row), out.notRun);
  const last = snaps[snaps.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.notRun, true, 'the card says it could not run, not that it finished red');
});

test('a setup failure with no output on the live path: a not-run row', async (t) => {
  suiteEnv(t, { graduated: false });
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => {
    throw Object.assign(new Error('unit-suite Job sv-unit-suite-s7022-run failed'), { stdout: '', stderr: JOB_FAILED, code: 1, captureJobTerminated: true });
  });
  const out = await runSuite();
  assert.equal(out.row.couldNotRun, true);
  assert.equal(out.row.advisory, true, 'not yet graduated: advisory, recorded the same way');
  assert.match(out.row.failureReason, /^The unit suite stopped before any test ran: its job ended without printing anything\. \| BackoffLimitExceeded: Error/);
  assert.doesNotMatch(out.row.failureReason, /Suite setup failed/);
  assert.equal(out.history, null);
});

test('a run with real test failures is unchanged: failing row, history recorded', async (t) => {
  suiteEnv(t);
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => {
    throw Object.assign(new Error('unit-suite Job failed'), {
      stdout: setupLog(CLONED_SENTINEL, SETUP_DONE_SENTINEL, 'not ok 1 - regression', '# tests 2', '# pass 1', '# fail 1'),
      stderr: JOB_FAILED, code: 1, captureJobTerminated: true,
    });
  });
  const snaps = [];
  const out = await runSuite({ onProgress: (s) => snaps.push(s) });
  assert.equal(out.row.status, 'fail');
  assert.equal(out.row.couldNotRun, undefined);
  assert.equal(out.notRun, undefined);
  assert.match(out.row.failureReason, /^\(file not reported\) \(1\): regression \| # tests 2/);
  assert.deepEqual(out.history, { checkKey: UNIT_KEY, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH, passed: false });
  assert.equal(snaps[snaps.length - 1].notRun, undefined);
});

test('the harvest path reads a finished Job the same way', async () => {
  const empty = await unitSuite.outcomeFromLog({ pool: null, appId: 9, sessionId: 7022, succeeded: false, stdout: '', stderr: JOB_FAILED, graduated: true });
  assert.equal(empty.row.couldNotRun, true);
  assert.equal(empty.history, null);
  const network = await unitSuite.outcomeFromLog({
    pool: null, appId: 9, sessionId: 7022, succeeded: false, graduated: true,
    stdout: setupLog(CLONED_SENTINEL, 'npm error code ECONNRESET'), stderr: JOB_FAILED,
  });
  assert.match(network.notRun, /the package registry could not be reached \(npm error code ECONNRESET\)/);
  assert.equal(network.history, null);
  const own = await unitSuite.outcomeFromLog({
    pool: null, appId: 9, sessionId: 7022, succeeded: false, graduated: true,
    stdout: setupLog(CLONED_SENTINEL, 'npm error code E404'), stderr: JOB_FAILED,
  });
  assert.equal(own.row.couldNotRun, undefined);
  assert.equal(own.row.setupFailed, true);
  assert.equal(own.history.passed, false, 'the proposal\'s own failure is history');
  const killed = await unitSuite.outcomeFromLog({
    pool: null, appId: 9, sessionId: 7022, succeeded: false, graduated: true, exitCode: 137,
    stdout: setupLog(CLONED_SENTINEL, 'npm error code 1'), stderr: JOB_FAILED,
  });
  assert.match(killed.notRun, /ran out of memory while installing its dependencies/, 'the harvest passes the exit code');
  const red = await unitSuite.outcomeFromLog({
    pool: null, appId: 9, sessionId: 7022, succeeded: false, graduated: true,
    stdout: setupLog(CLONED_SENTINEL, SETUP_DONE_SENTINEL, 'not ok 1 - a', '# fail 1'), stderr: JOB_FAILED,
  });
  assert.equal(red.row.couldNotRun, undefined);
  assert.equal(red.history.passed, false);
});

// ── classifyTests: the verdict ───────────────────────────────────────────

const notRunRow = (advisory, detail = 'The unit suite could not start: the cluster\'s job quota was full.') => ({
  index: unitSuite.UNIT_CHECK_INDEX, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH,
  status: 'fail', advisory, couldNotRun: true, consoleErrors: [], failureReason: `${detail} | ${JOB_QUOTA}`,
});
const redRow = (advisory) => ({
  index: unitSuite.UNIT_CHECK_INDEX, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH,
  status: 'fail', advisory, consoleErrors: [], failureReason: 'tests/a.test.js (1): regression | # fail 1',
});
const frame = (index, status) => ({ index, status, name: `Loads /p${index}`, path: `/p${index}`, consoleErrors: [], failureReason: status === 'pass' ? '' : 'boom' });
const dispatched = [{ index: 0, checkKey: 'k0', name: 'Loads /p0', path: '/p0', graduated: true }];

test('a merge-blocking suite that never ran makes the run an error, with its sentence', () => {
  for (const opts of [{ extraRows: [notRunRow(false)] }, { dispatched, sentinel: null, extraRows: [notRunRow(false)] }]) {
    const out = visuals.classifyTests([frame(0, 'pass')], 1, opts);
    assert.equal(out.state, 'error', opts.dispatched ? 'earned gating' : 'legacy');
    assert.equal(out.errorDetail, 'The unit suite could not start: the cluster\'s job quota was full.');
    assert.ok(out.results.some(unitSuiteRow.isNotRunRow), 'the row rides along');
  }
  // Even beside a browser check that failed: the merge-blocking suite gave
  // no answer, which fails closed the way a graduated check with no verdict
  // does.
  assert.equal(visuals.classifyTests([frame(0, 'fail')], 1, { dispatched, sentinel: null, extraRows: [notRunRow(false)] }).state, 'error');
});

test('an advisory suite that never ran leaves the verdict alone', () => {
  const out = visuals.classifyTests([frame(0, 'pass')], 1, { dispatched, sentinel: null, extraRows: [notRunRow(true)] });
  assert.equal(out.state, 'passing');
  assert.equal(out.blockingCount, 0);
  assert.equal(out.errorDetail, undefined);
  assert.equal(visuals.classifyTests([frame(0, 'pass')], 1, { extraRows: [notRunRow(true)] }).state, 'passing');
});

test('a suite that ran and failed is still failing', () => {
  assert.equal(visuals.classifyTests([frame(0, 'pass')], 1, { dispatched, sentinel: null, extraRows: [redRow(false)] }).state, 'failing');
  assert.equal(visuals.classifyTests([frame(0, 'pass')], 1, { extraRows: [redRow(false)] }).state, 'failing');
  assert.equal(visuals.classifyTests([frame(0, 'pass')], 1, { dispatched, sentinel: null, extraRows: [redRow(true)] }).state, 'passing',
    'advisory, as before');
});

// ── settleCaptureRun: what is stored ─────────────────────────────────────

function makePool() {
  const pool = {
    calls: [], checks: [],
    async query(sql, params = []) {
      pool.calls.push({ sql, params });
      if (/UPDATE chat_sessions\s+SET check_state = \$1/.test(sql)) {
        const retryScheduled = /check_next_retry_at = NOW\(\) \+ make_interval/.test(sql);
        pool.checks.push({
          state: params[0], detail: retryScheduled ? params[4] : null, retryScheduled,
          streakBumped: /consecutive_check_failures = consecutive_check_failures \+ 1/.test(sql),
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: (sql, params) => pool.query(sql, params), release() {} }; },
  };
  return pool;
}

function quiet(t, pool) {
  for (const [mod, key, value] of [[lifecycle, 'current', () => ({ pool })], [ws, 'broadcastGlobal', () => {}]]) {
    const saved = mod[key];
    mod[key] = value;
    t.after(() => { mod[key] = saved; });
  }
}

const GREEN = [0, 1, 2].map((i) => `__USERNODE_TEST__ index=${i} status=pass loadStatus=200\n${Buffer.from(JSON.stringify({ name: `Board check ${i + 1}`, path: '/board', consoleErrors: [] })).toString('base64')}\n__USERNODE_TEST_END__`).join('\n');

function settle(pool, unitOutcome, sent = []) {
  return visuals.settleCaptureRun({}, pool, {
    session: { id: 42, app_id: 9, status: 'promoted', source: 'native', checks_commit_sha: SHA, branch_name: 'usernode/s42' },
    app: { id: 9, slug: 'demo', name: 'Demo', repo_url: '' },
    commitHash: SHA, trigger: 'commit-push', send: (type, data) => sent.push({ type, ...data }),
    runStartedAt: Date.now(), media: false, capturePaths: ['/board'], pathDefaulted: false,
    prodRunning: false, stagingOrigin: '', targets: [], testsCount: 3, dispatched: null, ceilingDropped: 0,
    stdout: GREEN, stderr: '', runPartial: false, runPartialReason: '', unitOutcome, overlappedRollout: false,
  });
}

async function quotaOutcome(t, { graduated = true } = {}) {
  suiteEnv(t, { graduated });
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => { throw apiError(403, JOB_QUOTA, { checkJobNotCreated: true }); });
  return runSuite();
}

test('a quota refusal: the run is an error, the retry is scheduled, no history moves', async (t) => {
  const unitOutcome = await quotaOutcome(t);
  const pool = makePool();
  quiet(t, pool);
  const sent = [];
  const out = await settle(pool, unitOutcome, sent);
  assert.equal(out.result.state, 'error');
  assert.deepEqual(pool.checks, [{
    state: 'error', detail: 'The unit suite could not start: the cluster\'s job quota was full.',
    retryScheduled: true, streakBumped: true,
  }], 'the error branch of storeChecks: the same lane a refused capture takes');
  assert.equal(sent.find((e) => e.type === 'checks_ready').checkState, 'error');
  assert.ok(!pool.calls.some((c) => /app_check_history/.test(c.sql)), 'no fail_count stamped on a suite that never ran');
});

test('a setup failure with no output: the run is an error', async (t) => {
  suiteEnv(t);
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => {
    throw Object.assign(new Error('unit-suite Job failed'), { stdout: '', stderr: JOB_FAILED, code: 1, captureJobTerminated: true });
  });
  const pool = makePool();
  quiet(t, pool);
  const out = await settle(pool, await runSuite());
  assert.equal(out.result.state, 'error');
  assert.equal(pool.checks[0].detail, 'The unit suite stopped before any test ran: its job ended without printing anything.');
  assert.equal(pool.checks[0].retryScheduled, true);
});

test('a run with real test failures: failing, as before, and its history recorded', async (t) => {
  suiteEnv(t);
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => {
    throw Object.assign(new Error('unit-suite Job failed'), {
      stdout: setupLog(CLONED_SENTINEL, SETUP_DONE_SENTINEL, 'not ok 1 - regression', '# fail 1'),
      stderr: JOB_FAILED, code: 1, captureJobTerminated: true,
    });
  });
  const pool = makePool();
  quiet(t, pool);
  const out = await settle(pool, await runSuite());
  assert.equal(out.result.state, 'failing');
  assert.deepEqual(pool.checks.map((c) => [c.state, c.retryScheduled]), [['failing', false]]);
  assert.ok(pool.calls.some((c) => /app_check_history/.test(c.sql)), 'a verdict about the code is history');
});

function installFailed(t, ...npm) {
  suiteEnv(t);
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => {
    throw Object.assign(new Error('unit-suite Job failed'), {
      stdout: setupLog(CLONED_SENTINEL, ...npm), stderr: JOB_FAILED, code: 1, captureJobTerminated: true,
    });
  });
  return runSuite();
}

test('an ETARGET install failure is the proposal\'s: failing, with history, in the clear wording', async (t) => {
  const unitOutcome = await installFailed(t, 'npm error code ETARGET', 'npm error notarget No matching version found for left-pad@^99.0.0.');
  assert.equal(unitOutcome.row.setupFailed, true);
  assert.equal(unitOutcome.row.couldNotRun, undefined);
  assert.match(unitOutcome.row.failureReason, /^The unit suite stopped before any test ran: installing its dependencies failed \(npm error code ETARGET\)\./);
  const pool = makePool();
  quiet(t, pool);
  const out = await settle(pool, unitOutcome);
  assert.equal(out.result.state, 'failing');
  assert.deepEqual(pool.checks.map((c) => [c.state, c.retryScheduled]), [['failing', false]], 'no retry for a lockfile that will not install');
  const history = pool.calls.find((c) => /app_check_history/.test(c.sql));
  assert.ok(history && history.params.includes(UNIT_KEY), 'recorded as the unit suite\'s failure');
});

test('an ECONNRESET install failure is the platform\'s: error, and the retry is scheduled', async (t) => {
  const unitOutcome = await installFailed(t, 'npm error code ECONNRESET', 'npm error network aborted');
  assert.equal(unitOutcome.row.couldNotRun, true);
  const pool = makePool();
  quiet(t, pool);
  const out = await settle(pool, unitOutcome);
  assert.equal(out.result.state, 'error');
  assert.deepEqual(pool.checks, [{
    state: 'error',
    detail: 'The unit suite stopped before any test ran: installing its dependencies failed: the package registry could not be reached '
      + '(npm error code ECONNRESET). Last output: npm error network aborted',
    retryScheduled: true, streakBumped: true,
  }]);
  assert.ok(!pool.calls.some((c) => /app_check_history/.test(c.sql)));
});

test('an install failure nothing listed knows is logged with its last line', async (t) => {
  const log = require('../src/services/logger');
  const warned = [];
  t.mock.method(log, 'warn', (category, message, data) => warned.push({ category, message, data }));
  const unitOutcome = await installFailed(t, 'npm error code EWHATEVER', 'npm error something new went wrong');
  assert.equal(unitOutcome.row.couldNotRun, true, 'read as the platform\'s');
  const w = warned.find((x) => x.message === 'Unrecognised install failure, read as the platform\'s');
  assert.ok(w, 'logged so the list can grow');
  assert.equal(w.data.lastLine, 'npm error something new went wrong');
  assert.equal(w.data.sessionId, 7022);
});

test('an advisory suite that could not run: the run keeps its verdict, and records no unit history', async (t) => {
  const unitOutcome = await quotaOutcome(t, { graduated: false });
  const pool = makePool();
  quiet(t, pool);
  const out = await settle(pool, unitOutcome);
  assert.equal(out.result.state, 'passing');
  assert.deepEqual(pool.checks.map((c) => c.state), ['passing']);
  const history = pool.calls.filter((c) => /app_check_history/.test(c.sql));
  assert.ok(history.every((c) => !c.params.includes(UNIT_KEY)), 'the unit suite neither fails nor graduates');
});

// ── What people and agents read ──────────────────────────────────────────

const ORIGIN = 'https://social-vibecoding.usernodelabs.org';
const DETAIL = 'The unit suite could not start: the cluster\'s job quota was full.';
const errored = (over = {}) => ({
  id: 7022, app_slug: 'recipe-box', status: 'promoted', pr_number: 41, branch_name: 'usernode/s7022',
  check_state: 'error', check_error_detail: DETAIL,
  test_results: [{ name: 'Board loads', path: '/', status: 'pass', consoleErrors: [] }, notRunRow(false)],
  ...over,
});

test('the stored row is recognised for what it is', () => {
  assert.equal(unitSuiteRow.notRunError(errored()), DETAIL);
  assert.equal(unitSuiteRow.notRunError(errored({ test_results: JSON.stringify(errored().test_results) })), DETAIL);
  assert.equal(unitSuiteRow.notRunError(errored({ check_error_detail: 'Browser check runner produced no result frames.' })), null,
    'an error with another cause is that cause');
  assert.equal(unitSuiteRow.notRunError(errored({ check_state: 'failing' })), null);
  assert.equal(unitSuiteRow.unitSuiteFailures([notRunRow(false)]), null, 'it names no failing test');
});

test('the connector lists no failing test and says what happens next', () => {
  // The row storeChecks wrote: the streak bumped and a retry scheduled.
  const retrying = errored({ consecutive_check_failures: 1, check_next_retry_at: new Date(Date.now() + 120000).toISOString() });
  const shaped = tools.shapeProposal(retrying, ORIGIN);
  assert.deepEqual(shaped.checks.failing, []);
  assert.equal(shaped.checks.failingTotal, 0);
  assert.equal(shaped.checks.error, `<untrusted-content>${DETAIL}</untrusted-content>`);
  assert.match(shaped.nextStep, /^The repo unit suite \(npm test\) could not run on PR #41 \(proposal 7022\), so there is no verdict yet: /);
  assert.match(shaped.nextStep, /No test failed\. Homeroom runs errored checks again on its own, waiting longer between tries; poll get_proposal/);
  assert.doesNotMatch(shaped.nextStep, /Fix the build|Fix the named tests|—/);
  const change = tools.changeNextStep(retrying, tools.shapeChecks(retrying), {}, 'external');
  assert.match(change, /could not run on .*so there is no verdict yet, and no test failed\. Homeroom runs the checks again on its own/);

  // Past the retry cap nothing runs it again, and nothing says it will.
  const capped = errored({ consecutive_check_failures: 6, check_next_retry_at: new Date().toISOString() });
  assert.match(tools.shapeProposal(capped, ORIGIN).nextStep,
    /No test failed\. Homeroom will not run them again on its own now; recheck_change re-runs them once the cause has cleared\./);
  assert.match(tools.changeNextStep(capped, tools.shapeChecks(capped), {}, 'external'),
    /no test failed\. recheck_change re-runs the checks once the cause has cleared\.$/);
});

test('the merge requirements do not blame the preview', () => {
  const step = mergeRequirements.provisional(errored()).find((s) => s.key === 'checks');
  assert.equal(step.state, 'blocked', 'still no verdict, so still no merge');
  assert.equal(step.detail.note, 'the unit suite could not run, so there is no verdict yet');
  const other = mergeRequirements.provisional(errored({ check_error_detail: 'boot failed' })).find((s) => s.key === 'checks');
  assert.match(other.detail.note, /staging preview could not start/);
});

test('the merge gate words the block for the unit suite, not the preview', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/votes.js'), 'utf8');
  const gate = src.slice(src.indexOf("const errorDetail = checkState === 'error'"));
  assert.match(gate, /notRunError\(\{ \.\.\.checkRows\[0\], check_state: checkState \}\)/);
  assert.match(gate, /`couldn't run its unit suite, so its checks have no verdict yet \(\$\{errorDetail\}\)`/);
  assert.match(gate, /'the unit suite could not run, so there is no verdict yet'/);
});

'use strict';

// Browser checks that could not start are the platform's fault (#5054,
// part 2). A capture Job the API refused or lost, or a shard whose Pod never
// started its container, was stored as the proposal's "couldn't run" error
// and spent its six automatic retries. Now:
//
//   * runCaptureShards and the harvest's joinCaptures name the shards that
//     reported nothing because their Pod never started (`notStarted`);
//   * settleCaptureRun stores a run left with checks missing for that reason
//     as a platform fault, worded "The browser checks could not start: …";
//   * a harvest that finds such a shard runs the checks once more, as the
//     live run's sweep would have, and stores the platform fault the second
//     time;
//   * the merge gate reads a platform fault the error lane still covers as
//     in progress, so the card says the checks will run again.
//
// tests/check-pod-start.test.js holds the Pod readings and the unit suite.
//
// Run with: node --test tests/checks-platform-fault.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();

const visuals = require('../src/services/visuals');
const harvest = require('../src/services/check-harvest');
const kubernetes = require('../src/services/kubernetes');
const stagingRecovery = require('../src/services/staging-recovery');
const lifecycle = require('../src/services/preview-lifecycle');
const mergeRequirements = require('../src/services/merge-requirements');
const ws = require('../src/services/ws');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

const NEVER = { scheduled: true, started: false, waitingReason: 'ContainerCreating', evicted: false, waitedMs: 13 * 60 * 1000 };
const STARTED = { scheduled: true, started: true, waitingReason: null, evicted: false, waitedMs: 13 * 60 * 1000 };
const SENTENCE = 'The browser checks could not start: a test pod waited 13 minutes for its container to start.';

function frame(index, status = 'pass') {
  const payload = Buffer.from(JSON.stringify({ name: `c${index}`, path: `/p${index}`, consoleErrors: [] })).toString('base64');
  return `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200\n${payload}\n__USERNODE_TEST_END__`;
}

// ── The live run's shards ───────────────────────────────────────────────

const TESTS = Array.from({ length: 6 }, (_, index) => ({ index, name: `c${index}`, path: `/p${index}`, url: `http://s/p${index}` }));
const ENV = { TARGETS: '[]', BEFORE_URL: '', AFTER_URL: '', BEFORE_FALLBACK_URL: '', BEFORE_COOKIE: '', AFTER_COOKIE: '', MEDIA: '0', TESTS: 'x' };

// Shard i reports the checks whose index % 3 === i; `never` shards came back
// as a partial run whose Pod never started.
function runner({ never = [], sweepNever = false } = {}) {
  return async (opts) => {
    const shard = opts.shard;
    if (shard === 3) {
      if (sweepNever) return { stdout: '', partial: true, partialReason: 'run timed out', podStart: NEVER };
      const list = JSON.parse(opts.env.TESTS === '@stdin' ? opts.stdinPayload : opts.env.TESTS);
      return { stdout: list.map((t) => frame(t.index)).join('\n') };
    }
    if (never.includes(shard)) return { stdout: '', partial: true, partialReason: 'run timed out', podStart: NEVER };
    return { stdout: TESTS.filter((t) => t.index % 3 === shard).map((t) => frame(t.index)).join('\n') };
  };
}

test('a shard whose Pod never started is named, and dropped again once the sweep has run its checks', async () => {
  const covered = await visuals.runCaptureShards({}, { shards: 3, tests: TESTS, env: ENV, sessionId: 42, runJob: runner({ never: [1] }) });
  assert.deepEqual(covered.notStarted, [], 'the sweep ran shard 1\'s checks: nothing is missing because of it');
  const stuck = await visuals.runCaptureShards({}, { shards: 3, tests: TESTS, env: ENV, sessionId: 42, runJob: runner({ never: [1], sweepNever: true }) });
  assert.deepEqual(stuck.notStarted.map((n) => [n.shard, n.lead]), [[1, 'start'], [3, 'start']],
    'the sweep never started either: both are why the checks are missing');
  assert.match(stuck.notStarted[0].cause, /waited 13 minutes for its container/);
});

test('a shard that started, or reported checks, is never counted as one that did not start', () => {
  assert.equal(visuals.captureNotStarted({ res: { stdout: '', partial: true, podStart: STARTED } }), null,
    'a container that started and ran out of time may be the proposal\'s own load');
  assert.equal(visuals.captureNotStarted({ res: { stdout: frame(0), partial: true, podStart: NEVER } }), null);
  assert.equal(visuals.captureNotStarted({ res: { stdout: '', partial: false, podStart: NEVER } }), null);
  assert.equal(visuals.captureNotStarted({ res: { stdout: '', partial: true } }), null, 'an unknown Pod is never guessed at');
  const refused = Object.assign(new Error('exceeded quota: count/jobs.batch=1'), { code: 403, checkJobNotCreated: true });
  assert.deepEqual(visuals.captureNotStarted({ err: refused, shard: 2 }),
    { shard: 2, lead: 'start', cause: 'the cluster\'s job quota was full' });
});

test('the live run carries the shards that never started to the settle step', () => {
  const src = read('src/services/visuals.js');
  const capture = src.slice(src.indexOf('async function captureForSession('), src.indexOf('async function settleCaptureRun('));
  assert.match(capture, /notStarted = Array\.isArray\(res\.notStarted\) \? res\.notStarted\n\s+: \[captureNotStarted\(\{ res: \{ \.\.\.res, stdout \} \}\)\]\.filter\(Boolean\);/,
    'a run split across shards brings its list; one capture Job is read the same way');
  assert.match(capture, /runPartialReason, unitOutcome, notStarted,/);
});

// ── The settle step ─────────────────────────────────────────────────────

// A pool that records what storeChecks writes: state, detail, platform fault.
function settlePool() {
  const pool = {
    stores: [],
    async query(sql, params = []) {
      if (/UPDATE chat_sessions\s+SET check_state = \$1/.test(sql)) {
        const error = /check_error_platform = \$6::boolean/.test(sql);
        pool.stores.push({ state: params[0], detail: error ? params[4] : null, platformFault: error ? params[5] : false });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: (sql, params) => pool.query(sql, params), release() {} }; },
  };
  return pool;
}

const SESSION = { id: 42, app_id: 9, status: 'promoted', pr_number: null, source: 'native', checks_commit_sha: 'abc123', branch_name: 'b' };
const APP = { id: 9, slug: 'demo', name: 'Demo', repo_url: '' };

function settle(t, { stdout, notStarted }) {
  const pool = settlePool();
  stub(t, lifecycle, { current: () => ({ pool }) });
  stub(t, ws, { broadcastGlobal: () => {} });
  return visuals.settleCaptureRun({}, pool, {
    session: SESSION, app: APP, commitHash: 'abc123', trigger: 'commit-push', send: () => {},
    runStartedAt: Date.now(), media: false, capturePaths: ['/'], pathDefaulted: false, prodRunning: false,
    stagingOrigin: '', targets: [], testsCount: 3, dispatched: null, ceilingDropped: 0,
    stdout, stderr: '', runPartial: true, runPartialReason: 'run timed out', unitOutcome: null, notStarted,
  }).then((settled) => ({ settled, stores: pool.stores }));
}

const NOT_STARTED = [{ shard: 1, lead: 'start', cause: 'a test pod waited 13 minutes for its container to start' }];

test('checks missing because a test Pod never started are stored as the platform\'s fault, in the card\'s words', async (t) => {
  const { settled, stores } = await settle(t, { stdout: frame(0), notStarted: NOT_STARTED });
  assert.equal(settled.result.state, 'error');
  assert.equal(stores.length, 1);
  assert.equal(stores[0].platformFault, true, 'the error lane keeps retrying it past the proposal\'s own retries');
  assert.equal(stores[0].detail, SENTENCE);
});

test('a run that produced nothing at all, because its Pod never started, keeps the runner\'s words after the sentence', async (t) => {
  const { stores } = await settle(t, { stdout: '', notStarted: NOT_STARTED });
  assert.equal(stores[0].platformFault, true);
  assert.ok(stores[0].detail.startsWith(`${SENTENCE} | Browser check runner`), stores[0].detail);
});

test('without a shard that never started, the same missing checks keep today\'s verdict', async (t) => {
  const { stores } = await settle(t, { stdout: frame(0), notStarted: [] });
  assert.equal(stores[0].state, 'error');
  assert.equal(stores[0].platformFault, false);
  const none = await settle(t, { stdout: '', notStarted: [] });
  assert.equal(none.stores[0].platformFault, false, 'a capture that produced nothing may be the preview\'s doing');
  const passing = await settle(t, { stdout: [frame(0), frame(1), frame(2)].join('\n'), notStarted: NOT_STARTED });
  assert.equal(passing.stores[0].state, 'passing', 'every check reported: a Pod that started late changes nothing');
});

test('a capture Job refused, lost, or whose Pod never started, outside the settle step, says so too', () => {
  const src = read('src/services/visuals.js');
  const publish = src.slice(src.indexOf('async function publishCaptureError('), src.indexOf('async function publishCaptureError(') + 1200);
  assert.match(publish, /const fault = require\('\.\/check-pod-start'\)\.checkStartFault\(err\);/);
  assert.match(publish, /\.\.\.\(fault \? \{ platformFault: true \} : \{\}\)/);
  assert.match(publish, /fault \? require\('\.\/check-pod-start'\)\.browserNotRunSentence\(fault\) : err\.message/);
  const catchAt = src.indexOf("log.warn('visuals', 'Capture failed (non-fatal)'");
  const nonFatal = src.slice(catchAt, catchAt + 1600);
  assert.match(nonFatal, /checkStartFault\(err\)/);
  assert.match(nonFatal, /\.\.\.\(fault \? \{ platformFault: true \} : \{\}\)/);
});

// ── The harvest ─────────────────────────────────────────────────────────

test('the harvest names a shard whose Pod never started, as the live run does', () => {
  const joined = harvest.joinCaptures([
    { state: 'succeeded', stdout: frame(0) },
    { state: 'timeout', stdout: '', partial: true, partialReason: 'run timed out', podStart: NEVER },
    { state: 'timeout', stdout: '', partial: true, partialReason: 'run timed out', podStart: STARTED },
  ]);
  assert.equal(joined.state, 'timeout');
  assert.deepEqual(joined.notStarted.map((n) => n.shard), [1]);
  const one = harvest.joinCaptures([{ state: 'failed', stdout: '', podStart: NEVER }]);
  assert.deepEqual(one.notStarted.map((n) => n.shard), [0], 'one capture Job is read the same way');
});

test('a unit-suite shard that never started makes the harvested suite one that never ran', () => {
  const joined = harvest.joinUnitResults([
    { state: 'succeeded', stdout: 'ok 1 - a\n', stderr: '', exitCode: 0 },
    { state: 'failed', stdout: '', stderr: 'DeadlineExceeded', exitCode: null, timedOut: true, podStart: NEVER },
  ], 2);
  assert.equal(joined.shardNotRun, true);
  assert.equal(joined.stdout, '', 'its own empty log is what is read');
  assert.equal(joined.podStart, NEVER);
});

function makePool({ orphan, session }) {
  const pool = {
    deleted: [],
    async query(sql, params) {
      if (/SELECT run_id, session_id, commit_sha, owner, manifest/.test(sql)) return { rows: [{ ...orphan }], rowCount: 1 };
      if (/UPDATE check_runs SET owner/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE check_runs SET heartbeat_at/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM check_runs/.test(sql)) { pool.deleted.push(params[0]); return { rows: [], rowCount: 1 }; }
      if (/FROM chat_sessions cs JOIN apps a/.test(sql)) return { rows: [{ ...session }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function orphanRow(manifest = {}) {
  return {
    run_id: 'run-1', session_id: 42, commit_sha: 'abc123', owner: 'dead-pod:7', stale: true,
    started_at: new Date(Date.now() - 90_000).toISOString(), heartbeat_at: new Date(Date.now() - 70_000).toISOString(),
    queued_at: new Date(Date.now() - 120_000).toISOString(), admitted_at: new Date(Date.now() - 100_000).toISOString(),
    manifest: { launched: true, trigger: 'promote-kick', startedAt: Date.now() - 90_000, media: false,
      capturePaths: ['/'], targets: [], testsCount: 3, dispatched: null, ...manifest },
  };
}

const HARVEST_SESSION = {
  id: 42, app_id: 9, status: 'promoted', check_state: 'pending', check_phase: 'testing',
  checks_commit_sha: 'abc123', app_slug: 'demo', app_name: 'Demo', repo_url: '', app_runtime_name: null, app_runtime_kind: null,
};
const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers', appNamespace: 'apps' } };

// The stuck shard's Job ended by its deadline (`failed`, as Kubernetes ends
// it) or outlived the harvest's own wait (`timeout`).
function harvestStubs(t, { captures, stuck = 'failed' }) {
  stub(t, ws, { broadcastGlobal: () => {} });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: captures[0], captures, unitSuite: null }),
    collectCheckJob: async (_cfg, { name }) => (name === 'sv-capture-s42-x'
      ? { state: stuck, stdout: '', stderr: stuck === 'failed' ? 'DeadlineExceeded' : '', exitCode: null, timedOut: true, partial: true, partialReason: 'run timed out', podStart: NEVER }
      : { state: 'succeeded', stdout: frame(0), stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '', podStart: STARTED }),
    deleteSettledCheckJobs: async () => 0,
  });
}

test('a harvested run with a shard that never started goes again once, in its place, marked so it does not loop', async (t) => {
  const rechecks = [];
  harvestStubs(t, { captures: [{ name: 'sv-capture-s42-a', state: 'succeeded' }, { name: 'sv-capture-s42-x', state: 'failed' }] });
  stub(t, stagingRecovery, { recheckSessionChecks: async (args) => { rechecks.push(args); } });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('nothing settles from a shard that never started, the first time') });
  const pool = makePool({ orphan: orphanRow({ captureShards: 2 }), session: HARVEST_SESSION });
  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'redriven');
  assert.equal(result.why, 'a test pod never started');
  assert.equal(rechecks.length, 1);
  assert.equal(rechecks[0].reason, 'orphaned-run');
  assert.equal(rechecks[0].redrive, 'pod-never-started');
  assert.ok(rechecks[0].queuedSince, 'it keeps the place in line the run had');
});

test('a run already re-driven for that settles with the shard named, as the platform\'s fault', async (t) => {
  let settledWith = null;
  harvestStubs(t, { captures: [{ name: 'sv-capture-s42-a', state: 'succeeded' }, { name: 'sv-capture-s42-x', state: 'failed' }] });
  stub(t, stagingRecovery, { recheckSessionChecks: async () => assert.fail('re-driven once already') });
  stub(t, visuals, {
    settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { traceStatus: 'error', result: { state: 'error' } }; },
    scheduleShots: () => {},
  });
  const pool = makePool({ orphan: orphanRow({ captureShards: 2, redrive: 'pod-never-started' }), session: HARVEST_SESSION });
  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'settled');
  assert.deepEqual(settledWith.notStarted.map((n) => n.shard), [1]);
});

test('a capture Job that never started and left nothing to read is stored as the platform\'s fault', async (t) => {
  const stores = [];
  harvestStubs(t, { captures: [{ name: 'sv-capture-s42-x', state: 'failed' }], stuck: 'timeout' });
  stub(t, visuals, {
    settleCaptureRun: async () => assert.fail('nothing to settle from'),
    storeChecks: async (_pool, _id, _sha, result, detail) => { stores.push({ result, detail }); return true; },
    storeCaptureOutcome: async () => true,
    scheduleShots: () => {},
  });
  const pool = makePool({ orphan: orphanRow({ redrive: 'pod-never-started' }), session: HARVEST_SESSION });
  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'settled');
  assert.equal(stores.length, 1);
  assert.equal(stores[0].result.platformFault, true);
  assert.equal(stores[0].detail, SENTENCE);
});

test('a re-drive carries its mark into the new run\'s manifest', () => {
  const recheck = read('src/services/staging-recovery.js');
  assert.match(recheck, /async function recheckSessionChecks\(\{ config, pool, session, reason, queuedSince = null, redrive = null \}\)/);
  assert.match(recheck, /\.\.\.\(redrive \? \{ redrive \} : \{\}\),/);
  const capture = read('src/services/visuals.js');
  assert.match(capture, /launched: true,\n\s+trigger: trigger \|\| null,[\s\S]{0,300}\.\.\.\(opts\.redrive \? \{ redrive: opts\.redrive \} : \{\}\),/);
});

// ── The merge gate ──────────────────────────────────────────────────────

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const checksGate = (s) => mergeRequirements.readRequirements(s).gates.find((g) => g.key === 'checks');

test('a platform fault the error lane still covers is in progress, for nobody, and says the checks will run again', () => {
  const live = { check_state: 'error', check_error_platform: true, consecutive_check_failures: 7, first_check_failure_at: hoursAgo(2) };
  assert.deepEqual(checksGate(live), {
    key: 'checks', label: 'Checks', actor: 'author', state: 'active',
    detail: { note: 'the checks could not start, so they will run again' },
  });
  const spent = { ...live, first_check_failure_at: hoursAgo(25) };
  assert.equal(checksGate(spent).state, 'blocked', 'past its day of retries it waits for a person again');
  const ordinary = { check_state: 'error', check_error_platform: false, consecutive_check_failures: 1, first_check_failure_at: hoursAgo(1) };
  assert.equal(checksGate(ordinary).state, 'blocked', 'any other error still blocks on the author');
});

test('a recorded gate gives way to the row: a platform fault stored since reads as in progress, and back once it is spent', () => {
  const record = { evaluated: [{ key: 'checks', state: 'blocked', detail: { checkState: 'error', note: 'the staging preview could not start, so the tests could not run' } }], context: {} };
  const row = { merge_requirements: record, merge_requirements_at: hoursAgo(0.1),
    check_state: 'error', check_error_platform: true, consecutive_check_failures: 2, first_check_failure_at: hoursAgo(1) };
  const now = checksGate(row);
  assert.equal(now.state, 'active');
  assert.equal(now.detail.note, 'the checks could not start, so they will run again');
  const active = { ...record, evaluated: [{ key: 'checks', state: 'active', detail: { checkState: 'error', note: 'the checks could not start, so they will run again' } }] };
  assert.equal(checksGate({ ...row, merge_requirements: active, consecutive_check_failures: 7, first_check_failure_at: hoursAgo(30) }).state,
    'blocked', 'past the six retries and its day of platform retries');
  assert.equal(checksGate({ ...row, check_error_platform: false }).state, 'blocked', 'nothing changes for any other error');
});

test('the merge gate and every row that feeds the card read the three columns the rule needs', () => {
  const votes = read('src/routes/votes.js');
  const gate = votes.slice(votes.indexOf('async function checkAndMerge('));
  assert.match(gate, /check_error_detail, checks_commit_sha, check_phase,\n\s+check_error_platform, consecutive_check_failures, first_check_failure_at/);
  assert.match(gate, /const platformRetry = checkState === 'error' && checkRows\[0\]\?\.check_error_platform === true\n\s+&& require\('\.\.\/services\/staging-recovery'\)\.errorWithinAutoRetries\(checkRows\[0\]\);/);
  assert.match(gate, /&& !rolloutRetry && !platformRetry\) \? 'blocked' : 'active'/);
  const merged = votes.slice(votes.indexOf('function mergedRowSelect('), votes.indexOf('function mergedRowSelect(') + 6000);
  assert.match(merged, /cs\.check_error_platform, cs\.consecutive_check_failures, cs\.first_check_failure_at,/);
  assert.equal((votes.match(/cs\.check_error_platform, cs\.consecutive_check_failures, cs\.first_check_failure_at,/g) || []).length, 2,
    'the board rows and the single proposal both');
});

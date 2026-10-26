'use strict';

// services/main-watch: the run and the record under the safety net beneath
// direct merges.
//
// Proposals merge as they stand once approved and clean, so nobody has run
// the checks against the merged tree AS A WHOLE. After each merge the repo's
// unit suite runs once on the merge commit; red pauses the app's merges
// until a fix lands or an admin resumes them. What follows from a verdict
// (the provisional first red, the pause and its end, the rechecks, a run a
// restart interrupted) is the main-check machine's, pinned against
// PostgreSQL in tests/workflow-main-check-postgres.test.js. Pinned here is
// what main-watch still does: one run of the suite (runMainSuite, and the
// dead run's Jobs it adopts), the verdict it reads from it (classify), and
// the pause as the gate and the API read it (describe, mergePause).
//
// The level-and-green pass-through the pause makes room for is the gate's
// business: tests/votes-integration-gate.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const unitSuite = require('../src/services/unit-suite');
const mainWatch = require('../src/services/main-watch');
const checksQueue = require('../src/services/checks-queue');
const kubernetes = require('../src/services/kubernetes');

const SHA = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const APP = { id: 12, slug: 'demo', repo_url: 'https://github.com/org/demo' };
const config = { workerRuntime: 'docker' };
const KUBE = { workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };

// A pool that records the statements main-watch issues and answers the
// checks queue's: `queueRow` is the check_runs row a resumed run id names
// (null: none admitted), `claimed` whether taking it over from its owner
// succeeds.
function fakePool({ queueRow = null, claimed = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT owner FROM check_runs WHERE run_id = \$1 AND admitted_at IS NOT NULL/.test(sql)) {
        return { rows: queueRow ? [queueRow] : [], rowCount: queueRow ? 1 : 0 };
      }
      if (/UPDATE check_runs SET owner = \$2, heartbeat_at = NOW\(\)/.test(sql)) return { rows: [], rowCount: claimed ? 1 : 0 };
      if (/DELETE FROM check_runs WHERE run_id = \$1/.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT main_check_state/.test(sql)) return { rows: [{}], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function stubSuite(fn) {
  const real = unitSuite.maybeRunUnitSuite;
  const calls = [];
  unitSuite.maybeRunUnitSuite = async (args) => { calls.push(args); return fn(args); };
  return { calls, restore: () => { unitSuite.maybeRunUnitSuite = real; } };
}

const pass = { row: { status: 'pass', failureReason: '', summary: { tests: 40, pass: 40, fail: 0 } } };
const fail = (reason) => ({ row: { status: 'fail', failureReason: reason, summary: { tests: 40, pass: 39, fail: 1 } } });
// The shape services/unit-suite.js failureDetail actually produces: the TAP
// `not ok` lines, then the summary, joined with ` | `.
const TAP_RED = 'not ok 6972 - shared-sessions returns linked_issues per row | # tests 7010 | # pass 7009 | # fail 1';

// ── describe ─────────────────────────────────────────────────────────────

test('describe: the pause is the paused_sha column, whatever the state says', () => {
  assert.deepEqual(mainWatch.describe(null), {
    state: null, sha: null, at: null, detail: null, resumedSha: null,
    pausedSha: null, paused: false, confirming: false, failingTest: null,
  });
  const red = mainWatch.describe({
    main_check_state: 'failing', main_check_sha: SHA, main_check_at: '2026-09-14T10:00:00Z',
    main_check_paused_sha: SHA, main_check_detail: { failureReason: TAP_RED },
  });
  assert.equal(red.paused, true);
  assert.equal(red.pausedSha, SHA);
  assert.equal(red.at, '2026-09-14T10:00:00.000Z');
  assert.equal(red.failingTest, 'shared-sessions returns linked_issues per row', 'the message can name the culprit');
  // Resumed: the column is cleared, and a red state alone does not pause.
  assert.equal(mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA, main_check_paused_sha: null, main_check_resumed_sha: SHA }).paused, false);
  // A first red under re-run: paused, and says the pause is provisional.
  const confirming = mainWatch.describe({ main_check_state: 'confirming', main_check_sha: SHA, main_check_paused_sha: SHA });
  assert.equal(confirming.paused, true);
  assert.equal(confirming.confirming, true);
  // A run that could not happen after a red: the pause it found is still
  // there. Before the column, 'error' at a new sha silently lifted it.
  const errored = mainWatch.describe({ main_check_state: 'error', main_check_sha: SHA, main_check_paused_sha: OLD });
  assert.equal(errored.paused, true);
  assert.equal(errored.pausedSha, OLD);
  // And a green verdict has cleared it.
  assert.equal(mainWatch.describe({ main_check_state: 'passing', main_check_sha: SHA, main_check_paused_sha: null }).paused, false);
});

test('describe: a row from before the column derives the pause the old way', () => {
  // No main_check_paused_sha key at all — the row a caller built before the
  // ALTER ran. Red at a sha the admin has not resumed is paused.
  assert.equal(mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA }).paused, true);
  assert.equal(mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA, main_check_resumed_sha: SHA.toUpperCase() }).paused, false, 'case is not a difference');
  assert.equal(mainWatch.describe({ main_check_state: 'failing', main_check_sha: SHA, main_check_resumed_sha: OLD }).paused, true, 'a resume is for one sha');
  for (const state of ['running', 'passing', 'error', 'skipped']) {
    assert.equal(mainWatch.describe({ main_check_state: state, main_check_sha: SHA }).paused, false, state);
  }
});

test('firstFailingTest: the first `not ok` line, without its number or a SKIP/TODO directive', () => {
  assert.equal(mainWatch.firstFailingTest(TAP_RED), 'shared-sessions returns linked_issues per row');
  assert.equal(mainWatch.firstFailingTest('not ok 3 - a › b # TODO later | not ok 4 - c'), 'a › b');
  assert.equal(mainWatch.firstFailingTest('Suite setup failed: npm ci exited 1'), null, 'a setup failure names no test');
  assert.equal(mainWatch.firstFailingTest(''), null);
  assert.equal(mainWatch.firstFailingTest(null), null);
  // The grouped-by-file reason unit-suite.js writes now.
  assert.equal(mainWatch.firstFailingTest(
    'tests/sessions.test.js (2): shared-sessions returns linked_issues per row; another | tests/b.test.js (1): c | # tests 9 | # fail 3'),
  'shared-sessions returns linked_issues per row');
  assert.equal(mainWatch.firstFailingTest('tests/a.test.js (3): only one fit… | # fail 3'), 'only one fit');
  assert.equal(mainWatch.firstFailingTest('Suite run exceeded 600s and was killed. | tests/a.test.js (1): slow'), 'slow');
  assert.equal(mainWatch.firstFailingTest('tests/a.test.js (40) | tests/b.test.js (1): named | # fail 41'), 'named',
    'a file whose names did not fit is skipped, not misread');
  assert.equal(mainWatch.firstFailingTest('tests/a.test.js (40) | (+3 more files, 9 failing tests) | # fail 49'), null);
  assert.equal(mainWatch.firstFailingTest('not ok 7 - retries (2): then gives up | # fail 1'), 'retries (2): then gives up',
    'a stored old-form reason is not misread as a file group');
});

test('classify: only a verdict ABOUT the code can pause merges', () => {
  assert.equal(mainWatch.classify(null).state, 'skipped');
  assert.equal(mainWatch.classify({ row: null }).state, 'skipped');
  assert.equal(mainWatch.classify(pass).state, 'passing');
  assert.equal(mainWatch.classify(fail('1 of 40 tests failed: merge-queue › direct lane')).state, 'failing');
  // A run that could not happen says nothing about main.
  assert.equal(mainWatch.classify(fail('Suite setup failed: npm ci exited 1')).state, 'error');
  assert.equal(mainWatch.classify(fail('Suite run exceeded 20 minutes')).state, 'error');
  assert.deepEqual(mainWatch.classify(pass).detail, { summary: pass.row.summary });
});

test('classify (#4265): a suite that counted failures is failing, even when its log lost the setup line', () => {
  // PR #4217's log: the summary survived, the setup sentinel and every
  // `not ok` line did not, and the Job's own failure rode along.
  const tail = '# tests 21748\n# suites 0\n# pass 21713\n# fail 18\n# cancelled 0\n# skipped 17\n# todo 0';
  assert.equal(mainWatch.classify(fail(unitSuite.failureDetail(tail, 'BackoffLimitExceeded: Error'))).state, 'failing');
  // With no test reported, it is still a run that could not happen.
  assert.equal(mainWatch.classify(fail(unitSuite.failureDetail('npm error code E404', 'BackoffLimitExceeded: Error'))).state, 'error');
});

test('classify: a suite that never ran is an error, whatever its reason now says', async (t) => {
  // The rows unit-suite.js writes when the suite never reached `npm test`
  // (notRunOutcome): their reason no longer starts "Suite setup failed", so
  // the row's own mark is what keeps them from pausing merges.
  const empty = await unitSuite.outcomeFromLog({ pool: null, appId: 12, sessionId: 'main-12', succeeded: false, stdout: '', stderr: 'BackoffLimitExceeded: Error', graduated: true });
  assert.equal(empty.row.couldNotRun, true);
  assert.doesNotMatch(empty.row.failureReason, /^Suite setup failed/);
  assert.equal(mainWatch.classify(empty).state, 'error');
  assert.match(mainWatch.classify(empty).detail.failureReason, /^The unit suite stopped before any test ran: /);

  const github = require('../src/services/github');
  const kubernetes = require('../src/services/kubernetes');
  const history = require('../src/services/check-history');
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getFileContent', async () => '{"scripts":{"test":"node --test"}}');
  t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
  t.mock.method(history, 'loadGraduated', async () => new Set());
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => {
    throw Object.assign(new Error('jobs.batch "sv-unit-suite-smain-12-x" is forbidden: exceeded quota: social-workers, requested: count/jobs.batch=1'),
      { code: 403, checkJobNotCreated: true });
  });
  const refused = await unitSuite.maybeRunUnitSuite({
    config: { workerRuntime: 'kubernetes' }, pool: null, appId: 12, sessionId: 'main-12',
    repoOwner: 'org', repoName: 'demo', ref: SHA,
  });
  assert.match(refused.row.failureReason, /^The unit suite could not start: the cluster's job quota was full\. \| /);
  assert.equal(mainWatch.classify(refused).state, 'error', 'a refused Job says nothing about main');
  // An install that failed on main's own package files is that commit's
  // failing row, but main-watch has never paused merges for a suite that
  // could not get going, and still does not.
  const lockfile = await unitSuite.outcomeFromLog({
    pool: null, appId: 12, sessionId: 'main-12', succeeded: false, graduated: true, stderr: 'BackoffLimitExceeded: Error',
    stdout: [`${unitSuite.ROOT_SENTINEL}=/tmp/w`, unitSuite.CLONED_SENTINEL, 'npm error code ETARGET'].join('\n'),
  });
  assert.equal(lockfile.row.setupFailed, true);
  assert.equal(mainWatch.classify(lockfile).state, 'error');
  // A red suite is still red.
  assert.equal(mainWatch.classify(fail(TAP_RED)).state, 'failing');
});

// ── runMainSuite ─────────────────────────────────────────────────────────
//
// One run of the suite on a commit, for the main-check machine's main.suite
// work (src/workflow/main-check/services.ts).

test('runMainSuite: one run on the commit, named for the app rather than a proposal', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => pass);
  const told = [];
  try {
    const out = await mainWatch.runMainSuite(config, pool, { app: APP, sha: SHA, onRunId: (id) => told.push(id) });
    assert.equal(out.state, 'passing');
    // Named for the app, so a session's own cleanup cannot take it down;
    // and it runs the commit itself.
    assert.equal(suite.calls.length, 1);
    assert.equal(suite.calls[0].sessionId, 'main-12');
    assert.equal(suite.calls[0].ref, SHA);
    assert.equal(suite.calls[0].repoOwner, 'org');
    assert.equal(suite.calls[0].repoName, 'demo');
    assert.equal(suite.calls[0].prNumber, null, 'not a PR run');
    assert.deepEqual(told, [], 'no queue row outside the cluster, so no run id to keep');
  } finally { suite.restore(); }
});

test('runMainSuite: a runner that could not be reached is an error verdict; no repository runs nothing', async () => {
  const suite = stubSuite(async () => { throw new Error('docker daemon unreachable'); });
  try {
    const out = await mainWatch.runMainSuite(config, fakePool(), { app: APP, sha: SHA });
    assert.equal(out.state, 'error');
    assert.match(out.detail.failureReason, /docker daemon unreachable/);
    assert.equal((await mainWatch.runMainSuite(config, fakePool(), { app: { id: 1, repo_url: 'not-github' }, sha: SHA })).state, 'skipped');
    assert.equal(suite.calls.length, 1);
  } finally { suite.restore(); }
});

// The cluster's checks queue, granting the slot at once.
function grantingQueue(t) {
  const enqueued = [];
  t.mock.method(checksQueue, 'isEnabled', () => true);
  t.mock.method(checksQueue, 'enqueue', async (pool, row) => { enqueued.push(row); return { position: 1 }; });
  t.mock.method(checksQueue, 'waitForSlot', async () => ({ outcome: 'granted', waitedMs: 0 }));
  return enqueued;
}

test('runMainSuite: the queue row\'s run id is told before the suite runs, and labels its Jobs', async (t) => {
  const enqueued = grantingQueue(t);
  const pool = fakePool();
  const order = [];
  const suite = stubSuite(async (args) => { order.push(['suite', args.previewRunId]); return pass; });
  try {
    const out = await mainWatch.runMainSuite(KUBE, pool, {
      app: APP, sha: SHA, onRunId: async (id) => { order.push(['told', id]); },
    });
    assert.equal(out.state, 'passing');
    assert.equal(enqueued.length, 1);
    const runId = enqueued[0].runId;
    assert.deepEqual([enqueued[0].kind, enqueued[0].appId, enqueued[0].commitSha], ['main', 12, SHA]);
    assert.deepEqual(order, [['told', runId], ['suite', runId]], 'kept before the Jobs exist, so an attempt after a crash finds them');
    assert.ok(pool.calls.some((c) => /DELETE FROM check_runs WHERE run_id = \$1/.test(c.sql) && c.params[0] === runId),
      'the slot is given back after the run');
  } finally { suite.restore(); }
});

// A merge that lands a tree whose suite already passed (the proposal head it
// squashed) copies that pass when the machine allows it (`reuse`): no queue
// slot, no Jobs, a verdict at once that says where it came from. Anything
// else runs the suite. The lookup itself: tests/unit-suite-reuse.test.js.
function stubTreePass(fn) {
  const real = unitSuite.reusableTreePass;
  const calls = [];
  unitSuite.reusableTreePass = async (args) => { calls.push(args); return fn(args); };
  return { calls, restore: () => { unitSuite.reusableTreePass = real; } };
}
const FROM = { runId: 'run-p', sessionId: 8726, passedAt: '2026-10-16T08:15:46.000Z', commitSha: OLD, treeSha: 'e'.repeat(40) };
const copiedPass = { row: { status: 'pass', failureReason: '', summary: { tests: 40, pass: 40, fail: 0 }, reused: FROM }, history: null, reused: FROM };

test('runMainSuite: a first run whose tree already passed copies the pass, takes no slot and runs no Jobs', async (t) => {
  const enqueued = grantingQueue(t);
  const tree = stubTreePass(async () => copiedPass);
  const suite = stubSuite(async () => assert.fail('the suite must not run'));
  const told = [];
  try {
    const out = await mainWatch.runMainSuite(KUBE, fakePool(), { app: APP, sha: SHA, reuse: true, onRunId: (id) => told.push(id) });
    assert.equal(out.state, 'passing');
    assert.deepEqual(out.detail.reused, FROM, 'the verdict says it was copied, and from which commit and run');
    assert.deepEqual(out.detail.summary, copiedPass.row.summary);
    assert.equal(tree.calls.length, 1);
    assert.deepEqual([tree.calls[0].appId, tree.calls[0].appSlug, tree.calls[0].repoOwner, tree.calls[0].repoName, tree.calls[0].commitSha],
      [12, 'demo', 'org', 'demo', SHA], 'the app, so only the platform\'s own may copy by tree');
    assert.deepEqual([suite.calls.length, enqueued.length, told.length], [0, 0, 0]);
  } finally { tree.restore(); suite.restore(); }
});

test('runMainSuite: without the machine\'s leave, or with no pass of the tree, the suite runs', async (t) => {
  grantingQueue(t);
  for (const [why, opts, answer] of [
    ['no leave (a confirmation, a recheck, a paused main)', {}, copiedPass],
    ['leave that is not exactly true', { reuse: 'yes' }, copiedPass],
    ['no pass of that tree, or a lookup that failed', { reuse: true }, null],
  ]) {
    const tree = stubTreePass(async () => answer);
    const suite = stubSuite(async () => pass);
    try {
      const out = await mainWatch.runMainSuite(KUBE, fakePool(), { app: APP, sha: SHA, ...opts });
      assert.equal(out.state, 'passing', why);
      assert.equal(out.detail.reused, undefined, `${why}: not a copy`);
      assert.equal(suite.calls.length, 1, `${why}: the suite ran`);
      assert.equal(tree.calls.length, opts.reuse === true ? 1 : 0, `${why}: asked only with leave`);
    } finally { tree.restore(); suite.restore(); }
  }
  // A lookup that throws is a run of the suite, not an error verdict.
  const tree = stubTreePass(async () => { throw new Error('boom'); });
  const suite = stubSuite(async () => pass);
  try {
    const out = await mainWatch.runMainSuite(KUBE, fakePool(), { app: APP, sha: SHA, reuse: true });
    assert.equal(out.state, 'passing');
    assert.equal(suite.calls.length, 1, 'fails closed: the suite ran');
  } finally { tree.restore(); suite.restore(); }
});

// The real lookup, for the platform's own app, against a GitHub that never
// answers: the run neither waits on it past its deadline nor after it is
// cancelled, and the suite runs.
test('runMainSuite: a GitHub that never answers costs the copy, never the run', async (t) => {
  const github = require('../src/services/github');
  const reuse = require('../src/services/unit-suite-reuse');
  reuse._clearTreeCache();
  grantingQueue(t);
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getCommitTree', () => new Promise(() => {}));
  const PLATFORM = { id: 10, slug: 'usernode-2d5619', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const cfg = { ...KUBE, selfAppSlug: 'usernode-2d5619', kubernetes: { ...KUBE.kubernetes, workerImage: `r/w@sha256:${'c'.repeat(64)}` } };
  const before = process.env.UNIT_SUITE_TREE_LOOKUP_MS;
  const suite = stubSuite(async () => pass);
  try {
    process.env.UNIT_SUITE_TREE_LOOKUP_MS = '50';
    let started = Date.now();
    assert.equal((await mainWatch.runMainSuite(cfg, fakePool(), { app: PLATFORM, sha: SHA, reuse: true })).state, 'passing');
    assert.equal(suite.calls.length, 1, 'past the deadline the suite ran');
    assert.ok(Date.now() - started < 2000);
    process.env.UNIT_SUITE_TREE_LOOKUP_MS = '600000';
    const ac = new AbortController();
    started = Date.now();
    const out = mainWatch.runMainSuite(cfg, fakePool(), { app: PLATFORM, sha: SHA, reuse: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await out;
    assert.ok(Date.now() - started < 2000, 'a cancelled run is not held by the lookup');
    assert.equal(github.getCommitTree.mock.callCount(), 2, 'an unanswered read is not remembered: each run asks, and neither waits');
  } finally {
    suite.restore();
    if (before === undefined) delete process.env.UNIT_SUITE_TREE_LOOKUP_MS; else process.env.UNIT_SUITE_TREE_LOOKUP_MS = before;
  }
});

// 12 Oct 2026: a release restarted the platform while main was confirming a
// red, and main stayed held until the run was 12 minutes stale and ran from
// the start. The run's Jobs were still on the cluster. Now the next attempt
// of the machine's work passes the dead run's id back, and its Jobs are read.
const DEAD = { runId: '0f0e0d0c-0b0a-4908-8706-050403020100', owner: 'platform-old-pod' };

function adoptStubs({ jobs = [{ name: 'sv-unit-suite-smain-12-0f0e0d0c', state: 'running' }], result = { state: 'succeeded' }, outcome = pass } = {}) {
  const real = {
    find: kubernetes.findCheckJobs, collect: kubernetes.collectCheckJob,
    del: kubernetes.deleteSettledCheckJobs, read: unitSuite.outcomeFromLog,
  };
  const seen = { find: [], collect: [], deleted: [], read: [] };
  kubernetes.findCheckJobs = async (cfg, args) => {
    seen.find.push(args);
    return { unitSuites: jobs, unitSuite: jobs[0] || null, unitShards: 1, captures: [], capture: null };
  };
  kubernetes.collectCheckJob = async (cfg, args) => { seen.collect.push(args); return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...result }; };
  kubernetes.deleteSettledCheckJobs = async (cfg, args) => { seen.deleted.push(args); return 1; };
  unitSuite.outcomeFromLog = async (args) => { seen.read.push(args); return outcome; };
  return {
    seen,
    restore() {
      kubernetes.findCheckJobs = real.find; kubernetes.collectCheckJob = real.collect;
      kubernetes.deleteSettledCheckJobs = real.del; unitSuite.outcomeFromLog = real.read;
    },
  };
}

test('runMainSuite: a resumed run whose queue row was admitted is adopted: its Jobs read rather than run again', async () => {
  const pool = fakePool({ queueRow: { owner: DEAD.owner } });
  const stubs = adoptStubs({ outcome: fail(TAP_RED) });
  const suite = stubSuite(async () => assert.fail('no new run'));
  const told = [];
  try {
    const out = await mainWatch.runMainSuite(KUBE, pool, { app: APP, sha: SHA, resumeRunId: DEAD.runId, onRunId: (id) => told.push(id) });
    assert.equal(out.state, 'failing', 'the dead run\'s own verdict');
    assert.equal(suite.calls.length, 0);
    assert.deepEqual(told, [], 'no new queue row');
    assert.deepEqual(stubs.seen.find, [{ sessionId: 'main-12', previewRunId: DEAD.runId }]);
    assert.equal(stubs.seen.collect.length, 1);
    assert.equal(stubs.seen.read[0].sessionId, 'main-12');
    const claim = pool.calls.find((c) => /UPDATE check_runs SET owner = \$2/.test(c.sql));
    assert.deepEqual([claim.params[0], claim.params[2]], [DEAD.runId, DEAD.owner], 'claimed from the owner it was seen with');
    assert.ok(pool.calls.some((c) => /DELETE FROM check_runs WHERE run_id = \$1/.test(c.sql) && c.params[0] === DEAD.runId),
      'its queue row is cleared');
    assert.deepEqual(stubs.seen.deleted, [{ sessionId: 'main-12', previewRunId: DEAD.runId }], 'and its read-out Jobs deleted');
  } finally { suite.restore(); stubs.restore(); }
});

test('runMainSuite: a resumed run with no admitted row, or no Jobs left, runs the suite; one another process holds is left to it', async (t) => {
  grantingQueue(t);
  // Never admitted (it was still waiting for its slot): no Jobs to read.
  let pool = fakePool();
  let stubs = adoptStubs();
  let suite = stubSuite(async () => pass);
  try {
    assert.equal((await mainWatch.runMainSuite(KUBE, pool, { app: APP, sha: SHA, resumeRunId: DEAD.runId })).state, 'passing');
    assert.equal(stubs.seen.find.length, 0);
    assert.equal(suite.calls.length, 1, 'the suite runs again');
    assert.ok(!pool.calls.some((c) => /UPDATE check_runs SET owner/.test(c.sql)));
  } finally { suite.restore(); stubs.restore(); }

  // Admitted, but its Jobs are gone.
  pool = fakePool({ queueRow: { owner: DEAD.owner } });
  stubs = adoptStubs({ jobs: [] });
  suite = stubSuite(async () => pass);
  try {
    await mainWatch.runMainSuite(KUBE, pool, { app: APP, sha: SHA, resumeRunId: DEAD.runId });
    assert.equal(suite.calls.length, 1, 'no Jobs to read: the suite runs again');
    assert.ok(pool.calls.some((c) => /DELETE FROM check_runs/.test(c.sql) && c.params[0] === DEAD.runId), 'the dead row is let go');
  } finally { suite.restore(); stubs.restore(); }

  // Taken over by another process first: only the one that claimed it
  // reads it and clears its queue row.
  pool = fakePool({ queueRow: { owner: DEAD.owner }, claimed: false });
  stubs = adoptStubs();
  suite = stubSuite(async () => pass);
  try {
    assert.equal((await mainWatch.runMainSuite(KUBE, pool, { app: APP, sha: SHA, resumeRunId: DEAD.runId })).state, 'superseded');
    assert.equal(stubs.seen.find.length, 0);
    assert.equal(suite.calls.length, 0);
    assert.ok(!pool.calls.some((c) => /DELETE FROM check_runs WHERE run_id = \$1/.test(c.sql) && c.params[0] === DEAD.runId),
      'the row the other process heartbeats is left alone');
  } finally { suite.restore(); stubs.restore(); }
});

// ── mergePause ───────────────────────────────────────────────────────────

test('runMainSuite: a resumed run is adopted before any copy is looked for', async () => {
  const pool = fakePool({ queueRow: { owner: DEAD.owner } });
  const stubs = adoptStubs({ outcome: fail(TAP_RED) });
  const tree = stubTreePass(async () => assert.fail('the dead run\'s own Jobs answer'));
  try {
    const out = await mainWatch.runMainSuite(KUBE, pool, { app: APP, sha: SHA, resumeRunId: DEAD.runId, reuse: true });
    assert.equal(out.state, 'failing');
    assert.equal(tree.calls.length, 0);
  } finally { stubs.restore(); tree.restore(); }
});

test('mergePause: an unreadable row does not wedge every merge on the app', async () => {
  const pool = { query: async () => { throw new Error('connection reset'); } };
  const out = await mainWatch.mergePause(pool, 12);
  assert.equal(out.paused, false);
  assert.match(out.error, /connection reset/);
  assert.deepEqual(await mainWatch.mergePause(null, 12), { paused: false, state: null });
});

test('mergePause: reads the pause column with the rest', async () => {
  const pool = fakePool();
  await mainWatch.mergePause(pool, 12);
  assert.match(pool.calls[0].sql, /main_check_resumed_sha, main_check_paused_sha\s+FROM apps WHERE id = \$1/);
});

test('a main run labels its Jobs with its queue row, so a successor can find them', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'src/services/main-watch.js'), 'utf8');
  assert.match(src, /\.\.\.\(slot\.runId \? \{ previewRunId: slot\.runId \} : \{\}\)/);
  // The names a UUID run id gives an app's split suite, at the longest app
  // ids: each Job and each input Secret its own, within the 63-character
  // limit (the 10 Oct 2026 outage was shards sharing one Secret).
  const runId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const run = kubernetes.checkJobRunName('unit-suite', 'main-99999', runId);
  const names = [run, ...['u2', 'u3'].map((sfx) => kubernetes.withSuffix(run, sfx))];
  const secrets = [kubernetes.withSuffix(run, 'input'), ...['u2', 'u3'].map((sfx) => kubernetes.withSuffix(run, `${sfx}-input`))];
  for (const n of [...names, ...secrets]) assert.ok(n.length <= 63, n);
  assert.equal(new Set(names.map((n) => n.slice(0, 63))).size, 3);
  assert.equal(new Set(secrets).size, 3);
  assert.ok(names.every((n) => n.startsWith('sv-unit-suite-smain-99999-')), 'found by findCheckJobs\' name prefix');
});

test('the route, the gate and the machine read the same module', () => {
  // The admin resume route and checkAndMerge's main_healthy gate both read
  // the pause through main-watch, and the machine's suite is its run; pin
  // the files so a rename cannot leave one behind.
  const fs = require('node:fs');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', ...rel.split('/')), 'utf8');
  const apps = read('src/routes/apps.js');
  assert.match(apps, /main-check\/resume/);
  assert.match(apps, /\.resumeMainCheck\(rows\[0\]\.id, req\.user\)/);
  assert.match(apps, /mainWatch\.mergePause\(pool, rows\[0\]\.id\)/);
  assert.match(read('src/routes/votes.js'), /mergePause\(/);
  assert.match(read('src/workflow/main-check/services.ts'), /watch\(\)\.runMainSuite\(config, pool, \{/);
});

test('the schema carries the pause column and the backfill for the derived pauses', () => {
  const fs = require('node:fs');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_paused_sha VARCHAR\(40\);/);
  // Idempotent: red, not resumed for that red, not a red of known flakes
  // alone (which pauses nothing on purpose), and not yet carrying the
  // column, on rows the main-check machine does not hold (it owns the
  // column there; so the backfill comes after its guard and wf_holds).
  // Runs at every boot without moving anything twice.
  assert.match(schema, /UPDATE apps\s+SET main_check_paused_sha = main_check_sha\s+WHERE main_check_state = 'failing'\s+AND main_check_sha IS NOT NULL\s+AND main_check_paused_sha IS NULL\s+AND lower\(coalesce\(main_check_resumed_sha, ''\)\) <> lower\(main_check_sha\)\s+AND \(main_check_detail -> 'flakesOnly'\) IS NULL\s+AND NOT wf_holds\('main-check', 'app:' \|\| id\);/);
  assert.ok(schema.indexOf('UPDATE apps\n   SET main_check_paused_sha') > schema.indexOf('CREATE OR REPLACE FUNCTION wf_holds('), 'after wf_holds is defined');
  // The API serializes the column with its siblings.
  const access = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'app-access.js'), 'utf8');
  assert.match(access, /'main_check_resumed_sha', 'main_check_paused_sha',/);
});

// The suite's run reads the repository as the main-check machine's claim
// does (rules/github-url.ts): an app the machine claims is never stored as
// having no repository (review, 2026-10-17).
test('parseRepo: the rules\' one parser, the ssh form, a trailing slash and the git host included', () => {
  const { parseRepo } = require('../src/services/main-watch');
  for (const url of ['https://github.com/acme/shop', 'https://github.com/acme/shop/', 'https://www.github.com/acme/shop.git', 'git@github.com:acme/shop.git']) {
    assert.deepEqual(parseRepo(url), { owner: 'acme', repo: 'shop' }, url);
  }
  // A stored address on Homeroom's git host parses the same way.
  assert.deepEqual(parseRepo('https://git.onhomeroom.com/apps/shop'), { owner: 'apps', repo: 'shop' });
  for (const notOne of ['https://github.com/acme', 'not a url', '', null]) assert.equal(parseRepo(notOne), null, String(notOne));
});

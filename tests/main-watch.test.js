'use strict';

// services/main-watch — the safety net under direct merges.
//
// Proposals merge as they stand once approved and clean, so nobody has run
// the checks against the merged tree AS A WHOLE. After each merge the repo's
// unit suite runs once on the merge commit; red pauses the app's merges
// until a fix lands or an admin resumes them. Every write is compare-and-
// swap on the merge sha, so a slow run for an older merge cannot overwrite
// the verdict for a newer one.
//
// Three refinements, each from a pause that should not have happened or
// should not have been felt (the afternoon a flaky test paused the
// platform's own merges while main was fine):
//
//   * a first red is provisional — the suite re-runs once on the same commit
//     before anyone is told main is broken;
//   * the pause is its own column (main_check_paused_sha), cleared only by a
//     green verdict or an admin's resume — a run that could not happen
//     leaves it alone;
//   * the messages name the failing test, not just "is failing".
//
// The level-and-green pass-through the pause makes room for is the gate's
// business: tests/votes-integration-gate.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';
delete process.env.MAIN_WATCH_ENABLED;
delete process.env.MAIN_WATCH_CONFIRM;

// The two lazily-required collaborators, stubbed before main-watch can load
// them: the group message and the queue kick are the observable outcomes.
const posted = [];
const enqueued = [];
require.cache[require.resolve('../src/services/ws')] = {
  id: 'ws', filename: 'ws', loaded: true,
  exports: {
    sendSystemMessage: async (pool, appId, content) => { posted.push({ appId, content }); },
    pushSessionUpdate: () => {},
  },
};
require.cache[require.resolve('../src/services/merge-queue')] = {
  id: 'merge-queue', filename: 'merge-queue', loaded: true,
  exports: { enqueue: (config, appId) => { enqueued.push(appId); } },
};

const unitSuite = require('../src/services/unit-suite');
const mainWatch = require('../src/services/main-watch');
const checkRuns = require('../src/services/check-runs');

const SHA = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const APP = { id: 12, slug: 'demo', repo_url: 'https://github.com/org/demo' };
const config = { workerRuntime: 'docker' };

// A pool that answers the statements main-watch issues, and records them.
// `claim` is what the CTE's prev block returns; `verdictRows` is the row
// count of each CAS write (a number for all of them, or an array consumed
// in order — the held 'confirming' write, then the verdict).
function fakePool({ claim = { was_state: null, was_sha: null, was_paused_sha: null }, verdictRows = 1, resumeRow = null } = {}) {
  const calls = [];
  const rowCounts = Array.isArray(verdictRows) ? [...verdictRows] : null;
  return {
    calls,
    // The state writes, in order, as [state, detail, clearPause, setPause].
    writes() {
      return calls.filter((c) => /SET main_check_state = \$3/.test(c.sql))
        .map((c) => [c.params[2], JSON.parse(c.params[3]), c.params[4], c.params[5]]);
    },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/main_check_state = 'running'/.test(sql)) return { rows: [claim], rowCount: 1 };
      if (/SET main_check_state = \$3/.test(sql)) {
        const n = rowCounts ? (rowCounts.length ? rowCounts.shift() : 1) : verdictRows;
        return { rows: [], rowCount: n };
      }
      if (/SET main_check_resumed_sha = main_check_paused_sha/.test(sql)) {
        return { rows: resumeRow ? [resumeRow] : [], rowCount: resumeRow ? 1 : 0 };
      }
      if (/SELECT main_check_state/.test(sql)) return { rows: [claim.row || {}], rowCount: 1 };
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

// A stub that answers from a script, one entry per run.
function scripted(...answers) {
  return stubSuite(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

const pass = { row: { status: 'pass', failureReason: '', summary: { tests: 40, pass: 40, fail: 0 } } };
const fail = (reason) => ({ row: { status: 'fail', failureReason: reason, summary: { tests: 40, pass: 39, fail: 1 } } });
// The shape services/unit-suite.js failureDetail actually produces: the TAP
// `not ok` lines, then the summary, joined with ` | `.
const TAP_RED = 'not ok 6972 - shared-sessions returns linked_issues per row | # tests 7010 | # pass 7009 | # fail 1';
const run = (pool, extra = {}) => mainWatch.afterMerge(config, pool, { app: APP, session: { id: 3, pr_number: 41 }, mergeSha: SHA, ...extra });

test.beforeEach(() => { posted.length = 0; enqueued.length = 0; delete process.env.MAIN_WATCH_CONFIRM; });

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

test('afterMerge: a suite that never ran records error, is not re-run to confirm, and pauses nothing', async () => {
  const notRun = await unitSuite.outcomeFromLog({ pool: null, appId: 12, sessionId: 'main-12', succeeded: false, stdout: '', stderr: 'BackoffLimitExceeded: Error', graduated: true });
  const pool = fakePool();
  const suite = stubSuite(async () => notRun);
  try {
    const out = await run(pool);
    assert.equal(out.state, 'error');
    assert.equal(suite.calls.length, 1, 'only a red is asked again');
    assert.deepEqual(pool.writes().map(([state, , clear, set]) => [state, clear, set]), [['error', false, false]]);
    assert.match(out.detail.failureReason, /^The unit suite stopped before any test ran: /);
  } finally { suite.restore(); }
});

// ── afterMerge ───────────────────────────────────────────────────────────

test('afterMerge: a green run records passing, clears the pause column, and tells nobody', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => pass);
  try {
    const out = await run(pool);
    assert.equal(out.state, 'passing');
    assert.equal(out.sha, SHA);
    // The run is named for the app, not a session, so a session's own
    // cleanup cannot take it down; and it runs the merge commit itself.
    assert.equal(suite.calls.length, 1, 'green needs no second opinion');
    assert.equal(suite.calls[0].sessionId, 'main-12');
    assert.equal(suite.calls[0].ref, SHA);
    assert.equal(suite.calls[0].repoOwner, 'org');
    assert.equal(suite.calls[0].repoName, 'demo');
    assert.equal(suite.calls[0].prNumber, null, 'not a PR run');
    // Claim, then CAS write for the same sha.
    assert.match(pool.calls[0].sql, /main_check_state = 'running', main_check_sha = \$2/);
    assert.doesNotMatch(pool.calls[0].sql, /main_check_paused_sha =/, 'a new merge is a new question, not an answer to the old one');
    assert.deepEqual(pool.calls[0].params.slice(0, 2), [12, SHA]);
    assert.match(pool.calls[1].sql, /WHERE id = \$1 AND main_check_sha = \$2/);
    assert.deepEqual(pool.writes().map(([state, , clear, set]) => [state, clear, set]),
      [['passing', true, false]], 'green clears the pause; nothing sets it');
    assert.equal(posted.length, 0, 'green is the common case; nobody is told');
    assert.equal(enqueued.length, 0);
  } finally { suite.restore(); }
});

test('afterMerge: a concurrent or completed claim for the same SHA does not run the suite again', async () => {
  const pool = fakePool({ claim: null });
  const suite = stubSuite(async () => pass);
  try {
    assert.equal(await run(pool), null);
    assert.equal(suite.calls.length, 0);
    assert.match(pool.calls[0].sql, /main_check_sha IS DISTINCT FROM \$2/);
    assert.equal(pool.calls[0].params[3], false);
  } finally { suite.restore(); }
});

test('afterMerge: a first red is provisional — it holds the pause (the banner says so) and re-runs once', async () => {
  const pool = fakePool();
  const suite = scripted(fail(TAP_RED), fail(TAP_RED));
  try {
    const out = await run(pool);
    assert.equal(suite.calls.length, 2, 'the suite ran twice');
    assert.equal(suite.calls[1].ref, SHA, 'on the same commit');
    assert.equal(suite.calls[1].sessionId, 'main-12');
    const writes = pool.writes();
    assert.equal(writes.length, 2, 'the held state, then the verdict');
    // Held: 'confirming' pauses (unless already resumed for this sha) and
    // says it is a first run.
    assert.equal(writes[0][0], 'confirming');
    assert.equal(writes[0][1].confirming, true);
    assert.deepEqual(writes[0].slice(2), [false, true]);
    // Verdict: confirmed red, with the first run kept for the record.
    assert.equal(out.state, 'failing');
    assert.equal(writes[1][0], 'failing');
    assert.equal(writes[1][1].confirmed, true);
    assert.equal(writes[1][1].firstRun.failureReason, TAP_RED);
    assert.deepEqual(writes[1].slice(2), [false, true]);
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
    assert.equal(enqueued.length, 0, 'red kicks nothing');
  } finally { suite.restore(); }
});

test('afterMerge: red then green is a flake — recorded as passing, the pause lifts, the queue goes', async () => {
  const pool = fakePool();
  const suite = scripted(fail(TAP_RED), pass);
  try {
    const out = await run(pool);
    assert.equal(suite.calls.length, 2);
    assert.equal(out.state, 'passing');
    const writes = pool.writes();
    assert.deepEqual(writes.map(([state, , clear, set]) => [state, clear, set]),
      [['confirming', false, true], ['passing', true, false]]);
    assert.equal(writes[1][1].flake.failureReason, TAP_RED, 'the failure that did not repeat is kept');
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
    assert.deepEqual(enqueued, [12], 'whatever waited out the re-run can go');
  } finally { suite.restore(); }
});

test('afterMerge: a re-run that could not happen neither confirms nor clears — the first red stands', async () => {
  const pool = fakePool();
  const suite = scripted(fail(TAP_RED), new Error('docker daemon unreachable'));
  try {
    const out = await run(pool);
    assert.equal(out.state, 'failing');
    const writes = pool.writes();
    assert.equal(writes[1][0], 'failing');
    assert.equal(writes[1][1].confirmed, false);
    assert.match(writes[1][1].confirmation.failureReason, /docker daemon unreachable/);
    assert.equal(writes[1][1].failureReason, TAP_RED, 'the verdict is the first run');
    assert.equal(enqueued.length, 0);
  } finally { suite.restore(); }
});

test('afterMerge: MAIN_WATCH_CONFIRM=0 takes the first red at its word', async () => {
  process.env.MAIN_WATCH_CONFIRM = '0';
  const pool = fakePool();
  const suite = stubSuite(async () => fail('1 of 40 tests failed: votes › tally'));
  try {
    assert.equal(mainWatch.confirmEnabled(), false);
    const out = await run(pool);
    assert.equal(out.state, 'failing');
    assert.equal(suite.calls.length, 1, 'no re-run');
    assert.deepEqual(pool.writes().map(([state]) => state), ['failing']);
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
  } finally { suite.restore(); }
});

test('afterMerge: green after red lifts the pause and lets the queue go', async () => {
  // The claim's prev block says what this run supersedes: a pause.
  const pool = fakePool({ claim: { was_state: 'failing', was_sha: OLD, was_paused_sha: OLD } });
  const suite = stubSuite(async () => pass);
  try {
    await run(pool, { session: { id: 4, pr_number: 42 } });
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
    assert.deepEqual(enqueued, [12], 'whatever was approved during the pause can merge now');
  } finally { suite.restore(); }
});

test('afterMerge: green after a pause the state no longer shows still lets the queue go', async () => {
  // A red, then a merge whose run errored: state 'error', pause column still
  // set. The green that follows is a recovery, and is announced as one.
  const pool = fakePool({ claim: { was_state: 'error', was_sha: OLD, was_paused_sha: 'e'.repeat(40) } });
  const suite = stubSuite(async () => pass);
  try {
    await run(pool);
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
    assert.deepEqual(enqueued, [12]);
  } finally { suite.restore(); }
});

test('afterMerge: a verdict for a superseded merge is discarded, not written', async () => {
  // A newer merge re-claimed the row while this run was going: the CAS
  // write matches no row, and the stale verdict must not become the answer.
  const pool = fakePool({ verdictRows: 0 });
  const suite = stubSuite(async () => fail('boom'));
  try {
    const out = await run(pool, { mergeSha: OLD, session: null });
    assert.equal(out, null);
    assert.equal(suite.calls.length, 1, 'a superseded first red is not worth a second run');
    assert.equal(posted.length, 0, 'a discarded verdict pauses nothing and tells nobody');
  } finally { suite.restore(); }
});

test('afterMerge: a merge that supersedes the row mid-confirmation discards the verdict', async () => {
  // The held write landed; the verdict write did not.
  const pool = fakePool({ verdictRows: [1, 0] });
  const suite = scripted(fail(TAP_RED), fail(TAP_RED));
  try {
    const out = await run(pool);
    assert.equal(out, null);
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
  } finally { suite.restore(); }
});

test('afterMerge: a run that could not happen records error and leaves the pause as it was', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => { throw new Error('docker daemon unreachable'); });
  try {
    const out = await run(pool, { session: null });
    assert.equal(out.state, 'error');
    assert.match(out.detail.failureReason, /docker daemon unreachable/);
    assert.deepEqual(pool.writes().map(([state, , clear, set]) => [state, clear, set]),
      [['error', false, false]], 'neither clears nor sets: a run that says nothing about main cannot lift a pause');
    assert.equal(posted.length, 0);
  } finally { suite.restore(); }
});

test('afterMerge: nothing runs without a repo, a sha, or the switch on', async () => {
  const pool = fakePool();
  const suite = stubSuite(async () => pass);
  try {
    assert.equal(await mainWatch.afterMerge(config, pool, { app: { id: 1, repo_url: 'not-github' }, mergeSha: SHA }), null);
    assert.equal(await mainWatch.afterMerge(config, pool, { app: APP, mergeSha: null }), null);
    assert.equal(await mainWatch.afterMerge(config, null, { app: APP, mergeSha: SHA }), null);
    process.env.MAIN_WATCH_ENABLED = '0';
    try {
      assert.equal(mainWatch.isEnabled(), false);
      assert.equal(await mainWatch.afterMerge(config, pool, { app: APP, mergeSha: SHA }), null);
    } finally { delete process.env.MAIN_WATCH_ENABLED; }
    assert.equal(suite.calls.length, 0);
    assert.equal(pool.calls.length, 0, 'no claim is written for a run that will not happen');
  } finally { suite.restore(); }
});

test('the pause write is the same CASE for every verdict, keyed on the sha it is about', () => {
  // Pinned as source: green clears, red/confirming sets unless an admin
  // already resumed THIS sha, anything else leaves the column alone. A red
  // of known flakes alone (detail.flakesOnly) is green for the pause. The
  // fake pool cannot evaluate SQL, so the shape is what stands in for it.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'main-watch.js'), 'utf8');
  const write = src.slice(src.indexOf('async function writeState'), src.indexOf('async function afterMerge'));
  assert.match(write, /main_check_paused_sha = CASE\s+WHEN \$5::boolean THEN NULL\s+WHEN \$6::boolean AND lower\(coalesce\(main_check_resumed_sha, ''\)\) <> lower\(\$2::text\) THEN \$2::text\s+ELSE main_check_paused_sha\s+END/);
  assert.match(write, /WHERE id = \$1 AND main_check_sha = \$2::text/);
  assert.match(write, /const quiet = !!detail && Array\.isArray\(detail\.flakesOnly\) && detail\.flakesOnly\.length > 0;/);
  assert.match(write, /state === 'passing' \|\| quiet, \(state === 'failing' \|\| state === 'confirming'\) && !quiet/);
});

// ── resume ───────────────────────────────────────────────────────────────

test('resume: lifts the pause, remembers its sha, and kicks the queue', async () => {
  const row = {
    main_check_state: 'failing', main_check_sha: SHA, main_check_at: new Date(), main_check_detail: {},
    main_check_resumed_sha: SHA, main_check_paused_sha: null,
  };
  const pool = fakePool({ resumeRow: row });
  const out = await mainWatch.resume(config, pool, 12, { by: { username: 'evan' } });
  assert.equal(out.paused, false, 'the column is cleared');
  assert.equal(out.resumedSha, SHA, 'and remembered, so a red still in flight for this sha cannot re-pause');
  assert.match(pool.calls[0].sql, /SET main_check_resumed_sha = main_check_paused_sha, main_check_paused_sha = NULL/);
  assert.match(pool.calls[0].sql, /WHERE id = \$1 AND main_check_paused_sha IS NOT NULL/);
  assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
  assert.deepEqual(enqueued, [12]);
});

test('resume: nothing to resume when merges are not paused', async () => {
  const pool = fakePool({ resumeRow: null });
  assert.equal(await mainWatch.resume(config, pool, 12, { by: { username: 'evan' } }), null);
  assert.equal(posted.length, 0);
  assert.equal(enqueued.length, 0);
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

// ── resumeInterrupted ────────────────────────────────────────────────────
//
// afterMerge is fire-and-forget from the process that merged, and for the
// platform's own app that process is replaced by the deploy of the merge it
// is testing. A row left at 'running' read "checking the last merge" forever;
// one left at 'confirming' is paused with no verdict coming and no Resume
// verb (a provisional red hides it). The leader re-drives both.

// A pool for the sweep: answers the interrupted-rows SELECT from `rows`, and
// everything afterwards like fakePool (each re-driven app shares one pool
// here; the claim answers the same for all).
function sweepPool(rows, { claim } = {}) {
  const inner = fakePool({ claim: claim || { was_state: rows[0] && rows[0].main_check_state, was_sha: SHA, was_paused_sha: SHA } });
  const pool = {
    calls: inner.calls,
    writes: inner.writes,
    async query(sql, params) {
      if (/FROM apps\b/.test(sql) && /main_check_state IN \('running', 'confirming'\)/.test(sql)) {
        inner.calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      }
      return inner.query(sql, params);
    },
  };
  return pool;
}

const INTERRUPTED_CONFIRMING = {
  id: 12, slug: 'demo', repo_url: 'https://github.com/org/demo',
  main_check_state: 'confirming', main_check_sha: SHA,
  main_check_detail: { prNumber: 41, sessionId: 3, confirming: true, failureReason: TAP_RED, summary: { tests: 40, pass: 39, fail: 1 } },
};

test('resumeInterrupted: an interrupted confirmation resumes at the re-run, with the first red carried over', async () => {
  const pool = sweepPool([INTERRUPTED_CONFIRMING]);
  const suite = scripted(pass);
  try {
    const out = await mainWatch.resumeInterrupted(config, { pool, olderThanMs: 1000 });
    assert.deepEqual(out.resumed, [{ appId: 12, sha: SHA, was: 'confirming', adopting: false }]);
    await out.done;
    // Only the rows a live run could not still be stamping.
    const sel = pool.calls.find((c) => /main_check_state IN \('running', 'confirming'\)/.test(c.sql));
    assert.match(sel.sql, /main_check_at < NOW\(\) - \(\$1::int \* interval '1 millisecond'\)/);
    assert.deepEqual(sel.params, [1000, checkRuns.ORPHAN_MS]);
    assert.equal(suite.calls.length, 1, 'ONE run: the confirmation, not the first run again');
    assert.equal(suite.calls[0].ref, SHA);
    assert.equal(suite.calls[0].sessionId, 'main-12');
    const writes = pool.writes();
    assert.deepEqual(writes.map(([state, , clear, set]) => [state, clear, set]),
      [['confirming', false, true], ['passing', true, false]]);
    assert.equal(writes[0][1].failureReason, TAP_RED, 'the held state is the recorded first red');
    assert.equal(writes[0][1].prNumber, 41, 'with the merge it was about');
    assert.equal(writes[1][1].flake.failureReason, TAP_RED, 'green on the re-run: a flake, like an uninterrupted one');
    // The group heard about the first red before the restart; it hears the
    // outcome, not the restart.
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
    assert.deepEqual(enqueued, [12]);
  } finally { suite.restore(); }
});

test('resumeInterrupted: an interrupted confirmation that fails again is a confirmed red', async () => {
  const pool = sweepPool([INTERRUPTED_CONFIRMING]);
  const suite = scripted(fail(TAP_RED));
  try {
    const out = await mainWatch.resumeInterrupted(config, { pool, olderThanMs: 1000 });
    await out.done;
    assert.equal(suite.calls.length, 1);
    const writes = pool.writes();
    assert.equal(writes[1][0], 'failing');
    assert.equal(writes[1][1].confirmed, true);
    assert.equal(writes[1][1].firstRun.failureReason, TAP_RED);
    assert.equal(posted.length, 0, 'a channel carries no activity: the board banner says it');
  } finally { suite.restore(); }
});

test('resumeInterrupted: an interrupted first run runs the suite again for that sha', async () => {
  const pool = sweepPool([{
    ...INTERRUPTED_CONFIRMING, main_check_state: 'running',
    main_check_detail: { prNumber: 41, sessionId: 3 },
  }], { claim: { was_state: 'running', was_sha: SHA, was_paused_sha: null } });
  const suite = scripted(pass);
  try {
    const out = await mainWatch.resumeInterrupted(config, { pool, olderThanMs: 1000 });
    assert.deepEqual(out.resumed, [{ appId: 12, sha: SHA, was: 'running', adopting: false }]);
    await out.done;
    assert.equal(suite.calls.length, 1);
    assert.deepEqual(pool.writes().map(([state]) => state), ['passing']);
    assert.equal(posted.length, 0, 'green after nothing: nobody is told');
  } finally { suite.restore(); }
});

// 12 Oct 2026: a release restarted the platform while main was confirming a
// red, and main stayed held until the run was 12 minutes stale and ran from
// the start. The run's Jobs were still on the cluster. Now a run whose queue
// row has stopped being heartbeated is taken over at once, and its Jobs read.
const kubernetes = require('../src/services/kubernetes');
const DEAD = { dead_run_id: '0f0e0d0c-0b0a-4908-8706-050403020100', dead_owner: 'platform-old-pod', dead_admitted_at: new Date() };
const KUBE = { workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };

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

// The sweep's pool, also answering the queue row's take-over: claimed
// unless `claimed` is false.
function adoptPool(row, { claimed = true } = {}) {
  const pool = sweepPool([row]);
  const query = pool.query;
  pool.query = async (sql, params) => {
    if (/UPDATE check_runs SET owner = \$2, heartbeat_at = NOW\(\)/.test(sql)) {
      pool.calls.push({ sql, params });
      return { rows: [], rowCount: claimed ? 1 : 0 };
    }
    return query(sql, params);
  };
  return pool;
}

test('resumeInterrupted: a run whose process died is taken over at once, and its Jobs read rather than run again', async () => {
  const pool = adoptPool({ ...INTERRUPTED_CONFIRMING, ...DEAD });
  const stubs = adoptStubs();
  const suite = scripted();
  try {
    const out = await mainWatch.resumeInterrupted(KUBE, { pool });
    assert.deepEqual(out.resumed, [{ appId: 12, sha: SHA, was: 'confirming', adopting: true }]);
    await out.done;
    const sel = pool.calls.find((c) => /main_check_state IN \('running', 'confirming'\)/.test(c.sql));
    assert.match(sel.sql, /OR dead\.run_id IS NOT NULL/, 'a dead queue row is enough; no 12-minute wait');
    assert.equal(suite.calls.length, 0, 'no new run: the confirming run\'s own Jobs are read');
    assert.deepEqual(stubs.seen.find, [{ sessionId: 'main-12', previewRunId: DEAD.dead_run_id }]);
    assert.equal(stubs.seen.collect.length, 1);
    assert.equal(stubs.seen.read[0].sessionId, 'main-12');
    const claim = pool.calls.find((c) => /UPDATE check_runs SET owner = \$2/.test(c.sql));
    assert.deepEqual([claim.params[0], claim.params[2]], [DEAD.dead_run_id, 'platform-old-pod'], 'claimed from the owner it was seen with');
    assert.ok(pool.calls.some((c) => /DELETE FROM check_runs WHERE run_id = \$1/.test(c.sql) && c.params[0] === DEAD.dead_run_id),
      'its queue row is cleared');
    assert.deepEqual(stubs.seen.deleted, [{ sessionId: 'main-12', previewRunId: DEAD.dead_run_id }], 'and its read-out Jobs deleted');
    assert.deepEqual(pool.writes().map(([state]) => state), ['confirming', 'passing']);
  } finally { suite.restore(); stubs.restore(); }
});

test('resumeInterrupted: a dead run that left no Jobs, or one another process took first, does not stand in the way', async () => {
  let pool = adoptPool({ ...INTERRUPTED_CONFIRMING, ...DEAD });
  let stubs = adoptStubs({ jobs: [] });
  let suite = scripted(pass);
  try {
    await (await mainWatch.resumeInterrupted(KUBE, { pool })).done;
    assert.equal(suite.calls.length, 1, 'no Jobs to read: the confirmation runs again');
  } finally { suite.restore(); stubs.restore(); }

  pool = adoptPool({ ...INTERRUPTED_CONFIRMING, ...DEAD }, { claimed: false });
  stubs = adoptStubs();
  suite = scripted(pass);
  try {
    await (await mainWatch.resumeInterrupted(KUBE, { pool })).done;
    assert.equal(suite.calls.length, 0);
    assert.equal(stubs.seen.find.length, 0, 'the process that took it reads it');
    assert.deepEqual(pool.writes().map(([state]) => state), ['confirming'], 'and stores the verdict');
  } finally { suite.restore(); stubs.restore(); }

  // A row still waiting for its slot had no Jobs: it is re-driven, as before.
  pool = adoptPool({ ...INTERRUPTED_CONFIRMING, ...DEAD, dead_admitted_at: null });
  stubs = adoptStubs();
  suite = scripted(pass);
  try {
    const out = await mainWatch.resumeInterrupted(KUBE, { pool });
    assert.equal(out.resumed[0].adopting, false);
    await out.done;
    assert.equal(stubs.seen.find.length, 0);
    assert.equal(suite.calls.length, 1);
  } finally { suite.restore(); stubs.restore(); }
});

// Two adopters of one dead run at once (a boot sweep and the timer, or two
// processes in a rollout's overlap): the queue row's claim is a compare-and-
// set, and the one that lost it used to clear the row anyway, in its
// `finally`. That deleted the row the winner heartbeats and freed its checks
// slot while its Jobs still ran. The row here is one in-memory check_runs row
// that the claim, the delete and the heartbeat really act on.
function contestedPool(row) {
  const pool = sweepPool([row], { claim: { was_state: 'running', was_sha: SHA, was_paused_sha: null } });
  const query = pool.query;
  const queueRow = { run_id: DEAD.dead_run_id, owner: DEAD.dead_owner, present: true };
  pool.queueRow = queueRow;
  pool.query = async (sql, params) => {
    if (/UPDATE check_runs SET owner = \$2, heartbeat_at = NOW\(\)/.test(sql)) {
      pool.calls.push({ sql, params });
      const won = queueRow.present && params[0] === queueRow.run_id && queueRow.owner === params[2];
      if (won) queueRow.owner = params[1];
      return { rows: [], rowCount: won ? 1 : 0 };
    }
    if (/DELETE FROM check_runs WHERE run_id = \$1/.test(sql)) {
      pool.calls.push({ sql, params });
      const hit = queueRow.present && params[0] === queueRow.run_id;
      if (hit) queueRow.present = false;
      return { rows: [], rowCount: hit ? 1 : 0 };
    }
    return query(sql, params);
  };
  return pool;
}

test('resumeInterrupted: of two adopters of one dead run, only the one that claimed it clears its queue row', async () => {
  const pool = contestedPool({
    ...INTERRUPTED_CONFIRMING, ...DEAD, main_check_state: 'running',
    main_check_detail: { prNumber: 41, sessionId: 3 },
  });
  const stubs = adoptStubs();
  // The winner's Job is still running: its read waits until it ends.
  let endJob;
  const jobEnded = new Promise((resolve) => { endJob = resolve; });
  const collect = kubernetes.collectCheckJob;
  kubernetes.collectCheckJob = async (cfg, args) => { await jobEnded; return collect(cfg, args); };
  const suite = scripted(pass);
  try {
    const [first, second] = await Promise.all([
      mainWatch.resumeInterrupted(KUBE, { pool }),
      mainWatch.resumeInterrupted(KUBE, { pool }),
    ]);
    assert.equal(first.resumed[0].adopting, true);
    assert.equal(second.resumed[0].adopting, true);
    // Both have tried the claim; the loser has gone, the winner is reading.
    for (let i = 0; i < 50 && stubs.seen.collect.length === 0; i++) await new Promise((r) => setImmediate(r));
    const claims = pool.calls.filter((c) => /UPDATE check_runs SET owner = \$2/.test(c.sql));
    assert.equal(claims.length, 2, 'both asked for the row');
    assert.equal(stubs.seen.find.length, 1, 'only the winner looks for the Jobs');
    assert.equal(pool.queueRow.present, true, 'the loser left the row the winner holds');
    assert.ok(!pool.calls.some((c) => /DELETE FROM check_runs/.test(c.sql)), 'nothing has cleared it yet');

    endJob();
    await Promise.all([first.done, second.done]);
    const deletes = pool.calls.filter((c) => /DELETE FROM check_runs WHERE run_id = \$1/.test(c.sql));
    assert.equal(deletes.length, 1, 'cleared once, by the winner, after its read');
    assert.equal(pool.queueRow.present, false);
    assert.equal(suite.calls.length, 0, 'nobody ran the suite again');
    assert.deepEqual(pool.writes().map(([state]) => state), ['passing'], 'one verdict, the winner\'s');
  } finally {
    kubernetes.collectCheckJob = collect;
    suite.restore(); stubs.restore();
  }
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

test('resumeInterrupted: nothing interrupted, nothing runs; the switch off, no query', async () => {
  const pool = sweepPool([]);
  const suite = scripted();
  try {
    const out = await mainWatch.resumeInterrupted(config, { pool });
    assert.deepEqual(out.resumed, []);
    assert.deepEqual(await out.done, []);
    assert.equal(suite.calls.length, 0);
    // The default window is a whole run plus a margin: a live run somewhere
    // else in the cluster is stamped within it.
    assert.equal(mainWatch.staleMs(), unitSuite.UNIT_SUITE_TIMEOUT_MS + 120000);
    const sel = pool.calls.find((c) => /main_check_state IN \('running', 'confirming'\)/.test(c.sql));
    assert.deepEqual(sel.params, [mainWatch.staleMs(), checkRuns.ORPHAN_MS]);

    process.env.MAIN_WATCH_ENABLED = '0';
    const off = await mainWatch.resumeInterrupted(config, { pool });
    assert.deepEqual(off.resumed, []);
    assert.equal(pool.calls.filter((c) => /IN \('running', 'confirming'\)/.test(c.sql)).length, 1, 'no second query');
  } finally { suite.restore(); delete process.env.MAIN_WATCH_ENABLED; }
});

test('resumeInterrupted: a failing list is non-fatal', async () => {
  const pool = { query: async () => { throw new Error('connection reset'); } };
  const out = await mainWatch.resumeInterrupted(config, { pool });
  assert.deepEqual(out.resumed, []);
});

test('the leader re-drives at boot and on a timer', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const lead = server.slice(server.indexOf('async function becomeLeader()'));
  assert.match(lead, /\.then\(\(\) => mainWatch\.resumeInterrupted\(config\)\)/, 'in the boot recovery chain');
  assert.match(lead, /\.catch\(\(err\) => \{[\s\S]{0,200}?\}\);\s*mainWatch\.start\(config\);/, 'right after the boot recovery chain');
  const stop = mainWatch.start(config, { intervalMs: 60 * 60 * 1000 });
  assert.equal(typeof stop, 'function');
  stop();
});

test('the route and the gate read the same module', () => {
  // The admin resume route and checkAndMerge's main_healthy gate both go
  // through main-watch; pin the file so a rename cannot leave one behind.
  const fs = require('node:fs');
  const apps = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');
  const votes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  assert.match(apps, /main-check\/resume/);
  assert.match(apps, /mainWatch\.resume\(/);
  assert.match(votes, /mergePause\(/);
  // The run after a merge is the merge-followups machine's main.check work.
  const services = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflow', 'merge-followups', 'services.ts'), 'utf8');
  assert.match(services, /legacy\('services\/main-watch'\)\.afterMerge\(/);
});

test('the schema carries the pause column and the backfill for the derived pauses', () => {
  const fs = require('node:fs');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_paused_sha VARCHAR\(40\);/);
  // Idempotent: red, not resumed for that red, not a red of known flakes
  // alone (which pauses nothing on purpose), and not yet carrying the
  // column. Runs at every boot without moving anything twice.
  assert.match(schema, /UPDATE apps\s+SET main_check_paused_sha = main_check_sha\s+WHERE main_check_state = 'failing'\s+AND main_check_sha IS NOT NULL\s+AND main_check_paused_sha IS NULL\s+AND lower\(coalesce\(main_check_resumed_sha, ''\)\) <> lower\(main_check_sha\)\s+AND \(main_check_detail -> 'flakesOnly'\) IS NULL;/);
  // The API serializes the column with its siblings.
  const access = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'app-access.js'), 'utf8');
  assert.match(access, /'main_check_resumed_sha', 'main_check_paused_sha',/);
});

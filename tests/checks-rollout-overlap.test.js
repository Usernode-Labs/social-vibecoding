'use strict';

// The rollout relabel is retired: a run that crossed a restart is judged on
// its own results.
//
// #3828 recorded a red run as 'error' with "Checks ran while Homeroom was
// updating, so they will run again." whenever the harvest settled it (it
// outlived the process that launched it) or it started within five minutes
// of a boot. Measured in production, that was the wrong cause: across 701
// runs from 5 Oct 2026 that no rollout overlapped, 9% came back red while
// the check Jobs used under 10 cores of the cluster and 24 to 29% above it,
// and at equal load a rollout added little. So the relabel excused failures
// that were the change's, and the checks queue (services/checks-queue.js)
// bounds the load that caused the rest.
//
// What still reads as infrastructure is what the run's own output shows to
// be: an origin no route could reach (#1381), a Postgres out of connections
// (#1771), a unit suite that never ran. Those classifiers apply to a
// harvested run exactly as to a live one.
//
// The copy stays for the rows already stored with it: storeChecks gave each
// a retry, so the error lane runs them again and every surface that reads
// one still says so until it settles.
//
// Run with: node --test tests/checks-rollout-overlap.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The scripts under test read their text from the language runtime's
// global; give them the real English one.
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const fs = require('node:fs');
const path = require('node:path');

const visuals = require('../src/services/visuals');
const stagingRecovery = require('../src/services/staging-recovery');
const harvest = require('../src/services/check-harvest');
const kubernetes = require('../src/services/kubernetes');
const lifecycle = require('../src/services/preview-lifecycle');
const ws = require('../src/services/ws');
const tools = require('../src/services/mcp-tools');
const mergeRequirements = require('../src/services/merge-requirements');
const appManifest = require('../src/services/app-manifest');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/^[ \t]*\/\/.*$/gm, '');

const { ROLLOUT_RETRY_DETAIL } = stagingRecovery;
const SHA = 'abc123';

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

// One capture frame, in the container's own protocol (capture/capture.js).
function frame(index, status, extra = {}) {
  const payload = Buffer.from(JSON.stringify({
    name: `Board check ${index + 1}`, path: '/board', consoleErrors: [], ...extra,
  })).toString('base64');
  return `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200\n${payload}\n__USERNODE_TEST_END__`;
}

// The shape of the 2026-10-04 runs the relabel was written for: the page
// answered, slowly, so one check timed out and the rest passed. Not a total
// wipeout, so neither infrastructure rule reads it as one.
const RED = [
  frame(0, 'pass'),
  frame(1, 'fail', { failureReason: 'Page failed to load: Timed out after 23861ms' }),
  frame(2, 'pass'),
].join('\n');
const GREEN = [frame(0, 'pass'), frame(1, 'pass'), frame(2, 'pass')].join('\n');
// #1381: not one route could be reached.
const UNREACHABLE = [0, 1, 2].map((i) => frame(i, 'fail', {
  consoleErrors: [{ kind: 'load', message: 'net::ERR_CONNECTION_REFUSED at https://demo--s42.preview' }],
})).join('\n');
// #1771: every route failed, and the failures name the full server.
const STARVED = [0, 1, 2].map((i) => frame(i, 'fail', {
  failureReason: 'GET /api/board answered 500: sorry, too many clients already',
})).join('\n');

// A pool that answers what a settlement and a harvest ask. `checks` collects
// every storeChecks write as { state, detail, retryScheduled, streakBumped }.
// `graduated` is the app's graduated check keys.
function makePool({ session = null, orphans = [], graduated = [] } = {}) {
  const pool = {
    calls: [], checks: [], deleted: [],
    async query(sql, params = []) {
      pool.calls.push({ sql, params });
      if (/UPDATE chat_sessions\s+SET check_state = \$1/.test(sql)) {
        const retryScheduled = /check_next_retry_at = NOW\(\) \+ make_interval/.test(sql);
        pool.checks.push({
          state: params[0],
          detail: retryScheduled ? params[4] : null,
          retryScheduled,
          streakBumped: /consecutive_check_failures = consecutive_check_failures \+ 1/.test(sql),
        });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT check_key FROM app_check_history/.test(sql)) {
        return { rows: graduated.map((key) => ({ check_key: key })), rowCount: graduated.length };
      }
      if (/SELECT run_id, session_id, commit_sha, owner, manifest/.test(sql)) {
        return { rows: orphans.map((r) => ({ ...r })), rowCount: orphans.length };
      }
      if (/UPDATE check_runs SET owner/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM check_runs/.test(sql)) { pool.deleted.push(params[0]); return { rows: [], rowCount: 1 }; }
      if (/FROM chat_sessions cs JOIN apps a/.test(sql)) {
        return { rows: session ? [{ ...session }] : [], rowCount: session ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: (sql, params) => pool.query(sql, params), release() {} };
    },
  };
  return pool;
}

// getPool() hands the connection census the lifecycle operation's pool when
// one is current; pointing it at the fake keeps the census off the network.
function quiet(t, pool) {
  stub(t, lifecycle, { current: () => ({ pool }) });
  stub(t, ws, { broadcastGlobal: () => {} });
}

const SESSION = {
  id: 42, app_id: 9, status: 'promoted', pr_number: null, source: 'native',
  checks_commit_sha: SHA, branch_name: 'usernode/s42',
};
const APP = { id: 9, slug: 'demo', name: 'Demo', repo_url: '' };

function settle(pool, { stdout, sent = [], unitOutcome = null }) {
  return visuals.settleCaptureRun({}, pool, {
    session: SESSION, app: APP, commitHash: SHA, trigger: 'commit-push',
    send: (type, data) => sent.push({ type, ...data }),
    runStartedAt: Date.now(), media: false, capturePaths: ['/board'],
    pathDefaulted: false, prodRunning: false, stagingOrigin: '', targets: [],
    testsCount: 3, dispatched: null, ceilingDropped: 0,
    stdout, stderr: '', runPartial: false, runPartialReason: '', unitOutcome,
  });
}

// ── The copy, kept for the rows that carry it ───────────────────────────

test('the recorded reason is plain, short and fits the field the card shows', () => {
  assert.equal(ROLLOUT_RETRY_DETAIL, 'Checks ran while Homeroom was updating, so they will run again.');
  assert.ok(ROLLOUT_RETRY_DETAIL.length <= 280, 'the card caps check_error_detail at 280 characters');
  assert.doesNotMatch(ROLLOUT_RETRY_DETAIL, /—|&mdash;|&#8212;/, 'user-facing copy carries no em dash');
});

// ── Nothing writes it any more ──────────────────────────────────────────

test('no run writes the rollout reason, and nothing stamps or reads a boot window', () => {
  const visualsSrc = stripComments(read('src/services/visuals.js'));
  assert.doesNotMatch(visualsSrc, /ROLLOUT_RETRY_DETAIL/, 'the settlement never records it');
  assert.doesNotMatch(visualsSrc, /overlappedRollout|startedSoonAfterBoot|markPlatformBooted|ROLLOUT_BOOT_WINDOW_MS|rolloutRetryFollows/);
  assert.equal(visuals.markPlatformBooted, undefined);
  assert.equal(visuals.startedSoonAfterBoot, undefined);
  assert.equal(visuals.ROLLOUT_BOOT_WINDOW_MS, undefined);
  assert.doesNotMatch(stripComments(read('server.js')), /markPlatformBooted/, 'the boot is not stamped');
  assert.doesNotMatch(stripComments(read('src/services/check-harvest.js')), /overlappedRollout/,
    'a harvested run is settled like a live one');
  assert.equal(stagingRecovery.errorVerdictWillRetry, undefined, 'its only reader went with it');
});

test('the auto-retry cap is still read in one place, and the reconcile reads it', (t) => {
  const saved = process.env.CHECK_MAX_AUTO_RETRIES;
  t.after(() => {
    if (saved === undefined) delete process.env.CHECK_MAX_AUTO_RETRIES;
    else process.env.CHECK_MAX_AUTO_RETRIES = saved;
  });
  delete process.env.CHECK_MAX_AUTO_RETRIES;
  assert.equal(stagingRecovery.checkMaxAutoRetries(), 6);
  process.env.CHECK_MAX_AUTO_RETRIES = '3';
  assert.equal(stagingRecovery.checkMaxAutoRetries(), 3);
  process.env.CHECK_MAX_AUTO_RETRIES = 'not a number';
  assert.equal(stagingRecovery.checkMaxAutoRetries(), 6);
  const server = stripComments(read('server.js'));
  assert.match(server, /const CHECK_MAX_AUTO_RETRIES = stagingRecovery\.checkMaxAutoRetries\(\);/);
  assert.match(server, /maxAutoRetries: CHECK_MAX_AUTO_RETRIES/);
});

// ── A live run ──────────────────────────────────────────────────────────

test('a live red run is failing, whenever it started: no lookup, no retry, history recorded', async (t) => {
  const pool = makePool();
  quiet(t, pool);
  const sent = [];
  const out = await settle(pool, { stdout: RED, sent });
  assert.equal(out.result.state, 'failing');
  assert.deepEqual(pool.checks, [{ state: 'failing', detail: null, retryScheduled: false, streakBumped: false }]);
  assert.equal(sent.filter((e) => e.type === 'checks_ready')[0].checkState, 'failing');
  assert.ok(!pool.calls.some((c) => /consecutive_check_failures\s+FROM chat_sessions/.test(c.sql)),
    'it does not ask whether a retry would follow: there is nothing to relabel');
});

test('a live green run is passing', async (t) => {
  const pool = makePool();
  quiet(t, pool);
  assert.equal((await settle(pool, { stdout: GREEN })).result.state, 'passing');
});

// ── A harvested run ─────────────────────────────────────────────────────

const harvestConfig = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers', appNamespace: 'apps' } };

function orphanRow() {
  return {
    run_id: 'run-1', session_id: 42, commit_sha: SHA, owner: 'dead-pod:7',
    started_at: new Date(Date.now() - 90_000).toISOString(),
    heartbeat_at: new Date(Date.now() - 70_000).toISOString(),
    queued_at: new Date(Date.now() - 95_000).toISOString(),
    admitted_at: new Date(Date.now() - 92_000).toISOString(),
    stale: true,
    manifest: {
      launched: true, trigger: 'commit-push', startedAt: Date.now() - 90_000,
      media: false, capturePaths: ['/board'], targets: [], testsCount: 3,
    },
  };
}

function harvestedSession() {
  return {
    id: 42, app_id: 9, status: 'promoted', source: 'native', check_state: 'pending', check_phase: 'testing',
    checks_commit_sha: SHA, branch_name: 'usernode/s42', app_slug: 'demo', app_name: 'Demo', repo_url: '',
    app_runtime_name: null, app_runtime_kind: null,
  };
}

// The run's capture Job finished with `stdout`; `unit` is its unit-suite
// Job's end, if it had one.
async function harvestWith(t, stdout, { unit = null, graduated = [] } = {}) {
  const pool = makePool({ orphans: [orphanRow()], session: harvestedSession(), graduated });
  quiet(t, pool);
  stub(t, kubernetes, {
    findCheckJobs: async () => ({
      capture: { name: 'sv-capture-s42-x', state: 'succeeded' },
      unitSuite: unit ? { name: 'sv-unit-suite-s42-x', state: unit.state } : null,
    }),
    collectCheckJob: async (_cfg, { kind }) => (kind === 'unit-suite' ? {
      stdout: '', stderr: '', exitCode: 1, timedOut: false, partial: false, partialReason: '', ...unit,
    } : {
      state: 'succeeded', stdout, stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '',
    }),
    deleteSettledCheckJobs: async () => 1,
  });
  stub(t, visuals, { scheduleShots: () => {} });
  const summary = await harvest.sweep(harvestConfig, { reason: 'boot', pool });
  const [result] = await summary.done;
  return { pool, result };
}

test('a harvested red run stays failing: crossing a restart is not a reason to run it again', async (t) => {
  const { pool, result } = await harvestWith(t, RED);
  assert.equal(result.outcome, 'settled');
  assert.equal(result.state, 'failing');
  assert.deepEqual(pool.checks, [{ state: 'failing', detail: null, retryScheduled: false, streakBumped: false }],
    'the passing/failing branch of storeChecks: no retry, no streak, no reason');
  assert.deepEqual(pool.deleted, ['run-1'], 'the manifest, and with it the checks slot, is cleared');
});

test('a harvested green run stays passing', async (t) => {
  const { pool, result } = await harvestWith(t, GREEN);
  assert.equal(result.state, 'passing');
  assert.deepEqual(pool.checks.map((c) => c.state), ['passing']);
});

test('the infrastructure classifiers still apply to a harvested run: an unreachable origin (#1381)', async (t) => {
  const { pool, result } = await harvestWith(t, UNREACHABLE);
  assert.equal(result.state, 'error');
  assert.equal(pool.checks.length, 1);
  assert.equal(pool.checks[0].retryScheduled, true, 'the error lane runs it again');
  assert.match(pool.checks[0].detail, /^Staging preview unreachable/);
  assert.notEqual(pool.checks[0].detail, ROLLOUT_RETRY_DETAIL);
});

test('the infrastructure classifiers still apply to a harvested run: Postgres out of connections (#1771)', async (t) => {
  const { pool, result } = await harvestWith(t, STARVED);
  assert.equal(result.state, 'error');
  assert.match(pool.checks[0].detail, /^Infrastructure problem, not this change: the shared Postgres server ran out of connections/);
  assert.equal(pool.checks[0].retryScheduled, true);
});

test('the infrastructure classifiers still apply to a harvested run: a unit suite that never ran', async (t) => {
  const unitKey = appManifest.checkKey(unitSuiteRow.UNIT_CHECK_NAME, unitSuiteRow.UNIT_CHECK_PATH);
  const { pool, result } = await harvestWith(t, GREEN, {
    unit: { state: 'failed', stdout: '', stderr: 'BackoffLimitExceeded: Error' },
    graduated: [unitKey],
  });
  assert.equal(result.state, 'error', 'a merge-blocking suite with no verdict is no verdict');
  assert.match(pool.checks[0].detail, /unit suite/i);
  assert.equal(pool.checks[0].retryScheduled, true);
  assert.notEqual(pool.checks[0].detail, ROLLOUT_RETRY_DETAIL);
});

// ── What people and agents read, for a row stored with it ───────────────
//
// Rows recorded before the relabel was retired still carry the reason and a
// scheduled retry, and the error lane still runs them again, so every
// surface keeps reading them as "will run again" until they settle.

const ORIGIN = 'https://social-vibecoding.usernodelabs.org';
const rolloutRow = (over = {}) => ({
  id: 58, app_slug: 'recipe-box', status: 'promoted', pr_number: 41, branch_name: 'usernode/s58',
  check_state: 'error', check_error_detail: ROLLOUT_RETRY_DETAIL,
  test_results: [{ name: 'Board loads', status: 'fail', failureReason: 'Page failed to load: Timed out after 23861ms' }],
  ...over,
});

test('the connector says the checks will run again, not to fix the tests', () => {
  const shaped = tools.shapeProposal(rolloutRow(), ORIGIN);
  assert.equal(shaped.checks.state, 'error');
  assert.ok(shaped.checks.error.includes(ROLLOUT_RETRY_DETAIL), 'the reason rides along as for any error');
  assert.match(shaped.nextStep, /^Checks on PR #41 \(proposal 58\) ran while Homeroom was updating, so they will run again on their own\./);
  assert.match(shaped.nextStep, /poll get_proposal/);
  assert.doesNotMatch(shaped.nextStep, /Fix the named tests|submit_work/);

  const change = tools.changeNextStep(rolloutRow(), tools.shapeChecks(rolloutRow()), {}, 'external');
  assert.match(change, /ran while Homeroom was updating, so they will run again on their own/);
  assert.doesNotMatch(change, /Its coding agent fixes them/);

  // Any other error with failing rows keeps today's advice.
  const other = tools.shapeProposal(rolloutRow({ check_error_detail: 'Staging preview unreachable' }), ORIGIN);
  assert.match(other.nextStep, /are failing and they gate merge/);
});

// #4265. PR #4217's later run was recorded as a rollout retry while its unit
// suite had failed 18 tests the change itself broke (they failed locally
// too), and nextStep said "There is nothing to fix yet". A rerun does not
// fix a test the code fails, so the rerun note stays and the failing unit
// tests are named beside it.
const unitSuiteRow = require('../src/services/unit-suite-row');
const unitRed = (over = {}) => ({
  index: unitSuiteRow.UNIT_CHECK_INDEX, name: unitSuiteRow.UNIT_CHECK_NAME, path: unitSuiteRow.UNIT_CHECK_PATH,
  status: 'fail', advisory: false, consoleErrors: [],
  failureReason: 'tests/mayor-turn-golden.test.js (18): replays the recorded turn; keeps the tool order…'
    + ' | # tests 21748 | # pass 21713 | # fail 18 | # cancelled 0',
  summary: { tests: 21748, pass: 21713, fail: 18, cancelled: 0 },
  failureDetails: [
    { file: 'tests/mayor-turn-golden.test.js', test: 'replays the recorded turn', excerpt: "error: 'Expected values to be strictly equal'" },
    { file: 'tests/mayor-turn-golden.test.js', test: 'keeps the tool order', excerpt: "error: 'Expected values to be strictly equal'" },
  ],
  ...over,
});
const withUnit = (unit) => rolloutRow({
  test_results: [{ name: 'Board loads', status: 'fail', failureReason: 'Page failed to load: Timed out after 23861ms' }, unit],
});
const RERUN = 'Checks on PR #41 (proposal 58) ran while Homeroom was updating, so they will run again on their own.';

test('#4265: a rerun whose unit suite failed tests names them beside the rerun note', () => {
  const { nextStep } = tools.shapeProposal(withUnit(unitRed()), ORIGIN);
  assert.ok(nextStep.startsWith(`${RERUN} That run's unit suite (npm test) also reported 18 failing tests, including `
    + '<untrusted-content>tests/mayor-turn-golden.test.js: replays the recorded turn</untrusted-content>; '
    + '<untrusted-content>tests/mayor-turn-golden.test.js: keeps the tool order</untrusted-content>. '
    + 'A rerun will not fix a test the code itself fails, so look at them now.'), nextStep);
  assert.doesNotMatch(nextStep, /nothing to fix/i);
  assert.match(nextStep, /checks\.failures has their errors and get_check_output the full output\./);
  assert.match(nextStep, /push to a branch in your OWN fork and call submit_work with proposalId 58 and that branch; otherwise poll get_proposal for the new verdict\. Do not open a second proposal\.$/);

  const change = tools.changeNextStep(withUnit(unitRed()), tools.shapeChecks(withUnit(unitRed())), {}, 'external');
  assert.match(change, /^Checks on PR #41 \(change 58\) ran while Homeroom was updating, so they will run again on their own\. That run's unit suite \(npm test\) also reported 18 failing tests, including /);
  assert.match(change, /Its coding agent fixes them from the change's own page/);
  assert.doesNotMatch(change, /Nothing to fix yet/);
});

test('#4265: failures the run counted but could not name are still counted', () => {
  const unit = unitRed({
    failureReason: '1 test failed, but the saved output does not name it. | # pass 21713 | # fail 1 | BackoffLimitExceeded: Error',
    summary: { tests: 21731, pass: 21713, fail: 1 },
    failureDetails: undefined,
  });
  assert.match(tools.shapeProposal(withUnit(unit), ORIGIN).nextStep,
    /^Checks on PR #41 \(proposal 58\) ran while Homeroom was updating, so they will run again on their own\. That run's unit suite \(npm test\) also reported 1 failing test\. A rerun will not fix/);
});

test('#4265: a unit suite that never ran, or passed, leaves "nothing to fix yet" as it was', () => {
  const setupFailed = unitRed({
    failureReason: 'Suite setup failed (clone / npm ci), so the tests never ran. | npm error code E404 | BackoffLimitExceeded: Error',
    summary: undefined, failureDetails: undefined,
  });
  for (const row of [rolloutRow(), withUnit(setupFailed), withUnit(unitRed({ status: 'pass', failureReason: '', failureDetails: undefined, summary: { tests: 9, pass: 9, fail: 0 } }))]) {
    assert.equal(tools.shapeProposal(row, ORIGIN).nextStep,
      `${RERUN} There is nothing to fix yet and nothing to push: poll get_proposal for the new verdict.`);
    assert.equal(tools.changeNextStep(row, tools.shapeChecks(row), {}, 'external'),
      'Checks on PR #41 (change 58) ran while Homeroom was updating, so they will run again on their own. '
      + 'Nothing to fix yet; call get_change again for the new verdict.');
  }
});

test('the merge requirements read it as running again, not as the author\'s to fix', () => {
  const step = (row) => mergeRequirements.provisional(row).find((s) => s.key === 'checks');
  const rollout = step(rolloutRow());
  assert.equal(rollout.state, 'active');
  assert.equal(rollout.detail.note, 'they ran while Homeroom was updating and will run again');
  const boot = step(rolloutRow({ check_error_detail: '[exited] error: relation "posts" does not exist' }));
  assert.equal(boot.state, 'blocked', 'every other error still blocks on the author');
  assert.match(boot.detail.note, /staging preview could not start/);
});

test('the merge gate blocks on it as an error and words it as a retry', () => {
  const src = stripComments(read('src/routes/votes.js'));
  const gate = src.slice(src.indexOf("const errorDetail = checkState === 'error'"));
  assert.match(gate, /const rolloutRetry = errorDetail === require\('\.\.\/services\/staging-recovery'\)\.ROLLOUT_RETRY_DETAIL;/);
  assert.match(gate, /'ran its tests while Homeroom was updating, so they will run again on their own'/);
  assert.match(gate, /\(\(checkState === 'failing' \|\| checkState === 'error'\) && !rolloutRetry\) \? 'blocked' : 'active'/);
  // It is still not 'passing' or 'skipped', so the gate above it blocks the
  // merge exactly as for any other error.
  assert.match(src, /if \(checkState !== 'passing' && checkState !== 'skipped'\) \{/);
});

// ── The ?demo=1 fixture ─────────────────────────────────────────────────
//
// No ordinary staging steps make a run overlap a rollout, so a mock row is
// how the sentence is reviewable in a preview. It is asserted against the row
// `stagingMockProposals` actually serves, and through the card that renders
// it, not against a hand-made row.

const vm = require('node:vm');

function stagingRow(id) {
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  return JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === id) || null));
}

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null,
      querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
      hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    read('public/js/merge-status.js'),
    read('public/js/session-transcript.js'),
    read('public/js/app-view.js'),
    ';globalThis.__AppView = AppView;',
  ].join('\n'), sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}

test('the demo fixture serves the sentence the settle path writes, and the card leads with it', () => {
  const src = read('src/routes/votes.js');
  assert.match(src, /check_error_detail: ROLLOUT_RETRY_DETAIL,/,
    'a hand-copied string in the fixture would drift from the copy in production');

  const row = stagingRow(9000046);
  assert.ok(row, 'the fixture proposal exists');
  assert.equal(row.check_state, 'error');
  assert.equal(row.check_error_detail, ROLLOUT_RETRY_DETAIL);
  assert.match(row.pr_title, /^\[Mock\] /, 'staging fixtures are obviously fake');

  const notes = makeAppView()._checksStatusNotes({ ...row, status: 'promoted' });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, 'error');
  assert.equal(notes[0].rows[0].parts.join(''), ROLLOUT_RETRY_DETAIL,
    'the reason is the first line of the checks note');
});

test('the board card tag and the status pill read it as running again, not as broken', () => {
  const AppView = makeAppView();
  const MergeStatus = require('../public/js/merge-status.js');
  const gates = (checks) => ({ gates: [
    { key: 'approvals', state: 'waiting' }, { key: 'checks', state: checks }, { key: 'github', state: 'pending' },
  ] });
  const retry = {
    status: 'promoted', check_state: 'error', check_error_detail: ROLLOUT_RETRY_DETAIL,
    test_results: [], mergeRequirements: gates('active'),
  };
  const blocked = { ...retry, check_error_detail: 'Staging preview unreachable', mergeRequirements: gates('blocked') };

  // One rule on both sides: an error the checks gate still counts as in progress.
  assert.equal(AppView._checksWillRetry(retry), true);
  assert.equal(MergeStatus.checksWillRetry(retry), true);
  assert.equal(AppView._checksWillRetry(blocked), false);
  assert.equal(MergeStatus.checksWillRetry(blocked), false);
  assert.equal(MergeStatus.checksWillRetry({ ...retry, mergeRequirements: null }), false,
    'no recorded gate: the error keeps blocking');

  const [reason] = AppView.blockReasons(retry);
  assert.equal(reason.key, 'checks_retry');
  assert.equal(reason.label, 'Checks will run again');
  assert.equal(reason.running, true, 'in flight and nobody need act');
  assert.equal(reason.detail, `${ROLLOUT_RETRY_DETAIL} Merge is blocked until they pass.`);
  const tag = AppView.statusTagSpecs(retry, {}).find((t) => t.data['data-status-tag'] === 'checks_retry');
  assert.equal(tag.cls, AppView.STATUS_TAG_CLS.running);
  assert.equal(tag.spinner, true);

  const pill = MergeStatus.lifecycle(retry);
  assert.equal(pill.key, 'checks_running');
  assert.equal(pill.label, 'Checks will run again');
  assert.match(pill.title, /^Checks ran while Homeroom was updating, so they will run again\. Merge is blocked until they pass\.$/);

  // Every other error still reads as the red "couldn't run".
  assert.equal(AppView.blockReasons(blocked)[0].key, 'checks_error');
  assert.equal(AppView.blockReasons(blocked)[0].label, 'Checks couldn’t run');
  assert.equal(MergeStatus.lifecycle(blocked).key, 'checks_error');
});

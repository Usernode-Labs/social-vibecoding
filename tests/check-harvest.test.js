'use strict';

// Harvesting checks runs whose launching process died (services/check-harvest.js,
// services/check-runs.js, the Kubernetes Job readers, and the visuals seat).
//
// A platform rollout replaces the Pod that was streaming a proposal's
// capture / unit-suite Jobs; the Jobs finish on the cluster anyway. These
// tests pin that the verdict they produce is READ — through the same
// settlement a live run ends with — rather than the suite being started over
// ten minutes later by the stale sweep, and that every other outcome
// (decided meanwhile, head moved, Jobs gone, process died pre-launch, a live
// run already on the session) is classified the way the module header says.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harvest = require('../src/services/check-harvest');
const checkRuns = require('../src/services/check-runs');
const visuals = require('../src/services/visuals');
const kubernetes = require('../src/services/kubernetes');
const unitSuite = require('../src/services/unit-suite');
const stagingRecovery = require('../src/services/staging-recovery');
const ws = require('../src/services/ws');

const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers', appNamespace: 'apps' } };
const flush = () => new Promise(setImmediate);

// A pool that answers the handful of queries a harvest makes. `orphans` are
// the check_runs rows (with the `stale` flag the SQL computes), `session` the
// chat_sessions⋈apps row. Everything else is an empty result.
function makePool({ orphans = [], session = null, answer = null } = {}) {
  const pool = {
    calls: [], deleted: [], claims: [],
    async query(sql, params) {
      pool.calls.push({ sql, params });
      if (answer) { const r = answer(sql, params); if (r) return r; }
      if (/SELECT run_id, session_id, commit_sha, owner, manifest/.test(sql)) {
        return { rows: orphans.map((r) => ({ ...r })), rowCount: orphans.length };
      }
      if (/UPDATE check_runs SET owner/.test(sql)) { pool.claims.push(params); return { rows: [], rowCount: 1 }; }
      if (/UPDATE check_runs SET heartbeat_at/.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM check_runs/.test(sql)) { pool.deleted.push(params[0]); return { rows: [], rowCount: 1 }; }
      if (/FROM chat_sessions cs JOIN apps a/.test(sql)) return { rows: session ? [{ ...session }] : [], rowCount: session ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function orphanRow(over = {}) {
  return {
    run_id: 'run-1', session_id: 42, commit_sha: 'abc123', owner: 'dead-pod:7',
    started_at: new Date(Date.now() - 90_000).toISOString(), heartbeat_at: new Date(Date.now() - 70_000).toISOString(),
    stale: true,
    manifest: {
      launched: true, trigger: 'promote-kick', startedAt: Date.now() - 90_000,
      media: true, capturePaths: ['/'], targets: [{ kind: 'after' }], testsCount: 3, dispatched: ['/'],
    },
    ...over,
  };
}

function sessionRow(over = {}) {
  return {
    id: 42, app_id: 9, status: 'promoted', check_state: 'pending', check_phase: 'testing',
    checks_commit_sha: 'abc123', app_slug: 'demo', app_name: 'Demo', repo_url: 'https://github.com/o/r',
    app_runtime_name: null, app_runtime_kind: null,
    ...over,
  };
}

// Swap a module's exports for the test and restore them afterwards.
function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

function quietBroadcast(t) {
  const seen = [];
  stub(t, ws, { broadcastGlobal: (e) => seen.push(e) });
  return seen;
}

// ── stillCurrent ────────────────────────────────────────────────────────

test('stillCurrent: only a live session still pending on the manifest commit wants the run', () => {
  const { stillCurrent } = harvest;
  assert.equal(stillCurrent(null, 'abc').current, false);
  assert.match(stillCurrent(null, 'abc').why, /gone/);
  assert.match(stillCurrent(sessionRow({ status: 'merged' }), 'abc123').why, /merged/);
  assert.match(stillCurrent(sessionRow({ check_state: 'passing' }), 'abc123').why, /passing/);
  assert.match(stillCurrent(sessionRow({ check_state: null }), 'abc123').why, /unset/);
  assert.match(stillCurrent(sessionRow({ check_phase: 'deferred' }), 'abc123').why, /deferred/,
    'a shots-only run settles by stamping deferred; a manifest outliving the stamp is done');
  assert.match(stillCurrent(sessionRow({ checks_commit_sha: 'def456' }), 'abc123').why, /head moved/);
  assert.equal(stillCurrent(sessionRow(), 'abc123').current, true);
  for (const status of ['promoted', 'active', 'paused', 'merging']) {
    assert.equal(stillCurrent(sessionRow({ status }), 'abc123').current, true, status);
  }
});

// ── check-runs: what counts as an orphan ────────────────────────────────

test('listOrphans adopts stale rows and this process\'s own leftovers, never a session in flight here', async () => {
  const me = checkRuns.selfOwner();
  const rows = [
    { run_id: 'stale-other', session_id: 1, owner: 'gone-pod:1', stale: true },
    { run_id: 'fresh-other', session_id: 2, owner: 'live-pod:2', stale: false },
    { run_id: 'fresh-mine', session_id: 3, owner: me, stale: false },
    { run_id: 'stale-inflight', session_id: 4, owner: 'gone-pod:4', stale: true },
    { run_id: 'fresh-mine-inflight', session_id: 5, owner: me, stale: false },
  ];
  let seen;
  const pool = { async query(sql, params) { seen = { sql, params }; return { rows }; } };
  const out = await checkRuns.listOrphans(pool, { staleMs: 60_000, isInFlight: (id) => id === 4 || id === 5 });
  assert.deepEqual(out.map((r) => r.run_id), ['stale-other', 'fresh-mine']);
  assert.equal(seen.params[0], 60_000, 'the orphan window is the query\'s');
  assert.match(seen.sql, /heartbeat_at < NOW\(\)/);
});

test('claim is a compare-and-swap on the owner the row was listed with', async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rowCount: params[2] === 'dead-pod:7' ? 1 : 0 }; } };
  assert.equal(await checkRuns.claim(pool, 'run-1', 'dead-pod:7'), true);
  assert.equal(await checkRuns.claim(pool, 'run-1', 'somebody-else:1'), false);
  assert.match(calls[0].sql, /WHERE run_id = \$1 AND owner = \$3/);
  assert.equal(calls[0].params[1], checkRuns.selfOwner(), 'the winner stamps itself');
});

test('record / heartbeat / finish never throw into the checks pipeline', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  assert.equal(await checkRuns.record(pool, { runId: 'r', sessionId: 1, commitSha: 'a', manifest: {} }), false);
  assert.equal(await checkRuns.heartbeat(pool, 'r'), false);
  assert.equal(await checkRuns.finish(pool, 'r'), false);
  assert.equal(await checkRuns.record(null, { runId: 'r', sessionId: 1 }), false);
  const stop = checkRuns.startHeartbeat(null, 'r');
  assert.equal(typeof stop, 'function');
  stop(); stop();
});

// ── The seat ────────────────────────────────────────────────────────────

test('holdCapture takes the session\'s in-flight seat once, and release is idempotent', () => {
  assert.equal(visuals.hasInFlightCapture(4242), false);
  const release = visuals.holdCapture(4242, 'abc');
  assert.equal(typeof release, 'function');
  assert.equal(visuals.hasInFlightCapture(4242), true, 'every surface reads a harvest as a run');
  assert.equal(visuals.holdCapture(4242, 'abc'), null, 'a second holder is refused');
  release(null);
  assert.equal(visuals.hasInFlightCapture(4242), false);
  release(null);
  assert.equal(visuals.hasInFlightCapture(4242), false);
});

// ── sweep: the settle path ──────────────────────────────────────────────

test('an orphan whose Jobs finished is settled from their output through settleCaptureRun', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow() });
  const collected = [];
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async (_cfg, { sessionId, previewRunId }) => {
      assert.equal(sessionId, 42); assert.equal(previewRunId, 'run-1');
      return { capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: { name: 'sv-unit-suite-s42-x', state: 'succeeded' } };
    },
    collectCheckJob: async (_cfg, { name, kind, onStdoutLine }) => {
      collected.push(kind);
      if (kind === 'capture') {
        onStdoutLine('__USERNODE_TEST__ index=0 status=pass');
        return { state: 'succeeded', stdout: 'SHOT {"path":"/"}\n__USERNODE_TEST__ index=0 status=pass\n', stderr: 'capture warning', exitCode: 0, timedOut: false, partial: false, partialReason: '' };
      }
      assert.equal(name, 'sv-unit-suite-s42-x');
      return { state: 'succeeded', stdout: 'TAP version 13\n# tests 5\n# pass 5\n# fail 0\n', stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '' };
    },
  });
  stub(t, visuals, {
    settleCaptureRun: async (_cfg, _pool, run) => { settledWith = run; return { traceStatus: 'passing', result: { state: 'passing' } }; },
  });

  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  assert.equal(summary.orphans, 1);
  assert.equal(summary.claimed, 1);
  const results = await summary.done;
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'settled');
  assert.equal(results[0].state, 'passing');

  assert.deepEqual(collected.sort(), ['capture', 'unit-suite']);
  assert.equal(pool.claims.length, 1, 'the row was claimed before anything was read');
  assert.deepEqual(pool.claims[0], ['run-1', checkRuns.selfOwner(), 'dead-pod:7']);
  assert.ok(settledWith, 'the run went through the shared settlement');
  assert.equal(settledWith.commitHash, 'abc123');
  assert.equal(settledWith.session.id, 42);
  assert.equal(settledWith.app.id, 9);
  assert.equal(settledWith.trigger, 'promote-kick');
  assert.equal(settledWith.testsCount, 3);
  assert.deepEqual(settledWith.capturePaths, ['/']);
  assert.equal(settledWith.stdout, 'SHOT {"path":"/"}\n__USERNODE_TEST__ index=0 status=pass\n');
  assert.equal(settledWith.stderr, 'capture warning');
  assert.equal(settledWith.runPartial, false);
  assert.equal(settledWith.unitOutcome.row.status, 'pass', 'the unit-suite row comes from the Job\'s own verdict');
  assert.equal(settledWith.unitOutcome.row.summary.tests, 5);
  assert.equal(settledWith.send, null);
  assert.equal(settledWith.operation, null, 'lifecycle off: settled with the plain pool');
  assert.deepEqual(pool.deleted, ['run-1'], 'the manifest is cleared once the verdict is stored');
  assert.equal(visuals.hasInFlightCapture(42), false, 'the seat is handed back');
  assert.equal(harvest.isHarvesting(42), false);
});

test('the claim phase completes before sweep() resolves; the Job read runs detached', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow() });
  let finishCapture;
  const captureDone = new Promise((resolve) => { finishCapture = resolve; });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'running' }, unitSuite: null }),
    collectCheckJob: async () => captureDone,
  });
  stub(t, visuals, { settleCaptureRun: async () => ({ traceStatus: 'failing', result: { state: 'failing' } }) });

  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  assert.equal(summary.claimed, 1);
  assert.equal(pool.claims.length, 1);
  assert.equal(visuals.hasInFlightCapture(42), true, 'the stale sweep would now skip this session');
  assert.equal(harvest.isHarvesting(42), true);
  assert.deepEqual(pool.deleted, [], 'nothing settled yet');

  // A second pass meanwhile finds nothing: the session is in flight here.
  const again = await harvest.sweep(config, { reason: 'tick', pool });
  assert.equal(again.orphans, 0);

  finishCapture({ state: 'succeeded', stdout: 'TEST {"index":0,"status":"fail"}\n', stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '' });
  const results = await summary.done;
  assert.equal(results[0].outcome, 'settled');
  assert.equal(results[0].state, 'failing');
  assert.equal(visuals.hasInFlightCapture(42), false);
  assert.deepEqual(pool.deleted, ['run-1']);
});

test('a still-running Job\'s frames are re-published as progress for the card', async (t) => {
  const seen = quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow() });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'running' }, unitSuite: null }),
    collectCheckJob: async (_cfg, { onStdoutLine }) => {
      // The first frame flushes at once (no gap to respect yet); the second
      // lands inside the minimum gap and rides the same snapshot chain.
      onStdoutLine('__USERNODE_TEST__ index=0 status=pass');
      onStdoutLine('__USERNODE_TEST__ index=1 status=fail');
      await flush();
      return { state: 'succeeded', stdout: '', stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '' };
    },
  });
  stub(t, visuals, { settleCaptureRun: async () => ({ traceStatus: 'passing', result: { state: 'passing' } }) });
  const summary = await harvest.sweep(config, { reason: 'tick', pool });
  await summary.done;
  const progress = seen.filter((e) => e.event === 'checks_ready' && e.checkState === 'pending' && e.progress);
  assert.ok(progress.length >= 1, `expected a progress broadcast, saw ${JSON.stringify(seen.map((e) => e.type || e.event))}`);
  const first = progress[0];
  assert.equal(first.sessionId, 42);
  assert.equal(first.commitSha, 'abc123');
  assert.equal(first.checkPhase, 'testing');
  assert.equal(first.checkTrigger, 'promote-kick', 'the trigger the dead run recorded, so the card keeps its wording');
  assert.equal(first.progress.expected, 3, 'the expected count comes from the manifest');
  assert.equal(first.progress.ran, 1, 'counts pick up from the start of the Job\'s log');
  assert.equal(first.progress.passed, 1);
  const written = pool.calls.filter((c) => /checks_progress/.test(c.sql));
  assert.ok(written.length >= 1, 'progress is also written to the row');
  assert.equal(written[0].params[0], 42);
  assert.equal(written[0].params[2], 'abc123', 'under the same commit guard a live run writes with');
});

// ── sweep: moot, re-drive, busy, unreadable ─────────────────────────────

test('a run whose session was decided meanwhile is moot: manifest cleared, nothing read', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow({ check_state: 'passing' }) });
  stub(t, kubernetes, {
    findCheckJobs: async () => assert.fail('a moot run must not touch the cluster'),
    collectCheckJob: async () => assert.fail('a moot run must not touch the cluster'),
  });
  stub(t, stagingRecovery, { recheckSessionChecks: async () => assert.fail('a moot run is not re-driven') });
  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'moot');
  assert.match(result.why, /passing/);
  assert.deepEqual(pool.deleted, ['run-1']);
  assert.equal(visuals.hasInFlightCapture(42), false);
});

test('a head that moved on makes the run moot rather than a verdict for the wrong commit', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow({ checks_commit_sha: 'newer99' }) });
  stub(t, kubernetes, { findCheckJobs: async () => assert.fail('not read') });
  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'moot');
  assert.match(result.why, /head moved/);
});

test('a process that died before creating its Jobs is re-driven at once, with the seat handed back first', async (t) => {
  quietBroadcast(t);
  const pool = makePool({
    orphans: [orphanRow({ manifest: { launched: false, trigger: 'promote-kick', startedAt: Date.now() - 20_000 } })],
    session: sessionRow(),
  });
  const rechecks = [];
  stub(t, kubernetes, { findCheckJobs: async () => assert.fail('nothing to find for a pre-launch death') });
  stub(t, stagingRecovery, {
    recheckSessionChecks: async ({ session, reason }) => {
      assert.equal(visuals.hasInFlightCapture(42), false, 'captureForSession must not park behind the harvest asking for it');
      rechecks.push({ sessionId: session.id, reason });
    },
  });
  const summary = await harvest.sweep(config, { reason: 'boot', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'redriven');
  assert.deepEqual(rechecks, [{ sessionId: 42, reason: 'orphaned-run' }]);
  assert.deepEqual(pool.deleted, ['run-1'], 'the dead run\'s manifest is gone; the re-drive records its own');
  assert.equal(harvest.isHarvesting(42), false);
});

test('a launched run whose capture Job cannot be found is re-driven, not left pending', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow() });
  const rechecks = [];
  stub(t, kubernetes, { findCheckJobs: async () => ({ capture: null, unitSuite: null }) });
  stub(t, stagingRecovery, { recheckSessionChecks: async ({ reason }) => { rechecks.push(reason); } });
  const summary = await harvest.sweep(config, { reason: 'tick', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'redriven');
  assert.match(result.why, /capture Job not found/);
  assert.deepEqual(rechecks, ['orphaned-run']);
});

test('a shots-only run over a range with no frontend files launches no capture Job, and that is not a re-drive', async (t) => {
  quietBroadcast(t);
  const pool = makePool({
    orphans: [orphanRow({ manifest: { launched: true, trigger: 'promote-kick', shotsOnly: true, media: false, admissionReason: 'conflicts', startedAt: Date.now() - 30_000 } })],
    session: sessionRow(),
  });
  let settled = null;
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: null, unitSuite: null }),
    collectCheckJob: async () => assert.fail('no Job to collect'),
  });
  stub(t, stagingRecovery, { recheckSessionChecks: async () => assert.fail('not a re-drive') });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settled = run; return { traceStatus: 'deferred', result: { state: 'pending', deferred: true } }; } });
  const summary = await harvest.sweep(config, { reason: 'tick', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'settled');
  assert.equal(settled.shotsOnly, true);
  assert.equal(settled.media, false);
  assert.equal(settled.admissionReason, 'conflicts');
  assert.equal(settled.stdout, '');
});

test('a capture Job that vanished mid-read re-drives a still-current session and is moot for a decided one', async (t) => {
  quietBroadcast(t);
  const rechecks = [];
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'running' }, unitSuite: null }),
    collectCheckJob: async () => ({ state: 'gone', stdout: '', stderr: '', exitCode: null, timedOut: false, partial: true, partialReason: 'job gone' }),
  });
  stub(t, stagingRecovery, { recheckSessionChecks: async ({ reason }) => { rechecks.push(reason); } });
  for (const [checkState, expected] of [['pending', 'redriven'], ['failing', 'moot']]) {
    let reads = 0;
    const pool = makePool({
      orphans: [orphanRow()],
      answer: (sql) => {
        if (/FROM chat_sessions cs JOIN apps a/.test(sql)) {
          reads += 1;
          // Current on the first read (admission), possibly decided by the second (after the Job vanished).
          return { rows: [sessionRow({ check_state: reads === 1 ? 'pending' : checkState })], rowCount: 1 };
        }
        return null;
      },
    });
    rechecks.length = 0;
    const summary = await harvest.sweep(config, { reason: 'tick', pool });
    const [result] = await summary.done;
    assert.equal(result.outcome, expected, checkState);
    assert.deepEqual(rechecks, expected === 'redriven' ? ['orphaned-run'] : [], checkState);
    assert.equal(visuals.hasInFlightCapture(42), false);
    assert.deepEqual(pool.deleted, ['run-1'], checkState);
  }
});

test('a live run already on the session wins: the harvester reports busy and leaves the row alone', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow() });
  const release = visuals.holdCapture(42, 'abc123');
  t.after(() => release(null));
  // The listing itself excludes an in-flight session…
  const summary = await harvest.sweep(config, { reason: 'tick', pool });
  assert.equal(summary.orphans, 0);
  // …and adopt() called directly on such a row yields 'busy' with no read.
  stub(t, kubernetes, { findCheckJobs: async () => assert.fail('not read') });
  const result = await harvest.adopt(config, pool, orphanRow(), { reason: 'test' });
  assert.equal(result.outcome, 'busy');
  assert.deepEqual(pool.deleted, [], 'the live run settles (or replaces) its own manifest');
  assert.equal(visuals.hasInFlightCapture(42), true, 'the live run\'s seat is untouched');
});

test('a contested claim (another harvester got there first) is reported and not read', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow(), answer: (sql) => (/UPDATE check_runs SET owner/.test(sql) ? { rows: [], rowCount: 0 } : null) });
  stub(t, kubernetes, { findCheckJobs: async () => assert.fail('not read') });
  const summary = await harvest.sweep(config, { reason: 'tick', pool });
  assert.equal(summary.claimed, 0);
  const [result] = await summary.done;
  assert.equal(result.outcome, 'contested');
  assert.equal(visuals.hasInFlightCapture(42), false);
});

test('a capture Job that failed with nothing to salvage records an error verdict, like a live run that could not judge', async (t) => {
  quietBroadcast(t);
  const pool = makePool({ orphans: [orphanRow()], session: sessionRow() });
  const stores = [];
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'failed' }, unitSuite: null }),
    collectCheckJob: async () => ({ state: 'failed', stdout: '   \n', stderr: 'BackoffLimitExceeded', exitCode: 1, timedOut: false, partial: true, partialReason: 'job BackoffLimitExceeded' }),
  });
  stub(t, visuals, {
    settleCaptureRun: async () => assert.fail('nothing to settle from'),
    storeChecks: async (_pool, sessionId, commitSha, result, detail) => { stores.push({ sessionId, commitSha, result, detail }); return true; },
    storeCaptureOutcome: async () => true,
  });
  const summary = await harvest.sweep(config, { reason: 'tick', pool });
  const [result] = await summary.done;
  assert.equal(result.outcome, 'settled');
  assert.equal(result.state, 'error');
  assert.equal(stores.length, 1);
  assert.equal(stores[0].sessionId, 42);
  assert.equal(stores[0].commitSha, 'abc123');
  assert.equal(stores[0].result.state, 'error');
  assert.match(stores[0].detail, /BackoffLimitExceeded/);
  assert.deepEqual(pool.deleted, ['run-1']);
});

test('a sweep outside the Kubernetes capture runtime is a no-op', async () => {
  const pool = makePool({ orphans: [orphanRow()] });
  const summary = await harvest.sweep({ captureRuntime: 'docker' }, { pool });
  assert.equal(summary.skipped, true);
  assert.equal(pool.calls.length, 0);
  assert.equal(typeof harvest.start({ captureRuntime: 'docker' }), 'function');
});

// ── unit-suite: the Job's verdict without the process that launched it ──

test('outcomeFromLog shapes the unit-suite row from a finished Job\'s output', async () => {
  const pool = { async query(sql) { return /SELECT unit_suite_last_tests/.test(sql) ? { rows: [{ unit_suite_last_tests: 5 }] } : { rows: [], rowCount: 1 }; } };
  const passed = await unitSuite.outcomeFromLog({
    pool, appId: 9, sessionId: 42, succeeded: true,
    stdout: 'TAP version 13\nok 1 - a\n# tests 5\n# pass 5\n# fail 0\n', graduated: true,
  });
  assert.equal(passed.row.status, 'pass');
  assert.equal(passed.row.advisory, false);
  assert.equal(passed.row.name, unitSuite.UNIT_CHECK_NAME);
  assert.equal(passed.row.summary.tests, 5);
  assert.equal(passed.history.passed, true);

  const failed = await unitSuite.outcomeFromLog({
    pool, appId: 9, sessionId: 42, succeeded: false,
    stdout: 'not ok 1 - a\n# tests 5\n# pass 4\n# fail 1\n', stderr: '', graduated: false,
  });
  assert.equal(failed.row.status, 'fail');
  assert.equal(failed.row.advisory, true, 'not yet graduated: advisory');
  assert.ok(failed.row.failureReason, 'a failing Job carries a reason');

  const timedOut = await unitSuite.outcomeFromLog({ pool, appId: 9, sessionId: 42, succeeded: false, stdout: '', timedOut: true, graduated: true });
  assert.equal(timedOut.row.status, 'fail');
  assert.equal(timedOut.row.advisory, false);
  assert.match(timedOut.row.failureReason, /exceeded .* killed|timed out/i, 'the same wording the live runner uses for a killed suite');
});

// ── kubernetes: finding and reading the Jobs ────────────────────────────

test('findCheckJobs matches a run\'s Jobs by the preview-run-id label and tells the two kinds apart', async (t) => {
  let selector;
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async ({ namespace, labelSelector }) => {
      assert.equal(namespace, 'workers');
      selector = labelSelector;
      return { items: [
        { metadata: { name: 'sv-capture-s42-abcdef', uid: 'u1' }, status: { succeeded: 1 } },
        { metadata: { name: 'sv-unit-suite-s42-abcdef', uid: 'u2' }, status: { active: 1 } },
        { metadata: { name: 'sv-capture-s421-other', uid: 'u3' }, status: { succeeded: 1 } },
      ] };
    },
  }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const found = await kubernetes.findCheckJobs(config, { sessionId: 42, previewRunId: 'run-uuid' });
  assert.match(selector, /social\.usernode\.io\/session-id=42/);
  assert.match(selector, /social\.usernode\.io\/preview-run-id=run-uuid/);
  assert.equal(found.capture.name, 'sv-capture-s42-abcdef');
  assert.equal(found.capture.state, 'succeeded');
  assert.equal(found.unitSuite.name, 'sv-unit-suite-s42-abcdef');
  assert.equal(found.unitSuite.state, 'running');
  assert.deepEqual(await kubernetes.findCheckJobs(config, { sessionId: 42, previewRunId: null }), { capture: null, unitSuite: null });
});

test('collectCheckJob reads a finished Job\'s whole log and delivers every line from the start', async (t) => {
  kubernetes._setClientsForTest({ batch: {
    readNamespacedJob: async () => ({ metadata: { name: 'sv-capture-s42-x' }, status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } }),
  }, core: {
    listNamespacedPod: async () => ({ items: [{ metadata: { name: 'pod-1' }, status: { containerStatuses: [{ name: 'capture', state: { terminated: { exitCode: 0 } } }] } }] }),
    readNamespacedPodLog: async ({ name, container }) => { assert.equal(name, 'pod-1'); assert.equal(container, 'capture'); return 'SHOT a\nTEST b\n'; },
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  const lines = [];
  const out = await kubernetes.collectCheckJob(config, { name: 'sv-capture-s42-x', kind: 'capture', onStdoutLine: (l) => lines.push(l) });
  assert.equal(out.state, 'succeeded');
  assert.equal(out.stdout, 'SHOT a\nTEST b\n');
  assert.equal(out.exitCode, 0);
  assert.equal(out.partial, false);
  assert.deepEqual(lines, ['SHOT a', 'TEST b']);
});

test('collectCheckJob waits on a running Job, re-reading the log for progress, and marks a DeadlineExceeded end as timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  let log = 'TEST 1\n';
  kubernetes._setClientsForTest({ batch: {
    readNamespacedJob: async () => {
      polls += 1;
      if (polls < 3) return { metadata: { name: 'j' }, status: { active: 1 } };
      return { metadata: { name: 'j' }, status: { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] } };
    },
  }, core: {
    listNamespacedPod: async () => ({ items: [{ metadata: { name: 'pod-1' }, status: { containerStatuses: [{ name: 'capture', state: { terminated: { exitCode: 137 } } }] } }] }),
    readNamespacedPodLog: async () => log,
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  const lines = [];
  const pending = kubernetes.collectCheckJob(config, { name: 'j', kind: 'capture', onStdoutLine: (l) => lines.push(l) });
  await flush();
  assert.deepEqual(lines, ['TEST 1'], 'the first tick delivers what the Job has printed so far');
  log += 'TEST 2\n';
  t.mock.timers.tick(2000); await flush();
  t.mock.timers.tick(2000); await flush();
  const out = await pending;
  assert.equal(out.state, 'failed');
  assert.equal(out.timedOut, true);
  assert.equal(out.partial, true);
  assert.equal(out.partialReason, 'run timed out');
  assert.equal(out.stdout, 'TEST 1\nTEST 2\n', 'the salvaged frames are the verdict\'s input');
  assert.deepEqual(lines, ['TEST 1', 'TEST 2'], 'each line exactly once across the re-reads');
});

test('collectCheckJob reports a Job that disappeared as gone and a superseded adopter as aborted', async (t) => {
  kubernetes._setClientsForTest({ batch: {
    readNamespacedJob: async () => { throw Object.assign(new Error('not found'), { code: 404 }); },
  }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const gone = await kubernetes.collectCheckJob(config, { name: 'j', kind: 'capture' });
  assert.equal(gone.state, 'gone');
  assert.equal(gone.partialReason, 'job gone');
  const controller = new AbortController();
  controller.abort(new Error('superseded'));
  const aborted = await kubernetes.collectCheckJob(config, { name: 'j', kind: 'capture', signal: controller.signal });
  assert.equal(aborted.state, 'aborted');
});

// ── Wiring ──────────────────────────────────────────────────────────────

test('the leader boot sequence seats orphans before the stale sweep looks, and the stale sweep skips a harvest', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const boot = server.indexOf("checkHarvest.sweep(config, { reason: 'boot' })");
  assert.ok(boot > 0, 'the boot harvest sweep is wired');
  const stuck = server.indexOf('.then(() => reconcileStuckChecks(config))', boot);
  assert.ok(stuck > boot && stuck - boot < 1500, 'reconcileStuckChecks is chained after the harvest\'s claim phase');
  assert.match(server, /checkHarvest\.start\(config\);/, 'the leader runs the harvest ticker');
  assert.match(server, /function checkRecoveryInFlight\(sessionId\) \{[\s\S]{0,700}check-harvest'\)\.isHarvesting\(sessionId\)/,
    'a session being harvested is never re-driven by the stale sweep');
});

test('captureForSession records a manifest before its Jobs exist and clears it on every exit path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const provisional = src.indexOf('manifest: { launched: false');
  const full = src.indexOf('launched: true');
  const launch = src.indexOf('kubernetes.runCaptureJob(');
  assert.ok(provisional > 0 && full > provisional && launch > full,
    'provisional manifest, then the full one, then the Job launch — in that order');
  assert.match(src, /finally \{[\s\S]{0,1200}if \(harvestable\) await checkRuns\.finish\(operation\?\.cleanupPool \|\| pool, runId\);/,
    'the manifest is cleared in the run\'s finally');
  assert.match(src, /previewRunId: runId/, 'the Jobs carry the manifest\'s run id, which is how the harvester finds them');
});

test('the schema carries the check_runs manifest table', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS check_runs \(\s*run_id\s+UUID PRIMARY KEY/);
  assert.match(schema, /session_id\s+INTEGER NOT NULL REFERENCES chat_sessions\(id\) ON DELETE CASCADE/);
  assert.match(schema, /heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_check_runs_session ON check_runs \(session_id\)/);
});

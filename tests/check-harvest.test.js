'use strict';

// Reading a checks run's Jobs after the process that launched them is gone
// (services/check-harvest.js, services/check-runs.js, the Kubernetes Job
// readers, and unit-suite.collectUnitSuite).
//
// A platform rollout replaces the Pod that was streaming a proposal's
// capture / unit-suite Jobs; the Jobs finish on the cluster anyway. The
// preview machine's checks run is a work item, and the retry of one whose
// claim was lost collects them (collectForWorkflow). These tests pin that
// the verdict they produce is READ — through the same settlement a live run
// ends with — rather than the suite being started over, that a run with
// nothing to read returns null so the retry runs it again, and that a
// capture Job that says nothing about the proposal is the platform's fault.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harvest = require('../src/services/check-harvest');
const checkRuns = require('../src/services/check-runs');
const checkHistory = require('../src/services/check-history');
const visuals = require('../src/services/visuals');
const kubernetes = require('../src/services/kubernetes');
const unitSuite = require('../src/services/unit-suite');
const stagingRecovery = require('../src/services/staging-recovery');
const appManifest = require('../src/services/app-manifest');

const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers', appNamespace: 'apps' } };
const flush = () => new Promise(setImmediate);

// A pool that answers the handful of queries a collect makes. `runs` are the
// check_runs rows a run's key names (the newest launched claim first);
// everything else is an empty result unless `answer` says otherwise.
function makePool({ runs = [], answer = null } = {}) {
  const pool = {
    calls: [], deleted: [],
    async query(sql, params) {
      pool.calls.push({ sql, params });
      if (answer) { const r = answer(sql, params); if (r) return r; }
      if (/SELECT run_id, session_id, commit_sha, manifest, started_at FROM check_runs/.test(sql)) {
        return { rows: runs.map((r) => ({ ...r })), rowCount: runs.length };
      }
      if (/DELETE FROM check_runs/.test(sql)) { pool.deleted.push(params[0]); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

// A claim of the machine's run 'run:7' that launched its Jobs.
function runRow(over = {}) {
  const { manifest = {}, ...rest } = over;
  return {
    run_id: 'run-1', session_id: 42, commit_sha: 'abc123',
    started_at: new Date(Date.now() - 90_000).toISOString(),
    manifest: {
      workflow: true, runKey: 'run:7', launched: true, trigger: 'promote-kick', startedAt: Date.now() - 90_000,
      media: true, capturePaths: ['/'], targets: [{ kind: 'after' }], testsCount: 3, dispatched: ['/'],
      ...manifest,
    },
    ...rest,
  };
}

const SESSION = { id: 42, app_id: 9, status: 'promoted', check_state: 'pending', checks_commit_sha: 'abc123' };
const APP = { id: 9, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/o/r' };

function collect(pool, { signal } = {}) {
  return harvest.collectForWorkflow(config, pool, { runKey: 'run:7', session: SESSION, app: APP, signal });
}

// Swap a module's exports for the test and restore them afterwards.
function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

// A settled collect deletes the run's Jobs (kubernetes.deleteSettledCheckJobs).
// Recorded for every test, so none reaches for a cluster.
const realDeleteSettledCheckJobs = kubernetes.deleteSettledCheckJobs;
let releasedJobs = [];
test.beforeEach(() => {
  releasedJobs = [];
  kubernetes.deleteSettledCheckJobs = async (_cfg, run) => { releasedJobs.push(run); return 2; };
});
test.afterEach(() => { kubernetes.deleteSettledCheckJobs = realDeleteSettledCheckJobs; });

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

// ── collectForWorkflow: the settle path ─────────────────────────────────

test('a run whose Jobs finished is settled from their output through settleCaptureRun', async (t) => {
  const pool = makePool({ runs: [runRow()] });
  const collected = [];
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async (_cfg, { sessionId, previewRunId }) => {
      assert.equal(sessionId, 42); assert.equal(previewRunId, 'run-1');
      return { capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: { name: 'sv-unit-suite-s42-x', state: 'succeeded' } };
    },
    collectCheckJob: async (_cfg, { name, kind }) => {
      collected.push(kind);
      if (kind === 'capture') {
        return { state: 'succeeded', stdout: 'SHOT {"path":"/"}\n__USERNODE_TEST__ index=0 status=pass\n', stderr: 'capture warning', exitCode: 0, timedOut: false, partial: false, partialReason: '' };
      }
      assert.equal(name, 'sv-unit-suite-s42-x');
      return { state: 'succeeded', stdout: 'TAP version 13\n# tests 5\n# pass 5\n# fail 0\n', stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '' };
    },
  });
  stub(t, visuals, {
    settleCaptureRun: async (_cfg, _pool, run) => { settledWith = run; return { traceStatus: 'passing', result: { outcome: 'verdict', state: 'passing' } }; },
  });

  const out = await collect(pool);
  assert.deepEqual(out, { outcome: 'verdict', state: 'passing' }, 'the settlement is returned for the machine to store');
  assert.deepEqual(collected.sort(), ['capture', 'unit-suite']);
  assert.ok(settledWith, 'the run went through the shared settlement');
  assert.equal(settledWith.commitHash, 'abc123');
  assert.equal(settledWith.session.id, 42);
  assert.equal(settledWith.app.id, 9);
  assert.equal(settledWith.testsCount, 3);
  assert.deepEqual(settledWith.capturePaths, ['/']);
  assert.equal(settledWith.legacyMediaSuppressed, false,
    'a manifest that does not say so reads as not superseded by before & after shots');
  assert.equal(settledWith.stdout, 'SHOT {"path":"/"}\n__USERNODE_TEST__ index=0 status=pass\n');
  assert.equal(settledWith.stderr, 'capture warning');
  assert.equal(settledWith.runPartial, false);
  assert.equal(settledWith.unitOutcome.row.status, 'pass', 'the unit-suite row comes from the Job\'s own verdict');
  assert.equal(settledWith.unitOutcome.row.summary.tests, 5);
  assert.deepEqual(settledWith.collect, { runId: 'run:7' }, 'its media are held under the run\'s key, as a live run\'s are');
  assert.equal('overlappedRollout' in settledWith, false,
    'a collected run is judged on its own results like a live one (tests/checks-rollout-overlap.test.js)');
  assert.deepEqual(pool.deleted, ['run-1'], 'the manifest is cleared once it is read out');
  assert.deepEqual(releasedJobs, [{ sessionId: 42, previewRunId: 'run-1' }],
    'read out and settled, so the Jobs go now rather than holding Job slots until their TTL');
});

test('the unit Jobs are the early suite\'s when the manifest names one and the claim launched none of its own', async (t) => {
  const pool = makePool({ runs: [runRow({ manifest: { unitRunId: 'early-1' } })] });
  const asked = [];
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async (_cfg, { previewRunId }) => {
      asked.push(previewRunId);
      return previewRunId === 'early-1'
        ? { capture: null, unitSuite: { name: 'sv-unit-early-s42-early-1', state: 'succeeded' } }
        : { capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: null };
    },
    collectCheckJob: async (_cfg, { name, kind }) => (kind === 'capture' ? capturePassed : (assert.equal(name, 'sv-unit-early-s42-early-1'),
      { state: 'succeeded', stdout: 'TAP version 13\n# tests 2\n# pass 2\n# fail 0\n', stderr: '', exitCode: 0, timedOut: false })),
  });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { traceStatus: 'passing', result: { state: 'passing' } }; } });
  await collect(pool);
  assert.deepEqual(asked, ['run-1', 'early-1']);
  assert.equal(settledWith.unitOutcome.row.status, 'pass', 'the early suite\'s verdict');
  assert.equal(settledWith.unitOutcome.row.summary.tests, 2);
  assert.deepEqual(releasedJobs, [{ sessionId: 42, previewRunId: 'run-1' }, { sessionId: 42, previewRunId: 'early-1' }],
    'both runs\' Jobs go once read out');
});

test('a run that found the early suite unreadable and launched its own is read from its own Jobs', async (t) => {
  const pool = makePool({ runs: [runRow({ manifest: { unitRunId: 'early-1' } })] });
  const asked = [];
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async (_cfg, { previewRunId }) => {
      asked.push(previewRunId);
      return { capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: { name: 'sv-unit-suite-s42-own', state: 'succeeded' } };
    },
    collectCheckJob: async (_cfg, { name, kind }) => (kind === 'capture' ? capturePassed : (assert.equal(name, 'sv-unit-suite-s42-own'),
      { state: 'succeeded', stdout: 'TAP version 13\n# tests 3\n# pass 3\n# fail 0\n', stderr: '', exitCode: 0, timedOut: false })),
  });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { traceStatus: 'passing', result: { state: 'passing' } }; } });
  await collect(pool);
  assert.deepEqual(asked, ['run-1'], 'the early suite is not asked about');
  assert.equal(settledWith.unitOutcome.row.summary.tests, 3, 'the suite the run launched itself');
});

test('a shots-only run over a range with no frontend files launches no capture Job, and settles all the same', async (t) => {
  const pool = makePool({
    runs: [runRow({ manifest: { shotsOnly: true, media: false, legacyMediaSuppressed: true, admissionReason: 'conflicts', startedAt: Date.now() - 30_000 } })],
  });
  let settled = null;
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: null, unitSuite: null }),
    collectCheckJob: async () => assert.fail('no Job to collect'),
  });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settled = run; return { traceStatus: 'deferred', result: { outcome: 'deferred' } }; } });
  const out = await collect(pool);
  assert.deepEqual(out, { outcome: 'deferred' });
  assert.equal(settled.shotsOnly, true);
  assert.equal(settled.media, false);
  assert.equal(settled.legacyMediaSuppressed, true, 'its outcome says before & after shots replaced its screenshots');
  assert.equal(settled.admissionReason, 'conflicts');
  assert.equal(settled.stdout, '');
});

// ── collectForWorkflow: nothing to read, so the retry runs it again ─────

test('a run with nothing to read is null: no launched claim, a manifest not the machine\'s, a capture Job missing', async (t) => {
  let jobs = { capture: null, unitSuite: null };
  stub(t, kubernetes, {
    findCheckJobs: async () => jobs,
    collectCheckJob: async () => assert.fail('nothing is read'),
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('nothing settles') });
  // No claim of the run launched its Jobs (the process died before them).
  assert.equal(await collect(makePool({ runs: [] })), null);
  // A row that is not a machine run's.
  assert.equal(await collect(makePool({ runs: [runRow({ manifest: { workflow: false } })] })), null);
  // A launched run whose capture Job cannot be found, or one of whose shards is.
  assert.equal(await collect(makePool({ runs: [runRow()] })), null);
  jobs = { captures: [{ name: 'sv-capture-s42-x', state: 'succeeded' }], unitSuite: null };
  const pool = makePool({ runs: [runRow({ manifest: { captureShards: 2 } })] });
  assert.equal(await collect(pool), null);
  assert.deepEqual(pool.deleted, [], 'the retry clears what its earlier claims left');
  assert.deepEqual(releasedJobs, []);
});

test('a capture Job that vanished or was stopped mid-read is null, and nothing is cleared', async (t) => {
  let state = 'gone';
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'running' }, unitSuite: null }),
    collectCheckJob: async () => ({ state, stdout: '', stderr: '', exitCode: null, timedOut: false, partial: true, partialReason: 'job gone' }),
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('nothing settles') });
  for (state of ['gone', 'aborted']) {
    const pool = makePool({ runs: [runRow()] });
    assert.equal(await collect(pool), null, state);
    assert.deepEqual(pool.deleted, [], state);
    assert.deepEqual(releasedJobs, [], `${state}: only a settled run deletes its Jobs`);
  }
});

test('a run the machine cancels while its Jobs are read throws the cancel', async (t) => {
  const controller = new AbortController();
  const cancelled = new Error('cancelled');
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'running' }, unitSuite: null }),
    collectCheckJob: async () => { controller.abort(cancelled); return capturePassed; },
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('nothing settles') });
  const pool = makePool({ runs: [runRow()] });
  await assert.rejects(collect(pool, { signal: controller.signal }), (err) => err === cancelled);
  assert.deepEqual(pool.deleted, []);
});

test('a collect outside the Kubernetes capture runtime is a no-op', async () => {
  const pool = makePool({ runs: [runRow()] });
  assert.equal(await harvest.collectForWorkflow({ captureRuntime: 'docker' }, pool, { runKey: 'run:7', session: SESSION, app: APP }), null);
  assert.equal(pool.calls.length, 0);
});

// ── collectForWorkflow: a Job that says nothing about the proposal ──────

test('a capture Job that failed with nothing to salvage is blocked as the platform\'s fault, like a live run that could not judge', async (t) => {
  const pool = makePool({ runs: [runRow()] });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'failed' }, unitSuite: null }),
    collectCheckJob: async () => ({ state: 'failed', stdout: '   \n', stderr: 'BackoffLimitExceeded', exitCode: 1, timedOut: false, partial: true, partialReason: 'job BackoffLimitExceeded' }),
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('nothing to settle from') });
  const out = await collect(pool);
  assert.deepEqual(out, { outcome: 'blocked', reason: 'capture Job failed (BackoffLimitExceeded)', platformFault: true });
  assert.deepEqual(pool.deleted, ['run-1']);
  assert.deepEqual(releasedJobs, [{ sessionId: 42, previewRunId: 'run-1' }], 'it is read out too');
  // A Job that wrote nothing, its process dead under it, says nothing about
  // the proposal: the platform's fault, so the error lane keeps retrying it
  // past the six retries a proposal's own errors get.
  const streak = { consecutive_check_failures: 7, check_error_platform: true, first_check_failure_at: new Date().toISOString() };
  assert.equal(stagingRecovery.errorWithinAutoRetries(streak), true);
  assert.equal(stagingRecovery.errorWithinAutoRetries({ ...streak, check_error_platform: false }), false);
});

test('a capture Job still running past its deadline is the platform\'s fault too', async (t) => {
  const pool = makePool({ runs: [runRow()] });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'running' }, unitSuite: null }),
    collectCheckJob: async () => ({ state: 'timeout', stdout: 'SHOT {"path":"/"}\n', stderr: '', exitCode: null, timedOut: true, partial: true, partialReason: 'deadline' }),
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('nothing to settle from') });
  const out = await collect(pool);
  assert.equal(out.outcome, 'blocked');
  assert.equal(out.platformFault, true);
  assert.match(out.reason, /past its deadline/);
});

// ── collectForWorkflow: a unit suite that blocks merges ─────────────────
//
// 13 Oct 2026: a release deleted #4996's finished red suite and stopped
// #4973's, their runs were collected without a unit suite, settled green and
// merged, and main went red twice. A suite that blocks merges is never
// passed over: read in full, red in a shard it has, or a fresh run.

function graduatedUnit(sql) {
  if (/SELECT check_key FROM app_check_history/.test(sql)) {
    return { rows: [{ check_key: appManifest.checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH) }], rowCount: 1 };
  }
  return null;
}
const capturePassed = { state: 'succeeded', stdout: 'SHOT {"path":"/"}\n__USERNODE_TEST__ index=0 status=pass\n', stderr: '', exitCode: 0, timedOut: false, partial: false, partialReason: '' };

// The graduation lookup decides whether the unit suite blocks merges. When
// it failed, the harvest read "not graduated" and settled: a missing suite
// was passed over and a red one read as advisory. The work item is retried
// instead, and reads the Jobs again.
test('a graduation lookup that fails throws for the retry: nothing settled, nothing cleared', async (t) => {
  const pool = makePool({
    runs: [runRow()],
    answer: (sql) => {
      if (/SELECT check_key FROM app_check_history/.test(sql)) throw new Error('connection reset');
      return null;
    },
  });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: null }),
    collectCheckJob: async () => capturePassed,
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('not settled as if the suite were advisory') });
  await assert.rejects(collect(pool), /connection reset/);
  assert.deepEqual(pool.deleted, [], 'the manifest stays, for the retry');
  assert.deepEqual(releasedJobs, [], 'and so do its Jobs');
});

test('a blocking unit suite whose Jobs are gone is null, never settled without its row', async (t) => {
  const pool = makePool({ runs: [runRow({ manifest: { unitRunId: 'early-1' } })], answer: graduatedUnit });
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: null }),
    collectCheckJob: async () => capturePassed,
  });
  stub(t, visuals, { settleCaptureRun: async () => assert.fail('no verdict without the suite') });
  assert.equal(await collect(pool), null);
  assert.deepEqual(pool.deleted, []);
});

test('a run that reused an earlier unit-suite pass settles with that row after a restart, with no unit Job to find', async (t) => {
  quietBroadcast(t);
  const reusedRow = {
    index: unitSuite.UNIT_CHECK_INDEX, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH,
    status: 'pass', advisory: false, consoleErrors: [], failureReason: '', summary: { tests: 5, pass: 5 },
    reused: { runId: 'run-0', sessionId: 42, passedAt: '2026-10-14T10:00:00.000Z' },
  };
  const manifest = { ...orphanRow().manifest, unitReused: { row: reusedRow, earned: 'unit-key', snapshot: { phase: 'done', done: true, reused: reusedRow.reused } } };
  const pool = makePool({ orphans: [orphanRow({ manifest })], session: sessionRow(), answer: graduatedUnit });
  const collected = [];
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: null }),
    collectCheckJob: async (_c, { kind }) => { collected.push(kind); return capturePassed; },
  });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { traceStatus: 'passing', result: { state: 'passing' } }; }, scheduleShots: () => {} });
  const [result] = await (await harvest.sweep(config, { reason: 'boot', pool })).done;
  assert.equal(result.outcome, 'settled', 'a merge-blocking suite it copied is not a missing one');
  assert.deepEqual(collected, ['capture'], 'no unit-suite Job is looked for');
  assert.deepEqual(settledWith.unitOutcome, { row: reusedRow, history: null, earned: 'unit-key' },
    'the same row, no history, and the gate it earns the proposal');
});

test('an advisory unit suite whose Jobs are gone settles without its row, as before', async (t) => {
  const pool = makePool({ runs: [runRow()] });
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: null }),
    collectCheckJob: async () => capturePassed,
  });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { traceStatus: 'passing', result: { state: 'passing' } }; } });
  assert.deepEqual(await collect(pool), { state: 'passing' });
  assert.equal(settledWith.unitOutcome, null, 'its row would block nothing');
});

test('a red shard settles the suite red though another shard is gone, and a Job past its deadline is a red row', async (t) => {
  const red = 'TAP version 13\nnot ok 1 - the plan\n  ---\n  error: boom\n  ...\n# tests 4\n# pass 3\n# fail 1\n';
  const cases = [
    { why: 'a red shard', unitShards: 3,
      jobs: [{ name: 'sv-unit-early-s42-early-1', state: 'failed' }, { name: 'sv-unit-early-s42-early-1-u2', state: 'running' }],
      outputs: { 'sv-unit-early-s42-early-1': { state: 'failed', stdout: red, stderr: '', exitCode: 1, timedOut: false },
        'sv-unit-early-s42-early-1-u2': { state: 'gone', stdout: '', stderr: '', exitCode: null, timedOut: false } } },
    { why: 'past its deadline', unitShards: 1,
      jobs: [{ name: 'sv-unit-early-s42-early-1', state: 'running' }],
      outputs: { 'sv-unit-early-s42-early-1': { state: 'timeout', stdout: `${unitSuite.SETUP_DONE_SENTINEL}\nok 1 - a\n`, stderr: 'DeadlineExceeded', exitCode: null, timedOut: true } } },
  ];
  let current = null;
  let settledWith = null;
  stub(t, kubernetes, {
    findCheckJobs: async (_c, { previewRunId }) => (previewRunId === 'early-1'
      ? { unitSuite: current.jobs[0], unitSuites: current.jobs, unitShards: current.unitShards }
      : { capture: { name: 'sv-capture-s42-x', state: 'succeeded' }, unitSuite: null }),
    collectCheckJob: async (_c, { name, kind }) => (kind === 'capture' ? capturePassed : current.outputs[name]),
  });
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { traceStatus: 'failing', result: { state: 'failing' } }; } });
  for (const c of cases) {
    current = c;
    settledWith = null;
    const pool = makePool({ runs: [runRow({ manifest: { unitRunId: 'early-1' } })], answer: graduatedUnit });
    assert.deepEqual(await collect(pool), { state: 'failing' }, c.why);
    assert.equal(settledWith.unitOutcome.row.status, 'fail', c.why);
  }
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

  // Killed at its deadline before printing a line: the pod never got to
  // the suite (a full cluster keeps it pending), so it never ran.
  const timedOut = await unitSuite.outcomeFromLog({ pool, appId: 9, sessionId: 42, succeeded: false, stdout: '', stderr: 'DeadlineExceeded', timedOut: true, graduated: true });
  assert.equal(timedOut.row.status, 'fail');
  assert.equal(timedOut.row.advisory, false);
  assert.equal(timedOut.row.couldNotRun, true);
  assert.equal(timedOut.row.failureReason,
    'The unit suite stopped before any test ran: its job ran out of time without printing anything. | DeadlineExceeded');
  assert.equal(timedOut.history, null, 'it observed nothing, so it records nothing');

  // Killed at its deadline while the tests ran: still the suite's verdict,
  // worded as the live runner words a killed suite.
  const slow = await unitSuite.outcomeFromLog({
    pool, appId: 9, sessionId: 42, succeeded: false, timedOut: true, graduated: true,
    stdout: `${unitSuite.SETUP_DONE_SENTINEL}\nok 1 - a\n`, stderr: 'DeadlineExceeded',
  });
  assert.equal(slow.row.couldNotRun, undefined);
  assert.match(slow.row.failureReason, /^Suite run exceeded \d+s and was killed\./);
  assert.equal(slow.history.passed, false);
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

test('collectCheckJob retains polled output when the successful terminal read is empty', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  let logReads = 0;
  kubernetes._setClientsForTest({ batch: {
    readNamespacedJob: async () => (++polls < 2
      ? { metadata: { name: 'j' }, status: { active: 1 } }
      : { metadata: { name: 'j' }, status: { succeeded: 1 } }),
  }, core: {
    listNamespacedPod: async () => ({ items: [{ metadata: { name: 'pod-1' }, status: {
      containerStatuses: [{ name: 'capture', state: { terminated: { exitCode: 0, reason: 'Completed' } } }],
    } }] }),
    readNamespacedPodLog: async () => logReads++ === 0 ? 'TEST 1\nTEST 2\n' : '',
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  const pending = kubernetes.collectCheckJob(config, { name: 'j', kind: 'capture' });
  await flush();
  t.mock.timers.tick(2000); await flush();
  const out = await pending;
  assert.equal(out.state, 'succeeded');
  assert.equal(out.stdout, 'TEST 1\nTEST 2\n');
  assert.equal(out.partial, false);
});

for (const scenario of [
  {
    name: 'shorter terminal snapshot',
    progress: 'TEST 1\nTEST 2\n',
    terminal: 'TEST 1\n',
    expected: 'TEST 1\nTEST 2\n',
    lines: ['TEST 1', 'TEST 2'],
  },
  {
    name: 'terminal snapshot with an unseen suffix',
    progress: 'TEST 1\n',
    terminal: 'TEST 1\nTEST 2\npartial',
    expected: 'TEST 1\nTEST 2\npartial',
    lines: ['TEST 1', 'TEST 2'],
  },
]) {
  test(`collectCheckJob reconciles a ${scenario.name} without duplicate progress`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let polls = 0;
    let logReads = 0;
    kubernetes._setClientsForTest({ batch: {
      readNamespacedJob: async () => (++polls < 2
        ? { metadata: { name: 'j' }, status: { active: 1 } }
        : { metadata: { name: 'j' }, status: { succeeded: 1 } }),
    }, core: {
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'pod-1' }, status: {
        containerStatuses: [{ name: 'capture', state: { terminated: { exitCode: 0 } } }],
      } }] }),
      readNamespacedPodLog: async () => logReads++ === 0 ? scenario.progress : scenario.terminal,
    } });
    t.after(() => kubernetes._setClientsForTest(null));
    const lines = [];
    const pending = kubernetes.collectCheckJob(config, {
      name: 'j', kind: 'capture', onStdoutLine: line => lines.push(line),
    });
    await flush();
    t.mock.timers.tick(2000); await flush();
    const out = await pending;
    assert.equal(out.stdout, scenario.expected);
    assert.deepEqual(lines, scenario.lines);
  });
}

test('collectCheckJob keeps a complete UTF-8 line when retained output reaches maxBuffer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  let logReads = 0;
  const first = 'TEST 🚀\n';
  kubernetes._setClientsForTest({ batch: {
    readNamespacedJob: async () => (++polls < 2
      ? { metadata: { name: 'j' }, status: { active: 1 } }
      : { metadata: { name: 'j' }, status: { succeeded: 1 } }),
  }, core: {
    listNamespacedPod: async () => ({ items: [{ metadata: { name: 'pod-1' }, status: {
      containerStatuses: [{ name: 'capture', state: { terminated: { exitCode: 0 } } }],
    } }] }),
    readNamespacedPodLog: async () => logReads++ === 0 ? `${first}SECOND\n` : '',
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  const pending = kubernetes.collectCheckJob(config, {
    name: 'j', kind: 'capture', maxBuffer: Buffer.byteLength(first),
  });
  await flush();
  t.mock.timers.tick(2000); await flush();
  const out = await pending;
  assert.equal(out.stdout, first);
  assert.equal(out.partial, true);
  assert.equal(out.partialReason, 'output over maxBuffer');
  assert.equal(out.stdout.includes('\uFFFD'), false);
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

// ── unit-suite: an early suite read by the checks run that follows ──────
//
// The preview machine starts the repo's unit suite with the build of an
// attempt (checks.unitEarly); the checks run against that attempt reads its
// Jobs to the end (collectUnitSuite) rather than starting its own.

const workerConfig = { workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };
const readEarly = (pool, extra = {}) => unitSuite.collectUnitSuite({
  config: workerConfig, pool, appId: 9, sessionId: 42, previewRunId: 'early-1', ...extra,
});

test('collectUnitSuite is null when there is nothing to read: no Jobs, a shard missing, no run id, no cluster', async (t) => {
  let jobs = { capture: null, unitSuite: null };
  stub(t, kubernetes, {
    findCheckJobs: async (_cfg, { sessionId, previewRunId }) => {
      assert.equal(sessionId, 42); assert.equal(previewRunId, 'early-1');
      return jobs;
    },
    collectCheckJob: async () => assert.fail('nothing is read'),
  });
  const pool = makePool();
  assert.equal(await readEarly(pool), null, 'no Jobs under that id');
  jobs = { unitSuite: { name: 'sv-unit-early-s42-early-1', state: 'running' },
    unitSuites: [{ name: 'sv-unit-early-s42-early-1', state: 'running' }], unitShards: 2 };
  assert.equal(await readEarly(pool), null, 'one shard of two: part of a suite is not the suite');
  assert.equal(await readEarly(pool, { previewRunId: null }), null);
  assert.equal(await readEarly(pool, { config: { workerRuntime: 'docker' } }), null);
});

test('collectUnitSuite reads a finished suite\'s Jobs to an outcome, reporting progress as it goes', async (t) => {
  const lines = ['TAP version 13', 'ok 1 - a', 'ok 2 - b', 'not ok 3 - c', '# tests 3', '# pass 2', '# fail 1'];
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ unitSuite: { name: 'sv-unit-early-s42-early-1', state: 'failed' },
      unitSuites: [{ name: 'sv-unit-early-s42-early-1', state: 'failed' }], unitShards: 1 }),
    collectCheckJob: async (_cfg, { name, kind, onStdoutLine }) => {
      assert.equal(name, 'sv-unit-early-s42-early-1');
      assert.equal(kind, 'unit-suite');
      for (const line of lines) onStdoutLine(line);
      return { state: 'failed', stdout: `${unitSuite.SETUP_DONE_SENTINEL}\n${lines.join('\n')}\n`, stderr: '', exitCode: 1, timedOut: false };
    },
  });
  let strict = null;
  stub(t, checkHistory, {
    loadGraduated: async (_pool, appId, o) => {
      assert.equal(appId, 9);
      strict = o.strict;
      return new Set([appManifest.checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH)]);
    },
  });
  const progress = [];
  const outcome = await readEarly(makePool(), { onProgress: (snap) => progress.push(snap) });
  assert.equal(outcome.row.status, 'fail');
  assert.equal(outcome.row.advisory, false, 'graduated: it blocks merges');
  assert.equal(outcome.row.summary.fail, 1);
  assert.equal(outcome.history.passed, false);
  assert.equal(strict, true, 'whether it blocks is read strictly, never guessed as advisory');
  assert.ok(progress.length >= 2, 'a snapshot as tests report, and the last one');
  assert.equal(progress[progress.length - 1].done, true);
});

// ── A rollout's runs: handed over ───────────────────────────────────────
//
// 7 Oct 2026, 21:59 UTC. A new leader booted moments after the old Pod
// exited, and the old Pod's rows still carried its heartbeat. A process
// shutting down marks its rows stale at once, so whatever reads them next
// does not take them for a live run's.

test('release hands this process\'s rows over: stale at once, and its own heartbeat no longer matches them', async () => {
  const me = checkRuns.selfOwner();
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: [], rowCount: 2 }; } };
  assert.equal(await checkRuns.release(pool), 2);
  assert.match(calls[0].sql, /UPDATE check_runs SET owner = \$2, heartbeat_at = 'epoch'\s+WHERE owner = \$1/);
  assert.deepEqual(calls[0].params, [me, `${me}:exited`],
    'only this process\'s rows, renamed so the heartbeat it still sends matches none of them');
  assert.equal(await checkRuns.release({ async query() { throw new Error('db down'); } }), 0,
    'never throws into a shutdown');
  assert.equal(await checkRuns.release(null), 0);
});

// check_runs rows for stopSupersededRuns.
function runsPool(rows) {
  const pool = {
    calls: [],
    async query(sql, params) { pool.calls.push({ sql, params }); return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length }; },
  };
  return pool;
}

test('findCheckJobs says when a finished Job ended, so a run nobody read can be told from one just done', async (t) => {
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async () => ({ items: [
      { metadata: { name: 'sv-capture-s42-r' }, status: { succeeded: 1, completionTime: '2026-10-07T21:58:47Z' } },
      { metadata: { name: 'sv-unit-suite-s42-r' }, status: { failed: 1, conditions: [
        { type: 'Failed', status: 'True', reason: 'DeadlineExceeded', lastTransitionTime: '2026-10-07T21:58:50Z' },
      ] } },
    ] }),
  }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const found = await kubernetes.findCheckJobs(config, { sessionId: 42, previewRunId: 'r' });
  assert.equal(found.capture.finishedAt, '2026-10-07T21:58:47Z');
  assert.equal(found.unitSuite.finishedAt, '2026-10-07T21:58:50Z');
});

// ── Superseded runs stop holding the cluster ────────────────────────────

test('stopSupersededRuns stops the runs for another commit and the abandoned ones, never this run\'s commit', async (t) => {
  const onCluster = ['new-run', 'same-commit', 'old-commit', 'no-manifest'];
  let spared = null;
  stub(t, kubernetes, {
    stopCheckJobs: async (_cfg, { sessionId, spare }) => {
      assert.equal(sessionId, 42);
      spared = onCluster.filter((id) => spare(id));
      return onCluster.filter((id) => !spare(id)).map((id) => `sv-capture-s42-${id}`);
    },
  });
  const pool = runsPool([
    { run_id: 'new-run', commit_sha: 'def456' },
    { run_id: 'same-commit', commit_sha: 'def456' },
    { run_id: 'old-commit', commit_sha: 'abc123' },
  ]);
  const stopped = await harvest.stopSupersededRuns(config, pool, { sessionId: 42, runId: 'new-run', commitSha: 'def456' });
  assert.deepEqual(stopped, ['sv-capture-s42-old-commit', 'sv-capture-s42-no-manifest']);
  assert.deepEqual(spared, ['new-run', 'same-commit'],
    'a run for the same commit is still one the row takes a verdict from, whoever reads it');
  assert.deepEqual(pool.calls[0].params, [42]);
});

test('stopSupersededRuns never throws into the run that called it, and is a no-op off Kubernetes', async (t) => {
  stub(t, kubernetes, { stopCheckJobs: async () => { throw new Error('forbidden'); } });
  assert.deepEqual(await harvest.stopSupersededRuns(config, runsPool([]), { sessionId: 42, runId: 'r', commitSha: 'a' }), []);
  const pool = runsPool([]);
  assert.deepEqual(await harvest.stopSupersededRuns({ captureRuntime: 'docker' }, pool, { sessionId: 42, runId: 'r', commitSha: 'a' }), []);
  assert.equal(pool.calls.length, 0);
});

test('stopCheckJobs deletes only running Jobs of runs it may stop, in the background, without waiting', async (t) => {
  const job = (name, runId, status, meta = {}) => ({
    metadata: { name, uid: `uid-${name}`, labels: { 'social.usernode.io/preview-run-id': runId }, ...meta }, status,
  });
  let selector = null;
  const deleted = [];
  kubernetes._setClientsForTest({ batch: {
    listNamespacedJob: async ({ namespace, labelSelector }) => {
      assert.equal(namespace, 'workers');
      selector = labelSelector;
      return { items: [
        job('sv-capture-s42-old', 'old', { active: 1 }),
        job('sv-unit-suite-s42-old', 'old', { active: 1 }),
        job('sv-capture-s42-new', 'new', { active: 1 }),
        job('sv-capture-s42-done', 'done', { succeeded: 1 }),
        job('sv-capture-s42-going', 'going', { active: 1 }, { deletionTimestamp: '2026-10-07T21:59:30Z' }),
        { metadata: { name: 'sv-capture-s42-unlabelled', uid: 'u', labels: {} }, status: { active: 1 } },
        job('sv-capture-s421-other', 'old', { active: 1 }),
      ] };
    },
    deleteNamespacedJob: async (args) => { deleted.push(args); },
  }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const stopped = await kubernetes.stopCheckJobs(config, { sessionId: 42, spare: (id) => id === 'new' });
  assert.match(selector, /social\.usernode\.io\/session-id=42$/);
  assert.deepEqual(stopped, ['sv-capture-s42-old', 'sv-unit-suite-s42-old'],
    'not the spared run, not a finished Job, not one already going, not an unlabelled one, not another session\'s');
  assert.deepEqual(deleted, [
    { name: 'sv-capture-s42-old', namespace: 'workers', propagationPolicy: 'Background' },
    { name: 'sv-unit-suite-s42-old', namespace: 'workers', propagationPolicy: 'Background' },
  ], 'background propagation takes the Pod and the input Secret with the Job, and nothing waits on them');
  assert.ok(deleted.every((args) => !('body' in args)),
    'no body: with one, the API server ignores the query policy and the Job orphans its Pod and Secret');
});

// ── Wiring ──────────────────────────────────────────────────────────────

test('captureForSession records a manifest before its Jobs exist and clears it once it has settled', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const provisional = src.indexOf('manifest: { launched: false');
  const full = src.indexOf('launched: true');
  const launch = src.indexOf('kubernetes.runCaptureJob(');
  assert.ok(provisional > 0 && full > provisional && launch > full,
    'provisional manifest, then the full one, then the Job launch — in that order');
  assert.match(src, /finally \{[\s\S]{0,1400}if \(harvestable && settledRun\) await checkRuns\.finish\(pool, runId\);/,
    'the manifest is cleared in the run\'s finally once it settled; otherwise its retry collects by it');
  assert.match(src, /previewRunId: runId/, 'the Jobs carry the manifest\'s run id, which is how the collect finds them');
});

test('a process shutting down hands its rows over, and a run stops what it supersedes before its own Jobs start', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const cleanup = server.slice(server.indexOf('async function cleanup() {'));
  const release = cleanup.indexOf("require('./src/services/check-runs').release(shutdownPool)");
  const poolEnd = cleanup.indexOf('shutdownPool.end()');
  const leader = cleanup.indexOf('await leadership.stop()');
  assert.ok(release > 0 && poolEnd > release && leader > poolEnd,
    'the rows are handed over through the pool, before it closes and before the next leader can boot');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const full = src.indexOf('launched: true');
  const stop = src.indexOf("require('./check-harvest').stopSupersededRuns(");
  const unit = src.indexOf('unitSuite.maybeRunUnitSuite({');
  const launch = src.indexOf('kubernetes.runCaptureJob(');
  assert.ok(full > 0 && stop > full && unit > stop && launch > unit,
    'the manifest names this run first, then the superseded runs stop, then its own Jobs start');
});

test('the schema carries the check_runs manifest table', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS check_runs \(\s*run_id\s+UUID PRIMARY KEY/);
  assert.match(schema, /session_id\s+INTEGER NOT NULL REFERENCES chat_sessions\(id\) ON DELETE CASCADE/);
  assert.match(schema, /heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_check_runs_session ON check_runs \(session_id\)/);
});

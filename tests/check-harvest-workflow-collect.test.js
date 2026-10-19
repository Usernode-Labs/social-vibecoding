'use strict';

// A preview machine's checks run collected by its retry
// (services/check-harvest.js collectForWorkflow), held to what the harvest
// does for a run whose process died (#5141): a graduation lookup that fails
// is never read as "advisory", and a capture Job that wrote nothing is the
// platform's fault.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const harvest = require('../src/services/check-harvest');
const checkRuns = require('../src/services/check-runs');
const checkHistory = require('../src/services/check-history');
const kubernetes = require('../src/services/kubernetes');
const unitSuite = require('../src/services/unit-suite');

const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers', appNamespace: 'apps' } };
const SESSION = { id: 42, app_id: 9 };
const APP = { id: 9, slug: 'demo' };

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

// The run's newest launched claim, and a capture Job that `capture` answers.
function cluster(t, { capture, graduated }) {
  const seen = { finished: [], deleted: 0 };
  stub(t, kubernetes, {
    findCheckJobs: async () => ({ captures: [{ name: 'capture-0' }], unitSuites: [] }),
    collectCheckJob: async () => capture,
    deleteSettledCheckJobs: async () => { seen.deleted += 1; },
  });
  stub(t, unitSuite, { loadExpectedTests: async () => [] });
  stub(t, checkHistory, { loadGraduated: graduated });
  stub(t, checkRuns, { finish: async (pool, runId) => { seen.finished.push(runId); } });
  const pool = {
    async query(sql) {
      if (/FROM check_runs/.test(sql)) {
        return { rows: [{ run_id: 'claim-2', session_id: 42, commit_sha: 'abc', started_at: new Date().toISOString(),
          manifest: { workflow: true, launched: true, runKey: 'run:7', media: true } }] };
      }
      return { rows: [] };
    },
  };
  return { pool, seen };
}

test('a graduation lookup that fails is retried, never settled as advisory', async (t) => {
  let strict = null;
  const { pool, seen } = cluster(t, {
    capture: { state: 'succeeded', stdout: '{}', stderr: '' },
    graduated: async (p, appId, o) => { strict = o.strict; throw new Error('connection reset'); },
  });
  await assert.rejects(harvest.collectForWorkflow(config, pool, { runKey: 'run:7', session: SESSION, app: APP }),
    /connection reset/);
  assert.equal(strict, true, 'read strictly');
  assert.deepEqual([seen.finished, seen.deleted], [[], 0], 'its Jobs and its row stay for the retry to read');
});

test('a capture Job that wrote nothing is the platform\'s fault', async (t) => {
  const { pool, seen } = cluster(t, {
    capture: { state: 'failed', stdout: '', stderr: 'OOMKilled' },
    graduated: async () => new Set(),
  });
  const out = await harvest.collectForWorkflow(config, pool, { runKey: 'run:7', session: SESSION, app: APP });
  assert.deepEqual(out, { outcome: 'blocked', reason: 'capture Job failed (OOMKilled)', platformFault: true });
  assert.deepEqual(seen.finished, ['claim-2']);
});

// services/unit-suite-reuse.js: a run that copied an earlier pass of its
// commit instead of running the unit suite has no unit-suite Job. Its retry
// settles it from the row its manifest carries, exactly as the live run
// would, and never mistakes it for a merge-blocking suite gone missing.
test('a run that reused an earlier unit-suite pass is settled with that row, with no unit Job to look for', async (t) => {
  const reusedRow = {
    index: unitSuite.UNIT_CHECK_INDEX, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH,
    status: 'pass', advisory: false, consoleErrors: [], failureReason: '', summary: { tests: 5, pass: 5 },
    reused: { runId: 'run-0', sessionId: 42, passedAt: '2026-10-14T10:00:00.000Z' },
  };
  const collected = [];
  let settledWith = null;
  const unitKey = require('../src/services/app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
  stub(t, kubernetes, {
    // A unit-suite Job the run's claim could have launched is never read.
    findCheckJobs: async () => ({ captures: [{ name: 'capture-0' }], unitSuites: [{ name: 'unit-0' }] }),
    collectCheckJob: async (_c, { kind }) => { collected.push(kind); return { state: 'succeeded', stdout: '{}', stderr: '' }; },
    deleteSettledCheckJobs: async () => {},
  });
  stub(t, unitSuite, { loadExpectedTests: async () => [] });
  // The suite is merge-blocking: a missing row would be null (run again).
  stub(t, checkHistory, { loadGraduated: async () => new Set([unitKey]) });
  stub(t, checkRuns, { finish: async () => {} });
  const visuals = require('../src/services/visuals');
  stub(t, visuals, { settleCaptureRun: async (_c, _p, run) => { settledWith = run; return { result: { outcome: 'verdict', state: 'passing' } }; } });
  const pool = {
    async query(sql) {
      if (/FROM check_runs/.test(sql)) {
        return { rows: [{ run_id: 'claim-2', session_id: 42, commit_sha: 'abc', started_at: new Date().toISOString(),
          manifest: { workflow: true, launched: true, runKey: 'run:7', media: true,
            unitReused: { row: reusedRow, earned: unitKey, snapshot: { phase: 'done', done: true, reused: reusedRow.reused } } } }] };
      }
      return { rows: [] };
    },
  };
  const out = await harvest.collectForWorkflow(config, pool, { runKey: 'run:7', session: SESSION, app: APP });
  assert.deepEqual(out, { outcome: 'verdict', state: 'passing' }, 'settled, not left for a fresh run');
  assert.deepEqual(collected, ['capture'], 'no unit-suite Job is read');
  assert.deepEqual(settledWith.unitOutcome, { row: reusedRow, history: null, earned: unitKey },
    'the same row, no history, and the gate it earns the proposal');
});

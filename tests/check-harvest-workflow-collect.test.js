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

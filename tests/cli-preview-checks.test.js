'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverCaptureRun } = require('../src/services/cli-preview-handoff/checks');
const kubernetes = require('../src/services/kubernetes');
const lifecycle = require('../src/services/preview-lifecycle');

const config = { captureRuntime: 'kubernetes' };
const pool = { query: async () => ({ rows: [] }) };
const session = { id: 42, check_state: 'passing' };
const previous = { state: 'completed', run_id: 'old-run' };

test('C9 explicit recheck starts fresh only after the previous obligation closed', async () => {
  assert.deepEqual(await recoverCaptureRun(config, { pool, session, previous, force: true }), { handled: false });
  assert.deepEqual(await recoverCaptureRun(config, { pool, session, previous }), {
    handled: true, result: { state: 'passing' },
  });
});

test('C9 loss between manifest removal and lifecycle closure releases the exact run before joining', async t => {
  const calls = [];
  t.mock.method(kubernetes, 'cancelPreviewChecks', async (_config, id, runId, options) => {
    calls.push(['retire', id, runId, options.releaseInputs]);
  });
  t.mock.method(lifecycle, 'settleAdopted', async (_config, operation) => {
    calls.push(['settle', operation.sessionId, operation.runId]);
  });
  assert.deepEqual(await recoverCaptureRun(config, {
    pool, session, previous: { ...previous, state: 'running' }, force: true,
  }), { handled: true, result: { state: 'passing' } });
  assert.deepEqual(calls, [['retire', 42, 'old-run', true], ['settle', 42, 'old-run']]);
});

test('C9 failed retirement cannot report a terminal run as released', async t => {
  t.mock.method(kubernetes, 'cancelPreviewChecks', async () => { throw new Error('API unavailable'); });
  t.mock.method(lifecycle, 'settleAdopted', async () => assert.fail('Unreleased consumers'));
  await assert.rejects(recoverCaptureRun(config, {
    pool, session, previous: { ...previous, state: 'running' },
  }), /API unavailable/);
});

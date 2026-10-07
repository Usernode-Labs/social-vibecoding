'use strict';

// A workflow checks run (the preview machine's checks.run) settles by
// RETURNING its settlement: settleCaptureRun with `collect` stores no
// verdict, console, history or capture outcome (the machine does, in one
// transaction) and only writes the legacy media, after its checkpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');

const SHA = 'a'.repeat(40);
const frame = (index, status) => [
  `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200`,
  Buffer.from(JSON.stringify({ name: `Check ${index}`, path: '/', consoleErrors: [], failureReason: status === 'pass' ? '' : 'no' })).toString('base64'),
  '__USERNODE_TEST_END__',
].join('\n');

function harness(t) {
  for (const [mod, fn] of [
    ['../src/services/asset-route-check', 'maybeRunAssetRouteCheck'],
    ['../src/services/content-review', 'maybeRunContentReview'],
    ['../src/services/small-change', 'maybeTagSmallChange'],
    ['../src/services/render-health', 'maybeBuildRenderHealthRow'],
  ]) t.mock.method(require(mod), fn, async () => null);
  const writes = [];
  const query = async (text) => { writes.push(String(text).replace(/\s+/g, ' ').trim().slice(0, 40)); return { rows: [], rowCount: 0 }; };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const checkpoints = [];
  const run = (extra) => ({
    session: { id: 7, app_id: 3, pr_number: null }, app: { id: 3, slug: 'demo', repo_url: '' }, commitHash: SHA,
    media: false, capturePaths: ['/'], pathDefaulted: true, prodRunning: false, stagingOrigin: 'http://preview:3000',
    targets: [], testsCount: 2, stdout: [frame(0, 'pass'), frame(1, 'pass')].join('\n'),
    collect: true, checkpoint: async (v) => { checkpoints.push(v); },
    ...extra,
  });
  return { pool, writes, checkpoints, run };
}

test('a collected verdict is returned with its console, history and capture outcome, and stores none of them', async (t) => {
  const h = harness(t);
  const unitOutcome = { row: { index: 9000, name: 'Unit tests', path: '/', status: 'pass', advisory: false },
    history: { checkKey: 'unit', name: 'Unit tests', path: '/', passed: true } };
  const { result } = await visuals.settleCaptureRun({}, h.pool, h.run({ unitOutcome }));
  assert.equal(result.outcome, 'verdict');
  assert.equal(result.state, 'passing');
  assert.equal(result.results.length, 3);
  assert.equal(result.console.state, 'clean');
  assert.deepEqual(result.history, [unitOutcome.history]);
  assert.equal(result.capture.state, 'console_only');
  assert.equal(result.visuals, false);
  assert.deepEqual(h.checkpoints, [{ step: 'media' }], 'the media write waits for the checkpoint');
  assert.ok(!h.writes.some((w) => /UPDATE chat_sessions|app_check_history/.test(w)), 'no verdict, history or outcome write');
});

test('a unit suite that could not run makes the verdict an error with its reason, and no history', async (t) => {
  const h = harness(t);
  const { result } = await visuals.settleCaptureRun({}, h.pool, h.run({ unitOutcome: { runnerError: 'image pull failed' } }));
  assert.equal(result.state, 'error');
  assert.equal(result.errorDetail, 'The unit suite could not run: image pull failed');
  assert.deepEqual(result.history, []);
});

test('a deferred head is collected as a deferral with its capture outcome', async (t) => {
  const h = harness(t);
  const { result } = await visuals.settleCaptureRun({}, h.pool, h.run({ shotsOnly: true, admissionReason: 'conflicts', stdout: '' }));
  assert.deepEqual([result.outcome, result.capture.state, result.capture.detail.deferred], ['deferred', 'console_only', true]);
});

test('a cancelled run writes no media', async (t) => {
  const h = harness(t);
  const cancelled = Object.assign(new Error('work lease lost'), { name: 'LeaseLost' });
  await assert.rejects(visuals.settleCaptureRun({}, h.pool, h.run({ checkpoint: async () => { throw cancelled; } })), cancelled);
  assert.ok(!h.writes.some((w) => /session_visuals/.test(w)));
});

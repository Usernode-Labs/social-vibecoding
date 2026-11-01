'use strict';

// A workflow checks run (the preview machine's checks.run) settles by
// RETURNING its settlement: settleCaptureRun with `collect` stores no
// verdict, console, history, capture outcome or published media (the
// machine does, in one transaction); it only holds the run's media under
// its run id (check_run_media), for that transaction to publish.

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
  require('./lib/media-store').useMemoryMedia(t);
  for (const [mod, fn] of [
    ['../src/services/asset-route-check', 'maybeRunAssetRouteCheck'],
    ['../src/services/content-review', 'maybeRunContentReview'],
    ['../src/services/small-change', 'maybeTagSmallChange'],
    ['../src/services/render-health', 'maybeBuildRenderHealthRow'],
  ]) t.mock.method(require(mod), fn, async () => null);
  const writes = [];
  const query = async (text) => { writes.push(String(text).replace(/\s+/g, ' ').trim().slice(0, 40)); return { rows: [], rowCount: 0 }; };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const run = (extra) => ({
    session: { id: 7, app_id: 3, pr_number: null }, app: { id: 3, slug: 'demo', repo_url: '' }, commitHash: SHA,
    media: false, capturePaths: ['/'], pathDefaulted: true, prodRunning: false, stagingOrigin: 'http://preview:3000',
    targets: [], testsCount: 2, stdout: [frame(0, 'pass'), frame(1, 'pass')].join('\n'),
    collect: { runId: 'run-1-4' },
    ...extra,
  });
  return { pool, writes, run };
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
  assert.equal(result.visuals, null, 'no media this run');
  assert.ok(!h.writes.some((w) => /UPDATE chat_sessions|app_check_history|session_visuals/.test(w)),
    'no verdict, history, outcome or published media write');
});

test('a deferred head is collected as a deferral with its capture outcome', async (t) => {
  const h = harness(t);
  const { result } = await visuals.settleCaptureRun({}, h.pool, h.run({ shotsOnly: true, admissionReason: 'conflicts', stdout: '' }));
  assert.deepEqual([result.outcome, result.capture.state, result.capture.detail.deferred], ['deferred', 'console_only', true]);
});

test('a run\'s media are held under its run id, never written where the session shows them', async (t) => {
  const h = harness(t);
  const png = Buffer.from('89504e47', 'hex').toString('base64');
  const shot = ['__USERNODE_SHOT__ kind=after media=png index=0', png, '__USERNODE_SHOT_END__'].join('\n');
  const { result } = await visuals.settleCaptureRun({}, h.pool, h.run({ media: true,
    targets: [{ index: 0, path: '/' }], stdout: [frame(0, 'pass'), frame(1, 'pass'), shot].join('\n') }));
  assert.ok(h.writes.some((w) => /INSERT INTO check_run_media/.test(w)), 'held for the settling transaction');
  assert.ok(h.writes.some((w) => /DELETE FROM check_run_media WHERE run_id/.test(w)), 'replacing only what this run held');
  assert.equal(result.capture.state, 'captured');
  assert.ok(result.visuals, 'the grouped ids come back, for visuals_ready');
  assert.ok(!h.writes.some((w) => /session_visuals/.test(w)), 'never session_visuals');
});

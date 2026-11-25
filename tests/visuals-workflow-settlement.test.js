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

// A settled run gives its checks slot back. When the early unit suite it
// adopted cannot be stopped, the slot used to stay taken until somebody
// deleted the row by hand ("Keeping the checks slot until early unit Jobs
// stop or expire", with nothing that came back for it): now it counts only
// until those Jobs' deadline, and the queue's admission pass deletes it.
function slotPool({ failUpdate = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (failUpdate && /^UPDATE check_runs/.test(String(sql).trim())) throw new Error('db down');
      return { rows: [], rowCount: 1 };
    },
  };
}
const deletes = (pool) => pool.calls.filter((c) => /^DELETE FROM check_runs WHERE run_id = \$1/.test(c.sql)).map((c) => c.params[0]);
const lingers = (pool) => pool.calls.filter((c) => /^UPDATE check_runs SET manifest = manifest \|\| '\{"settled": true\}'/.test(c.sql)).map((c) => c.params[0]);

test('a settled run with no early suite of its own frees its slot', async (t) => {
  const cancel = t.mock.method(require('../src/services/kubernetes'), 'cancelPreviewChecks', async () => {});
  const pool = slotPool();
  assert.equal(await visuals.giveBackSettledSlot({}, pool, { sessionId: 7, runId: 'run-a' }), 'freed');
  assert.deepEqual(deletes(pool), ['run-a']);
  assert.equal(cancel.mock.callCount(), 0);
});

test('a settled run stops the early suite it adopted, then frees its slot', async (t) => {
  const order = [];
  const cancel = t.mock.method(require('../src/services/kubernetes'), 'cancelPreviewChecks', async () => { order.push('stopped'); });
  const pool = slotPool();
  const query = pool.query;
  pool.query = async (sql, params) => { order.push('deleted'); return query(sql, params); };
  assert.equal(await visuals.giveBackSettledSlot({}, pool, { sessionId: 7, runId: 'run-a', adoptedEarlyUnit: 'early-1' }), 'freed');
  assert.deepEqual(cancel.mock.calls[0].arguments.slice(1), [7, 'early-1', { includeEarly: true }]);
  assert.deepEqual(order, ['stopped', 'deleted'], 'its Pods stop before the slot goes');
  assert.deepEqual(deletes(pool), ['run-a']);
});

test('a settled run whose early suite will not stop counts until the Jobs\' deadline, never for good', async (t) => {
  t.mock.method(require('../src/services/kubernetes'), 'cancelPreviewChecks', async () => {
    throw new Error('Preview checks still stopping: sv-unit-early-s7-x');
  });
  const pool = slotPool();
  assert.equal(await visuals.giveBackSettledSlot({}, pool, { sessionId: 7, runId: 'run-a', adoptedEarlyUnit: 'early-1' }), 'lingering');
  assert.deepEqual(lingers(pool), ['run-a'], 'marked settled: the queue holds it only while its Jobs may run');
  assert.deepEqual(deletes(pool), [], 'the admission pass deletes it after their deadline');
  // A lingering row as the queue reads it, within and past the Jobs' deadline.
  const queue = require('../src/services/checks-queue');
  assert.equal(queue.holdsSlot({ lingering: true, within_deadline: true, run_finished: true }, false), true);
  assert.equal(queue.holdsSlot({ lingering: true, within_deadline: false }, false), false);
  assert.equal(queue.sweepReason({ kind: 'proposal', lingering: true, within_deadline: false }, false), 'deadline');

  // Not even marked (the database refused that too): the slot goes back
  // rather than staying taken with nothing to clear it.
  const refusing = slotPool({ failUpdate: true });
  assert.equal(await visuals.giveBackSettledSlot({}, refusing, { sessionId: 7, runId: 'run-b', adoptedEarlyUnit: 'early-1' }), 'freed');
  assert.deepEqual(deletes(refusing), ['run-b']);
});

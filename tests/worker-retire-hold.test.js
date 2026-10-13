'use strict';

// A before/after shots run works inside its proposal's own worker, and the
// merge retires that worker. Admin export 2026-10-02: every shots agent that
// died after the redeploy (exit cause container_gone) died about 30 seconds
// after its proposal merged mid-run, when Kubernetes' grace period for the
// deleted pod ran out. Pinned here: while a shots run holds the worker, a
// retirement waits; whichever of the two comes second deletes the worker and
// its volume, exactly once; and with no hold a retirement is immediate.
//
// Run with: node --test tests/worker-retire-hold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');

function withKubernetes(t) {
  const prior = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = 'kubernetes';
  t.after(() => {
    if (prior === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = prior;
  });
  const deleted = [];
  t.mock.method(kubernetes, 'deleteWorker', async (_config, sessionId, options) => {
    deleted.push([sessionId, options]);
  });
  return deleted;
}

test('with no shots run holding it, a merged change\'s worker and volume go at once', async (t) => {
  const deleted = withKubernetes(t);
  assert.deepEqual(await worker.retireWorker(9101), { deferred: false });
  assert.deepEqual(deleted, [[9101, { deleteVolume: true }]]);
});

test('a merge during a shots run waits for the run, which then retires the worker once', async (t) => {
  const deleted = withKubernetes(t);
  const hold = worker.holdWorker(9102);
  assert.deepEqual(await worker.retireWorker(9102), { deferred: true });
  assert.deepEqual(deleted, [], 'nothing is deleted under the running agent');

  assert.equal(await hold.release(), true, 'the release carried the retirement out');
  assert.deepEqual(deleted, [[9102, { deleteVolume: true }]]);
  assert.equal(await hold.release(), false, 'a second release does nothing');
  assert.equal(deleted.length, 1);
});

test('a run that ends before any merge leaves the worker, and a later merge retires it at once', async (t) => {
  const deleted = withKubernetes(t);
  const hold = worker.holdWorker(9103);
  assert.equal(await hold.release(), false);
  assert.deepEqual(deleted, [], 'an open change keeps its worker');
  assert.deepEqual(await worker.retireWorker(9103), { deferred: false });
  assert.deepEqual(deleted, [[9103, { deleteVolume: true }]]);
});

test('with two holds, only the last release retires, and holds on other changes are separate', async (t) => {
  const deleted = withKubernetes(t);
  const first = worker.holdWorker(9104);
  const second = worker.holdWorker(9104);
  const other = worker.holdWorker(9105);
  assert.deepEqual(await worker.retireWorker(9104), { deferred: true });
  assert.equal(await first.release(), false);
  assert.deepEqual(deleted, []);
  assert.equal(await second.release(), true);
  assert.deepEqual(deleted, [[9104, { deleteVolume: true }]]);
  // The other change was never retired, so its release deletes nothing.
  assert.equal(await other.release(), false);
  assert.equal(deleted.length, 1);
});

test('a hold taken after a deferred retirement ran starts clean', async (t) => {
  const deleted = withKubernetes(t);
  const hold = worker.holdWorker(9106);
  await worker.retireWorker(9106);
  await hold.release();
  const next = worker.holdWorker(9106);
  assert.equal(await next.release(), false, 'the earlier retirement is not carried over');
  assert.equal(deleted.length, 1);
});

test('a failed deferred retirement rejects the release, so the run can log it', async (t) => {
  withKubernetes(t);
  t.mock.method(kubernetes, 'deleteWorker', async () => { throw new Error('api down'); });
  const hold = worker.holdWorker(9107);
  await worker.retireWorker(9107);
  await assert.rejects(hold.release(), /api down/);
  // The hold is gone either way: a later merge or sweep is not blocked by it.
  assert.equal(await worker.holdWorker(9107).release(), false);
});

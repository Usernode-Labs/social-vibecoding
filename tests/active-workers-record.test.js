'use strict';

// services/active-workers.js with the preview machine on: each turn and each
// operation is recorded on the session's instance under an id of its own (a
// record's request keys last the instance's life, so a second turn under the
// first one's id was never recorded), and its end is recorded even when
// waiting for its start failed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitFor } = require('./lib/wait-for');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const sent = [];
const answer = { start: async () => {}, end: async () => {} };
const releases = { n: 0 };
stub('../src/workflow/platform.ts', {
  previewsEnabled: () => true,
  async operationStarted(o) { sent.push(['start', o.sessionId, o.id, o.kind]); return answer.start(o); },
  async operationEnded(o) { sent.push(['end', o.sessionId, o.id]); return answer.end(o); },
});
stub('../src/services/process-presence', {
  holder: () => 'test-host', ensure: async () => {}, hold() {}, release() { releases.n += 1; },
});
stub('../src/db/pool', { getPool: () => ({ options: { connectionString: 'postgres://x' } }) });

const { activeWorkers, beginSessionOperation } = require('../src/services/active-workers');
const settle = () => new Promise((r) => setTimeout(r, 10));

test('each turn on a session is a record of its own', async () => {
  sent.length = 0;
  await activeWorkers.enter(41);
  activeWorkers.delete(41);
  await settle();
  await activeWorkers.enter(41);
  activeWorkers.delete(41);
  await settle();
  const starts = sent.filter((s) => s[0] === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0][2], starts[1][2], 'a new id per turn');
  assert.deepEqual(sent.filter((s) => s[0] === 'end').map((s) => s[2]), starts.map((s) => s[2]), 'each ended, in order');
});

test('an earlier stop response cannot release a newer local hold', async () => {
  await activeWorkers.enter(43);
  const first = activeWorkers.generation(43);
  activeWorkers.delete(43);
  await activeWorkers.enter(43);
  assert.notEqual(activeWorkers.generation(43), first);
  assert.equal(activeWorkers.deleteIf(43, first), false);
  assert.equal(activeWorkers.has(43), true);
  assert.equal(activeWorkers.deleteIf(43, activeWorkers.generation(43)), true);
  assert.equal(activeWorkers.generation(43), null);
});

test('an operation is recorded before its caller goes on, and ends even when the wait for its start failed', async () => {
  sent.length = 0;
  answer.start = async () => { throw new Error('timed out waiting'); };
  const release = beginSessionOperation(42, 'sync');
  await release.recorded;
  assert.deepEqual(sent.map((s) => s[0]), ['start']);
  release();
  await settle();
  assert.deepEqual(sent.map((s) => s[0]), ['start', 'end'], 'the start may have been appended: its end is too');
  answer.start = async () => {};
});

// #6068: a record outlives this process's memory, so an end the workflow
// database refused is written again; presence is released once, after it.
test('a record whose end failed is written again, and presence is released once', async () => {
  sent.length = 0;
  releases.n = 0;
  let failures = 1;
  answer.end = async () => { if (failures-- > 0) throw new Error('the database blinked'); };
  const release = beginSessionOperation(44, 'sync');
  await release.recorded;
  release();
  await waitFor(() => releases.n === 1, { label: 'the second end to be tried and presence released once' });
  assert.deepEqual(sent.map((s) => s[0]), ['start', 'end', 'end'], 'the end is retried');
  assert.equal(releases.n, 1, 'released once, after the last try');
  answer.end = async () => {};
  sent.length = 0;
  const again = beginSessionOperation(45, 'sync');
  await again.recorded;
  again();
  await waitFor(() => releases.n === 2, { label: 'an end that answers releases too' });
  assert.deepEqual(sent.map((s) => s[0]), ['start', 'end'], 'no retry when it answers');
});

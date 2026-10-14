'use strict';

// services/active-workers.js with the preview machine on: each turn and each
// operation is recorded on the session's instance under an id of its own (a
// record's request keys last the instance's life, so a second turn under the
// first one's id was never recorded), and its end is recorded even when
// waiting for its start failed.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const sent = [];
const answer = { start: async () => {} };
stub('../src/workflow/platform.ts', {
  previewsEnabled: () => true,
  async operationStarted(o) { sent.push(['start', o.sessionId, o.id, o.kind]); return answer.start(o); },
  async operationEnded(o) { sent.push(['end', o.sessionId, o.id]); },
});
stub('../src/services/process-presence', {
  holder: () => 'test-host', ensure: async () => {}, hold() {}, release() {},
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

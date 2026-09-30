// A worker's workspace lives on the container's own filesystem, so evicting
// or replacing the worker deletes any commit it still holds. Sheep countrr's
// session 5030 lost a whole feature that way when its worker was replaced for
// a stale image (usernode-bot/sheep-countrr-a08857#48).
//
// Pins what counts as an unpushed commit worth rescuing (a finished build
// whose push failed, never a stopped turn's partial work), that eviction
// pushes it first, and that a successful push or a new turn clears it.
//
// Run with: node --test tests/worker-unpushed-rescue.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');

function withKubernetes(t, { token = 'fake-test-token' } = {}) {
  const prior = { runtime: process.env.WORKER_RUNTIME, token: process.env.GITHUB_BOT_TOKEN };
  process.env.WORKER_RUNTIME = 'kubernetes';
  if (token) process.env.GITHUB_BOT_TOKEN = token;
  else delete process.env.GITHUB_BOT_TOKEN;
  t.after(() => {
    if (prior.runtime === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = prior.runtime;
    if (prior.token === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = prior.token;
  });
}

test('only a finished build whose push failed has a commit to rescue', () => {
  const finished = { resultSeen: true, ahead: 2, sha: 'abc1234', pushOk: false };
  assert.deepEqual(worker.unpushedCommit('build', finished, 'dev/evan-1'), { sha: 'abc1234', branchName: 'dev/evan-1' });
  // A stopped turn is killed before its RESULT line: its work is dropped.
  assert.equal(worker.unpushedCommit('build', { ...finished, resultSeen: false }, 'dev/evan-1'), null);
  assert.equal(worker.unpushedCommit('build', { ...finished, pushOk: true }, 'dev/evan-1'), null);
  assert.equal(worker.unpushedCommit('build', { ...finished, ahead: 0 }, 'dev/evan-1'), null);
  assert.equal(worker.unpushedCommit('build', { ...finished, sha: null }, 'dev/evan-1'), null);
  assert.equal(worker.unpushedCommit('build', finished, null), null);
  for (const mode of ['scout', 'sync', 'shots']) assert.equal(worker.unpushedCommit(mode, finished, 'dev/evan-1'), null, mode);
  assert.equal(worker.unpushedCommit('build', null, 'dev/evan-1'), null);
});

test('eviction pushes an unpushed commit before the worker is deleted', async (t) => {
  withKubernetes(t);
  const calls = [];
  t.mock.method(kubernetes, 'execInWorker', async (_config, runtime, command) => {
    calls.push(['exec', runtime, command[0]]);
    return { stdout: 'abc1234\n', stderr: '' };
  });
  t.mock.method(kubernetes, 'deleteWorker', async (_config, sessionId) => { calls.push(['delete', sessionId]); });
  worker.adoptWarmWorker(71001, 'sv-worker-s71001');
  worker._registryUpsertForTests(71001, { unpushed: { sha: 'abc1234', branchName: 'dev/evan-1' } });

  await worker.evictWorker(71001);
  assert.deepEqual(calls.map((c) => c[0]), ['exec', 'delete'], 'the push runs first');
  assert.equal(calls[0][2], 'bash');
});

test('a successful push clears the record, and a failed rescue never blocks eviction', async (t) => {
  withKubernetes(t);
  t.mock.method(kubernetes, 'execInWorker', async () => ({ stdout: 'abc1234\n', stderr: '' }));
  worker.adoptWarmWorker(71002, 'sv-worker-s71002');
  worker._registryUpsertForTests(71002, { unpushed: { sha: 'abc1234', branchName: 'dev/evan-2' } });
  assert.deepEqual(await worker.rescueUnpushedCommit(71002), { attempted: true, pushed: true });
  assert.deepEqual(await worker.rescueUnpushedCommit(71002), { attempted: false }, 'nothing left to rescue');

  worker._registryUpsertForTests(71002, { unpushed: { sha: 'def5678', branchName: 'dev/evan-2' } });
  delete process.env.GITHUB_BOT_TOKEN;
  assert.deepEqual(await worker.rescueUnpushedCommit(71002), { attempted: true, pushed: false });
});

test('nothing is rescued from a worker with a turn in flight', async (t) => {
  withKubernetes(t);
  const exec = t.mock.method(kubernetes, 'execInWorker', async () => ({ stdout: 'x\n', stderr: '' }));
  worker.adoptWarmWorker(71003, 'sv-worker-s71003');
  worker._registryUpsertForTests(71003, { inFlight: true, unpushed: { sha: 'abc1234', branchName: 'dev/evan-3' } });
  assert.deepEqual(await worker.rescueUnpushedCommit(71003), { attempted: false });
  assert.equal(exec.mock.callCount(), 0);
});

test('the record is set when a build ends, cleared when the next turn starts, and checked before a Kubernetes replacement', () => {
  assert.match(SRC, /unpushed: unpushedCommit\(mode, execState, branchName\),/);
  assert.match(SRC, /inFlight: true, activeTurnMode: mode, journal, activeTurnId: durableTurnId,[\s\S]{0,400}unpushed: null,/);
  const stale = SRC.slice(SRC.indexOf('if (staleReason) {'), SRC.indexOf('// fall through to the bootstrap branch below'));
  assert.match(stale, /\} else \{\n[\s\S]{0,200}await rescueUnpushedCommit\(sessionId, \{ branchName \}\);/);
  const evict = SRC.slice(SRC.indexOf('async function evictWorker('));
  assert.ok(evict.indexOf('await rescueUnpushedCommit(sessionId);') < evict.indexOf('kubernetes.deleteWorker'));
  assert.ok(evict.indexOf('await rescueUnpushedCommit(sessionId);') < evict.indexOf('docker.stopAndRemove'));
});

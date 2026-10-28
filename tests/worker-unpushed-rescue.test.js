// A worker's workspace lives on the container's own filesystem, so evicting
// or replacing the worker deletes any commit it still holds. Sheep countrr's
// session 5030 lost a whole feature that way when its worker was replaced for
// a stale image (usernode-bot/sheep-countrr-a08857#48).
//
// Pins what counts as an unpushed commit worth rescuing (a finished build
// whose push failed, never a stopped turn's partial work), that eviction
// pushes it first, and that a successful push clears its durable record.
//
// Run with: node --test tests/worker-unpushed-rescue.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');
const workerGitPush = require('../src/services/worker-git-push');
const unpushedCommits = require('../src/services/worker-unpushed-commit');
const db = require('../src/db/pool');
const SHA = 'a'.repeat(40);

function stubTrustedPush(t, branches, calls = [], { turn = null } = {}) {
  t.mock.method(require('../src/services/github'), 'checkRepoPublic', async () => ({ ok: true, private: false }));
  const commits = new Map();
  const pool = { query: async (sql, [id, sha, branchName]) => {
    if (sql.includes('INSERT INTO session_workers (session_id, unpushed_sha')) commits.set(id, sha ? { sha, branchName } : null);
    if (sql.includes('UPDATE session_workers SET unpushed_sha = NULL')
        && commits.get(id)?.sha === sha && commits.get(id)?.branchName === branchName) commits.delete(id);
    if (sql.includes('DELETE FROM session_workers')) commits.delete(id);
    const pending = commits.get(id);
    if (sql.includes('SELECT sw.unpushed_sha AS sha')) return { rows: pending ? [{ ...pending, active: !!turn, turn_id: turn?.turnId, phase: turn?.phase }] : [] };
    return { rows: [{ branch_name: branches[id], repo_url: 'https://github.com/Trusted-Owner/stored-repo.git',
      unpushed_sha: pending?.sha, unpushed_branch_name: pending?.branchName }] };
  } };
  t.mock.method(db, 'getPool', () => pool);
  t.mock.method(workerGitPush, 'push', async options => {
    assert.equal(options.remoteUrl, 'https://github.com/Trusted-Owner/stored-repo.git');
    assert.equal(options.token, 'fake-test-token');
    calls.push(['push']);
    await options.exportWorker('export Git objects only');
    return { sha: options.expectedSha || SHA, stderr: '' };
  });
  return commit => unpushedCommits.record(pool, Number(Object.keys(branches)[0]), commit);
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'worker.js'), 'utf8');

// The push's GitHub credential: the App's installation token, which a test
// takes away by setting `credential.token` to null.
const credential = { token: null };

function withKubernetes(t, { token = 'fake-test-token' } = {}) {
  const prior = { runtime: process.env.WORKER_RUNTIME };
  process.env.WORKER_RUNTIME = 'kubernetes';
  credential.token = token;
  const github = require('../src/services/github');
  t.mock.method(github, 'canActOn', () => true);
  t.mock.method(github, 'getInstallationToken', async () => {
    if (!credential.token) throw new Error('No GitHub App installation token');
    return credential.token;
  });
  t.after(() => {
    if (prior.runtime === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = prior.runtime;
    credential.token = null;
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
  const record = stubTrustedPush(t, { 71001: 'dev/evan-1' }, calls);
  t.mock.method(kubernetes, 'execInWorker', async (_config, runtime, command, stdin) => {
    assert.equal(stdin, null);
    assert.equal(JSON.stringify(command).includes('fake-test-token'), false);
    calls.push(['exec', runtime, command[0]]);
    return { stdout: 'abc1234\n', stderr: '' };
  });
  t.mock.method(kubernetes, 'deleteWorker', async (_config, sessionId) => { calls.push(['delete', sessionId]); });
  worker.adoptWarmWorker(71001, 'sv-worker-s71001');
  await record({ sha: SHA, branchName: 'dev/evan-1' });

  await worker.evictWorker(71001);
  assert.deepEqual(calls.map((c) => c[0]), ['push', 'exec', 'exec', 'delete'], 'trusted push exports and acknowledges before deletion');
  assert.equal(calls[1][2], 'sh');
  assert.equal(calls[2][2], 'sh');
});

test('a successful push clears the durable record, and a failed rescue prevents eviction', async (t) => {
  withKubernetes(t);
  const record = stubTrustedPush(t, { 71002: 'dev/evan-2' });
  t.mock.method(kubernetes, 'execInWorker', async () => ({ stdout: 'abc1234\n', stderr: '' }));
  worker.adoptWarmWorker(71002, 'sv-worker-s71002');
  await record({ sha: 'abc1234', branchName: 'dev/evan-2' });
  assert.deepEqual(await worker.rescueUnpushedCommit(71002), { attempted: true, pushed: true });
  assert.deepEqual(await worker.rescueUnpushedCommit(71002), { attempted: false }, 'nothing left to rescue');

  await record({ sha: 'def5678', branchName: 'dev/evan-2' });
  credential.token = null;
  await assert.rejects(worker.rescueUnpushedCommit(71002), e => e.unpushedCommit && e.permanent && e.code === 'no_token');
  const deleted = [];
  t.mock.method(kubernetes, 'deleteWorker', async (_config, id) => deleted.push(id));
  await assert.rejects(worker.evictWorker(71002), /An earlier build's commit def5678/);
  assert.deepEqual(deleted, [], 'failed rescue keeps the checkout');
  worker._registryForgetForTests(71002);
});

test('nothing is rescued from a worker with a durable turn in flight', async (t) => {
  withKubernetes(t);
  const exec = t.mock.method(kubernetes, 'execInWorker', async () => ({ stdout: 'x\n', stderr: '' }));
  worker.adoptWarmWorker(71003, 'sv-worker-s71003');
  worker._registryUpsertForTests(71003, { inFlight: true });
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [{ sha: SHA, branchName: 'dev/evan-3', active: true }] }) }));
  t.after(() => worker._registryForgetForTests(71003));
  assert.deepEqual(await worker.rescueUnpushedCommit(71003), { attempted: false });
  assert.equal(exec.mock.callCount(), 0);
});

test('a stale in-flight registry entry cannot hide a durable commit whose turn ended', async t => {
  withKubernetes(t);
  const record = stubTrustedPush(t, { 71005: 'dev/evan-5' });
  t.mock.method(kubernetes, 'execInWorker', async () => ({ stdout: '', stderr: '' }));
  worker.adoptWarmWorker(71005, 'sv-worker-s71005');
  worker._registryUpsertForTests(71005, { inFlight: true });
  t.after(() => worker._registryForgetForTests(71005));
  await record({ sha: SHA, branchName: 'dev/evan-5' });
  assert.deepEqual(await worker.rescueUnpushedCommit(71005), { attempted: true, pushed: true });
});

test('both teardown paths persist before releasing the turn, and replacement checks the durable record', () => {
  assert.match(SRC, /await recordFinishedCommit\(sessionId, mode, execState, branchName, durableTurnId,/);
  assert.match(SRC, /await recordFinishedCommit\(sessionId, turnMode, state, branchName, turnId\);/);
  assert.match(SRC, /await unpushedCommits.record[\s\S]{0,500}finally \{\s+_registryUpsert/);
  assert.doesNotMatch(SRC, /unpushed:\s/,'no process-local source of truth remains');
  const ensure = SRC.slice(SRC.indexOf('async function ensureWorkerClaimed('), SRC.indexOf('async function execInWorker('));
  assert.ok(ensure.indexOf('await prepareWorkerTurn(sessionId, turnId);') < ensure.indexOf('if (staleReason) {'));
  const evict = SRC.slice(SRC.indexOf('async function evictWorker('));
  assert.ok(evict.indexOf('await rescueUnpushedCommit(sessionId);') < evict.indexOf('kubernetes.deleteWorker'));
  assert.ok(evict.indexOf('await rescueUnpushedCommit(sessionId);') < evict.indexOf('docker.stopAndRemove'));
});

test('a current-image worker rescues and clears its recorded commit before it is reused', async t => {
  for (const turn of [null, { turnId: 'new-turn', phase: 'dispatch_pending' }]) await t.test(`own pending turn: ${!!turn}`, async t => {
    withKubernetes(t);
    const calls = [];
    const record = stubTrustedPush(t, { 71006: 'dev/evan-6' }, calls, { turn });
    t.mock.method(kubernetes, 'getWorkerStatus', async () => 'running');
    t.mock.method(kubernetes, 'getWorkerRuntimeMetadata', async config => ({
      contractVersion: SRC.match(/const WORKER_BOOTSTRAP_ENV_VERSION = '(v\d+)'/)[1],
      imageRef: config.kubernetes.workerImage, storageMode: 'persistent',
    }));
    t.mock.method(kubernetes, 'ensureWorker', () => { throw new Error('must reuse the current worker'); });
    t.mock.method(kubernetes, 'execInWorker', async () => ({ stdout: '', stderr: '' }));
    worker.adoptWarmWorker(71006, 'sv-worker-s71006');
    t.after(() => worker._registryForgetForTests(71006));
    await record({ sha: SHA, branchName: 'dev/evan-6' });
    assert.equal(await worker.ensureWorker(71006, { repoOwner: 'Trusted-Owner', repoName: 'stored-repo', branchName: 'dev/evan-6', turnId: turn?.turnId }), 'sv-worker-s71006');
    assert.deepEqual(calls, [['push']]);
    assert.deepEqual(await worker.rescueUnpushedCommit(71006), { attempted: false });
  });
});

test('preparation cannot skip an unpushed commit hidden by a different active turn', async t => {
  withKubernetes(t);
  const calls = [];
  const record = stubTrustedPush(t, { 71007: 'dev/evan-7' }, calls, { turn: { turnId: 'other-turn', phase: 'executing' } });
  t.mock.method(kubernetes, 'getWorkerStatus', () => { throw new Error('must not inspect or replace the busy worker'); });
  await record({ sha: SHA, branchName: 'dev/evan-7' });
  await assert.rejects(worker.ensureWorker(71007, { branchName: 'dev/evan-7', turnId: 'new-turn' }), e => e.code === 'session_busy');
  assert.deepEqual(calls, [], 'never pushes over a different running turn');
});

test('an unavailable durable record prevents eviction instead of assuming there is nothing to rescue', async t => {
  withKubernetes(t);
  t.mock.method(db, 'getPool', () => ({ query: async () => { throw new Error('synthetic database outage'); } }));
  const remove = t.mock.method(kubernetes, 'deleteWorker', async () => { throw new Error('must not delete'); });
  await assert.rejects(worker.evictWorker(71004), /synthetic database outage/);
  assert.equal(remove.mock.callCount(), 0);
});

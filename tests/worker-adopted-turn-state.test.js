// The per-turn state a worker keeps only in this process's warm registry,
// put back when a restart's recovery adopts the turn.
//
// execInWorker records the turn's MODE (the Anthropic proxy reads it to bill
// a sync turn to the system budget instead of the owner), the commit a
// finished build could not PUSH (durably, for rescue before eviction),
// and a STOP asked for while it spun up. A restart empties the registry, so
// an adopted turn used to come back without them: its remaining sync calls
// billed the owner (and could switch to their own key), and an unpushed
// commit was deleted with the checkout by idle eviction ten minutes later.
// resumeTurnFromJournal now takes them from the durable record.
//
// Run with: node --test tests/worker-adopted-turn-state.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');
const workerGitPush = require('../src/services/worker-git-push');
const db = require('../src/db/pool');

const JOURNAL = '/home/node/.claude/turn-test.log';

function kubernetesRuntime(t, { token = 'fake-test-token' } = {}) {
  const prior = { runtime: process.env.WORKER_RUNTIME };
  process.env.WORKER_RUNTIME = 'kubernetes';
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [] }) }));
  // The push's GitHub credential: the App's installation token.
  const github = require('../src/services/github');
  t.mock.method(github, 'canActOn', () => true);
  t.mock.method(github, 'checkRepoPublic', async () => ({ ok: true, private: false }));
  t.mock.method(github, 'getInstallationToken', async () => token);
  t.after(() => {
    if (prior.runtime === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = prior.runtime;
  });
}

// Replays a journal that grows by one snapshot per poll; `onRead` runs after
// each read, while the replay is still in flight. Every other command the
// worker sends (a stop, a push) is recorded.
function journalWorker(t, snapshots, { onRead = () => {} } = {}) {
  t.mock.method(require('../src/services/turn-publication'), 'publish', async ({ result }) => result);
  const commands = [];
  let reads = 0;
  t.mock.method(kubernetes, 'execInWorker', async (_config, runtime, command, input) => {
    if (command[0] !== 'tail') {
      commands.push({ runtime, command, input });
      return { stdout: command[0] === 'bash' ? 'abc1234\n' : 'busy', stderr: '' };
    }
    const snapshot = snapshots[Math.min(reads, snapshots.length - 1)];
    reads += 1;
    onRead(reads);
    const fromLine = Number(String(command[2]).replace(/^\+/, ''));
    return { stdout: snapshot.split('\n').slice(fromLine - 1).join('\n'), stderr: '' };
  });
  t.mock.method(kubernetes, 'deleteWorker', async (_config, sessionId) => {
    commands.push({ deleted: sessionId });
  });
  return { commands, reads: () => reads };
}

async function replay(t, sessionId, snapshots, opts) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = worker.resumeTurnFromJournal(sessionId, { journal: JOURNAL, ...opts });
  for (let i = 0; i < snapshots.length + 2; i += 1) {
    await new Promise(setImmediate);
    t.mock.timers.tick(1000);
  }
  return pending;
}

test('an adopted sync turn reads as sync for the rest of its model calls', async (t) => {
  kubernetesRuntime(t);
  const sessionId = 72001;
  worker.adoptWarmWorker(sessionId, 'sv-worker-s72001');
  const modes = [];
  const snapshots = ['__USERNODE_WARN__ resolving\n', '__USERNODE_WARN__ resolving\n__USERNODE_EXIT__ 0\n'];
  journalWorker(t, snapshots, { onRead: () => modes.push(worker.getActiveTurnMode(sessionId)) });

  await replay(t, sessionId, snapshots, { mode: 'sync', branchName: 'dev/evan-1' });

  assert.ok(modes.length >= 1);
  assert.ok(modes.every((m) => m === 'sync'),
    'while the journal is followed the proxy sees a sync turn and bills the system budget');
  assert.equal(worker.getActiveTurnMode(sessionId), null, 'and nothing once the turn is over');
});

test('a replayed build whose push failed is pushed before eviction deletes it', async (t) => {
  kubernetesRuntime(t);
  const sessionId = 72002;
  worker.adoptWarmWorker(sessionId, 'sv-worker-s72002');
  const journal = 'x\n__USERNODE_RESULT__ cc_exit=0 ahead=1 sha=abcdef1 push_ok=0\n__USERNODE_EXIT__ 0\n';
  const fake = journalWorker(t, [journal]);
  let commit = null;
  t.mock.method(db, 'getPool', () => ({ query: async (sql, params) => {
    assert.equal(params[0], sessionId);
    if (sql.includes('INSERT INTO session_workers (session_id, unpushed_sha')) commit = { sha: params[1], branchName: params[2] };
    if (sql.includes('SELECT sw.unpushed_sha AS sha')) return { rows: commit?.sha ? [commit] : [] };
    if (sql.includes('UPDATE session_workers SET unpushed_sha = NULL')) commit = null;
    return { rows: [{ branch_name: 'dev/evan-2', repo_url: 'https://github.com/Trusted-Owner/stored-repo.git',
      unpushed_sha: commit?.sha, unpushed_branch_name: commit?.branchName }] };
  } }));
  t.mock.method(workerGitPush, 'push', async options => {
    assert.equal(options.remoteUrl, 'https://github.com/Trusted-Owner/stored-repo.git');
    assert.equal(options.branchName, 'dev/evan-2');
    assert.equal(options.token, 'fake-test-token');
    fake.commands.push({ trustedPush: true });
    await options.exportWorker('export Git objects only');
    return { sha: 'a'.repeat(40), stderr: '' };
  });

  const state = await replay(t, sessionId, [journal], { mode: 'build', branchName: 'dev/evan-2' });
  assert.equal(state.pushOk, false);
  assert.equal(state.sha, 'abcdef1');
  assert.deepEqual(commit, { sha: 'abcdef1', branchName: 'dev/evan-2' }, 'the adopted teardown records the commit durably');
  worker._registryForgetForTests(sessionId);

  await worker.evictWorker(sessionId);
  const pushAt = fake.commands.findIndex((c) => c.command && c.command[0] === 'sh');
  const deleteAt = fake.commands.findIndex((c) => c.deleted === sessionId);
  assert.ok(pushAt >= 0, 'the commit only the worker held is pushed');
  const trustedAt = fake.commands.findIndex(c => c.trustedPush);
  const execs = fake.commands.filter(c => c.command && c.command[0] === 'sh');
  assert.equal(execs.length, 2, 'export followed by credential-free tracking acknowledgement');
  assert.equal(execs[0].command[2], 'export Git objects only');
  assert.match(execs[1].command[2], /refs\/remotes\/origin\/dev\/evan-2/);
  for (const exec of execs) {
    assert.equal(exec.input, null);
    assert.equal(JSON.stringify(exec).includes('fake-test-token'), false);
  }
  assert.ok(trustedAt < pushAt && pushAt < deleteAt, 'trusted publication precedes worker deletion');
  assert.ok(fake.commands.indexOf(execs[1]) < deleteAt, 'tracking acknowledgement precedes deletion');
  assert.equal(commit, null, 'publication clears the durable record');
});

test('a replayed build that pushed, or a scout, leaves nothing to rescue', async (t) => {
  kubernetesRuntime(t);
  for (const [sessionId, mode, journal] of [
    [72003, 'build', '__USERNODE_RESULT__ cc_exit=0 ahead=1 sha=abcdef1 push_ok=1\n__USERNODE_EXIT__ 0\n'],
    [72004, 'scout', '__USERNODE_RESULT__ cc_exit=0 ahead=1 sha=abcdef1 push_ok=0\n__USERNODE_EXIT__ 0\n'],
  ]) {
    worker.adoptWarmWorker(sessionId, `sv-worker-s${sessionId}`);
    journalWorker(t, [journal]);
    // eslint-disable-next-line no-await-in-loop
    await replay(t, sessionId, [journal], { mode, branchName: 'dev/evan-3' });
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await worker.rescueUnpushedCommit(sessionId), { attempted: false }, mode);
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
});

test('a stop recorded before the restart is applied to the adopted turn', async (t) => {
  kubernetesRuntime(t);
  const sessionId = 72005;
  worker.adoptWarmWorker(sessionId, 'sv-worker-s72005');
  worker.clearPendingStop(sessionId);
  const stoppedAt = Date.parse('2026-10-14T10:00:00Z');
  const pending = [];
  const snapshots = ['line\n', 'line\n__USERNODE_EXIT__ 143\n'];
  const fake = journalWorker(t, snapshots, { onRead: () => pending.push(worker.getPendingStop(sessionId)) });

  await replay(t, sessionId, snapshots, { mode: 'build', branchName: 'dev/evan-5', stopRequestedAt: stoppedAt });

  assert.ok(pending.every((at) => at != null), 'the pending stop is on the adopted turn while it is followed');
  const kill = fake.commands.find((c) => c.command && c.command[0] === 'sh' && /__USERNODE_EXIT__ 143/.test(c.command[2]));
  assert.ok(kill, 'the kill the dead process may never have sent is sent');
  assert.match(kill.command[2], new RegExp(JOURNAL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
    'aimed at the adopted turn\'s own journal');
});

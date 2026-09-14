const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');

async function replay(t, snapshots, sessionId) {
  const previous = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = 'kubernetes';
  t.after(() => {
    if (previous === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = previous;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const progress = [];
  t.mock.method(kubernetes, 'execInWorker', async (_config, _runtime, command) => {
    if (command[0] !== 'cat') return { stdout: 'busy', stderr: '' };
    assert.ok(reads < snapshots.length, 'consumer must stop at the completed exit marker');
    const snapshot = snapshots[reads++];
    if (snapshot instanceof Error) throw snapshot;
    return { stdout: snapshot, stderr: '' };
  });
  let complete = false;
  const pending = worker.resumeTurnFromJournal(sessionId, {
    journal: '/home/node/.claude/turn-test.log', onProgress: line => progress.push(line),
  }).then(state => { complete = true; return state; });
  for (let i = 0; i < snapshots.length - 1; i++) {
    await new Promise(setImmediate);
    assert.equal(reads, i + 1);
    assert.equal(complete, false, 'a partial marker must not finish the turn');
    t.mock.timers.tick(1000);
  }
  return { state: await pending, progress };
}

test('Kubernetes journal preserves split JSON, Unicode and terminal markers', async (t) => {
  const result = JSON.stringify({ type: 'result', result: 'Finished: café 🚀', total_cost_usd: 0.25, session_id: 'claude-session' });
  const marker = '__USERNODE_RESULT__ cc_exit=0 ahead=1 sha=abcdef push_ok=1';
  const journal = `${result}\n${marker}\n__USERNODE_EXIT__ 0\n`;
  const { state } = await replay(t, [
    result.slice(0, 30),
    `${result}\n${marker.slice(0, 30)}`,
    `${result}\n${marker}\n__USERNODE_EXIT__`,
    journal,
  ], 70001);
  assert.equal(state.lastResultText, 'Finished: café 🚀');
  assert.equal(state.costUsd, 0.25);
  assert.equal(state.sessionId, 'claude-session');
  assert.equal(state.ahead, 1);
  assert.equal(state.sha, 'abcdef');
  assert.equal(state.pushOk, true);
  assert.equal(state.exitCode, 0);
  assert.equal(state.rawStdout, journal);
});

test('blank lines and a failed read do not replay previously delivered records', async (t) => {
  const prefix = '\n__USERNODE_WARN__ once\n\n';
  const journal = `${prefix}__USERNODE_EXIT__ 0\n`;
  const { state, progress } = await replay(t, [prefix, new Error('temporary read failure'), prefix, journal], 70002);
  assert.equal(progress.filter(line => line.includes('once')).length, 1);
  assert.equal(state.rawStdout, journal);
  assert.equal(state.exitCode, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');
const flush = () => new Promise(setImmediate);
let nextSession = 71000;

async function runWatchdog(t, { probes, stopped = false, terminalOnLastProbe = false, missingJournal = false, termination = null }) {
  const previous = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = 'kubernetes';
  t.after(() => {
    if (previous === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = previous;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const sessionId = nextSession++;
  let observed = 0;
  let terminal = false;
  t.mock.method(kubernetes, 'inspectWorkerTermination', async (_config, _name, { since }) => {
    assert.ok(Number.isFinite(new Date(since).getTime()));
    return termination;
  });
  t.mock.method(kubernetes, 'execInWorker', async (_config, name, command, _input, options) => {
    assert.equal(name, `sv-worker-s${sessionId}`);
    if (command[0] === 'cat') {
      if (terminal) return { stdout: '__USERNODE_EXIT__ 0\n', stderr: '' };
      if (missingJournal) throw new Error('journal does not exist');
      return { stdout: '', stderr: '' };
    }
    if (!command[2].startsWith('busy=0;')) return { stdout: '', stderr: '' }; // stop script
    assert.equal(options.timeoutMs, 15000);
    assert.ok(observed < probes.length, 'watchdog must stop within its strike budget');
    const probe = probes[observed++];
    if (terminalOnLastProbe && observed === probes.length) terminal = true;
    if (probe === null) throw new Error('probe unavailable');
    return { stdout: probe ? 'busy' : 'idle', stderr: '' };
  });
  let completed = false;
  const pending = worker.resumeTurnFromJournal(sessionId, { journal: '/home/node/.claude/turn-watchdog.log' })
    .then(state => { completed = true; return state; });
  await flush();
  if (stopped) await worker.stopTurn(sessionId);
  const interval = stopped ? 1000 : 10000;
  for (let i = 0; i < probes.length; i++) {
    assert.equal(completed, false, 'a transient failure or single idle must not abandon the turn');
    t.mock.timers.tick(interval);
    await flush();
    assert.equal(observed, i + 1);
  }
  assert.equal(completed, true, 'a dead turn must not wait for the 24-hour TTL');
  return pending;
}

for (const missingJournal of [false, true]) {
  test(`Kubernetes watchdog releases an idle worker with ${missingJournal ? 'no journal' : 'an empty journal'}`, async (t) => {
    const state = await runWatchdog(t, { probes: [false, false], missingJournal });
    assert.equal(state.exitCode, -1);
    assert.equal(state.markerlessCause, 'turn_process_gone');
  });
}

test('Kubernetes watchdog bounds consecutive unobservable probes', async (t) => {
  const state = await runWatchdog(t, { probes: Array(12).fill(null), missingJournal: true });
  assert.equal(state.markerlessCause, 'probe_unobservable');
});

test('a busy Kubernetes worker resets idle and failed-probe budgets', async (t) => {
  const state = await runWatchdog(t, { probes: [false, ...Array(11).fill(null), true, false, false] });
  assert.equal(state.markerlessCause, 'turn_process_gone');
});

test('stop requests tighten Kubernetes watchdog cadence and idle budget', async (t) => {
  const state = await runWatchdog(t, { probes: [false], stopped: true });
  assert.equal(state.markerlessCause, 'turn_process_gone');
});

test('a late terminal journal marker wins over watchdog abandonment', async (t) => {
  const state = await runWatchdog(t, { probes: [false, false], terminalOnLastProbe: true });
  assert.equal(state.execExitSeen, true);
  assert.equal(state.exitCode, 0);
  assert.equal(state.markerlessCause, null);
});

test('Kubernetes OOM evidence preserves the specific markerless cause', async t => {
  const state = await runWatchdog(t, { probes: [false, false], termination: { status: 'exited', oomKilled: true } });
  assert.equal(state.markerlessCause, 'oom_killed');
});

test('a missing Kubernetes Pod is reported as container gone', async t => {
  const state = await runWatchdog(t, { probes: Array(12).fill(null), termination: { status: 'gone', oomKilled: false } });
  assert.equal(state.markerlessCause, 'container_gone');
});

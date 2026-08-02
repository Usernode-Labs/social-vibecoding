// #889: the in-container stop procedure, and why it exists.
//
// The turn runs as a detached `docker exec` wrapper:
//   sh -c 'run-cc.sh > "$TURN_JOURNAL" 2>&1; echo "__USERNODE_EXIT__ $?" >> …'
// The kill walks /proc for anything matching (claude|run-cc.sh) — which
// includes that wrapper shell, since its cmdline contains the run-cc.sh
// path. So the wrapper dies before it can ever write its own exit marker,
// and the host-side journal consumer (a `tail -f` that never exits on its
// own) was left to discover the death via its 10s/2-strike liveness
// watchdog: a measured 18.8s of dead air in production between the click
// and the chat unwinding.
//
// stopTurn therefore writes the marker itself, and these tests pin the
// three properties that make that safe and fast:
//   1. ONE exec, and the order within it: TERM → wait → KILL → marker.
//      Killing before appending is what stops the marker interleaving with
//      a half-written agent line (the wrapper's stdout fd is gone by then).
//   2. The marker goes to the journal the host recorded for THIS turn, with
//      an in-container discovery fallback when the registry doesn't know it.
//   3. Feeding that marker through the real parseLine resolves the watch
//      state the same way a natural exit does.
//
// Run with: node --test tests/worker-stop-turn.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake docker + logger so no daemon is involved.
// Returns the module plus the recorded `docker.execFileAsync` calls.
function loadWorker() {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const realDocker = require('../src/services/docker');
  stub(ids.docker, {
    ...realDocker,
    execFileAsync: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { stdout: '', stderr: '' };
    },
  });
  const noop = () => {};
  stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });

  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
  };
  return { worker, calls, restore };
}

// ── The script the stop runs inside the container ───────────────────────

test('stop script: TERMs, waits, KILLs, then appends the exit marker', () => {
  const { worker, restore } = loadWorker();
  try {
    const script = worker.buildTurnStopScript('/home/node/.claude/turn-123.log');

    const term = script.indexOf('kill -TERM');
    const wait = script.indexOf('sleep 0.1');
    const kill = script.indexOf('kill -KILL');
    const marker = script.indexOf('__USERNODE_EXIT__ 143');

    assert.ok(term >= 0, 'sends SIGTERM');
    assert.ok(wait > term, 'waits for the SIGTERMed processes after signalling');
    assert.ok(kill > wait, 'escalates to SIGKILL only after the grace window');
    // THE ordering invariant: the marker must be written against a dead
    // turn, or it can interleave with agent output still being flushed.
    assert.ok(marker > kill, 'marker is appended last, after everything is dead');

    // Append, never truncate — a natural exit marker that landed first must
    // survive, and the tail stops at whichever came first either way.
    assert.match(script, /echo "__USERNODE_EXIT__ 143" >> "\$J"/);
    assert.ok(!script.includes('> "$J"\n'), 'never truncates the journal');
    // A stop must never fail loudly; the watchdog is behind it regardless.
    assert.match(script, /exit 0$/);
  } finally { restore(); }
});

test('stop script: targets the recorded journal path, guarded on existence', () => {
  const { worker, restore } = loadWorker();
  try {
    const script = worker.buildTurnStopScript('/home/node/.claude/turn-999.log');
    assert.match(script, /J='\/home\/node\/\.claude\/turn-999\.log'/);
    assert.match(script, /\[ -f "\$J" \]/, 'no marker if the journal vanished');
    assert.ok(!script.includes('ls -t'), 'no discovery needed when the path is known');
  } finally { restore(); }
});

test('stop script: discovers the journal in-container when the path is unknown', () => {
  const { worker, restore } = loadWorker();
  try {
    // An adopted worker after a platform restart has no registry journal.
    // The dispatch wrapper rm's stale journals first, so newest-wins is
    // unambiguous.
    const script = worker.buildTurnStopScript(null);
    assert.match(script, /J=\$\(ls -t \/home\/node\/\.claude\/turn-\*\.log 2>\/dev\/null \| head -1\)/);
    assert.match(script, /__USERNODE_EXIT__ 143/);
  } finally { restore(); }
});

// ── stopTurn's exec ─────────────────────────────────────────────────────

test('stopTurn issues exactly one docker exec carrying the stop script', async () => {
  const { worker, calls, restore } = loadWorker();
  try {
    await worker.stopTurn(4242);

    assert.equal(calls.length, 1, 'one exec — a stop is latency-critical');
    const { cmd, args, opts } = calls[0];
    assert.equal(cmd, 'docker');
    assert.equal(args[0], 'exec');
    assert.equal(args[1], 'usernode-worker-4242');
    assert.deepEqual(args.slice(2, 4), ['sh', '-c']);
    assert.match(args[4], /kill -TERM/);
    assert.match(args[4], /__USERNODE_EXIT__ 143/);
    // Must outlast the in-container SIGTERM grace, or the exec is cut off
    // before the marker is written and we're back to the 19s watchdog.
    assert.ok(opts.timeout >= 8000, `timeout ${opts.timeout} covers the kill grace`);
  } finally { restore(); }
});

test('stopTurn flags the session so the watchdog tightens its cadence', async () => {
  const { worker, restore } = loadWorker();
  try {
    const before = worker.warmRegistrySnapshot().find((e) => e.sessionId === 777);
    assert.ok(!before?.stopRequestedAt, 'precondition: no stop pending');

    await worker.stopTurn(777);

    const entry = worker.warmRegistrySnapshot().find((e) => e.sessionId === 777);
    assert.ok(entry, 'stopTurn registers the session');
    assert.ok(entry.stopRequestedAt > 0, 'stamped so _consumeJournal can read it');
  } finally { restore(); }
});

test('stopTurn swallows docker failures — the watchdog is the fallback', async () => {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  try {
    stub(ids.docker, {
      ...require('../src/services/docker'),
      execFileAsync: async () => { throw new Error('daemon unreachable'); },
    });
    const noop = () => {};
    stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });
    delete require.cache[ids.subject];
    const worker = require('../src/services/worker');

    await worker.stopTurn(5150); // must not throw

    // The flag is still set, so the 1s/1-strike watchdog bounds the wait
    // even though the marker never got written.
    const entry = worker.warmRegistrySnapshot().find((e) => e.sessionId === 5150);
    assert.ok(entry.stopRequestedAt > 0);
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
  }
});

// ── The marker, once the consumer reads it ──────────────────────────────

test('the appended marker resolves the watch state like a natural exit', () => {
  const worker = require('../src/services/worker');
  const state = worker.newWatchState();
  assert.equal(state.execExitSeen, false);

  worker.parseLine('__USERNODE_EXIT__ 143', () => {}, state);

  assert.equal(state.execExitSeen, true, 'consumer stops tailing immediately');
  assert.equal(state.exitCode, 143, '128 + SIGTERM — what a docker stop would have produced');
  // NOT a markerless turn: describeMarkerlessExit's "the agent was killed"
  // wording must never surface for a deliberate stop.
  assert.equal(state.markerlessCause, null);
});

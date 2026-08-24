// #1378: the stop registry moved out of src/routes/sessions.js into its own
// leaf service so BOTH the chat route and server.js's detached-turn recovery
// can register a handle for the session they own.
//
// The bug that forced the move (production session 3539): a turn adopted at
// a blue-green cutover was resumed by server.js, which could not reach the
// route module's private Map — routes → server is a require cycle — so no
// handle existed. POST /stop answered 'no active turn' while /status still
// said busy, and the red Stop button in front of the user did nothing for
// 36 minutes.
//
// These tests pin the three things the extraction has to get right: the
// registry is genuinely shared, deletes are identity-guarded (a late
// `finally` must not evict a NEWER turn's handle), and the session-state
// phase resolver is wired to it as a side effect of requiring the module.
//
// Run with: node --test tests/stop-registry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const stopRegistry = require('../src/services/stop-registry');
const sessionState = require('../src/services/session-state');

test.beforeEach(() => stopRegistry._reset());

test('createHandle fills the whole shape both call sites rely on', () => {
  const handle = stopRegistry.createHandle({ sessionId: 7, phase: 'cc', workerName: 'usernode-session-7' });

  assert.equal(handle.sessionId, 7);
  assert.equal(handle.phase, 'cc');
  assert.equal(handle.workerName, 'usernode-session-7');
  assert.equal(handle.stopped, false);
  assert.equal(handle.stoppedBy, null);
  assert.equal(handle.stopRequestedAt, null);
  assert.equal(handle.confirming, false);
  assert.ok(handle.abort instanceof AbortController, 'an abort controller is always present');
  // `send` is called unconditionally on the stop path; a missing one would
  // throw inside the handler rather than merely announcing nothing.
  assert.equal(typeof handle.send, 'function');
  assert.doesNotThrow(() => handle.send('status', {}));
});

test('the default phase is mayor1, which is stoppable', () => {
  const { killsWorkerInPhase } = require('../src/services/stop-policy');
  assert.equal(stopRegistry.createHandle({ sessionId: 1 }).phase, 'mayor1');
  assert.equal(killsWorkerInPhase(stopRegistry.createHandle({ sessionId: 1 }).phase), true);
});

test('a handle registered by one module is visible to another', () => {
  // The whole point of the extraction: server.js sets, the route gets.
  const handle = stopRegistry.createHandle({ sessionId: 3539, phase: 'cc' });
  stopRegistry.set(3539, handle);

  assert.equal(stopRegistry.get(3539), handle);
  // Ids arrive as strings from req.params and as numbers everywhere else.
  assert.equal(stopRegistry.get('3539'), handle);
  assert.equal(stopRegistry.get(3540), undefined);
});

test('deleteIf only removes the handle it was given', () => {
  const first = stopRegistry.createHandle({ sessionId: 12 });
  const second = stopRegistry.createHandle({ sessionId: 12 });
  stopRegistry.set(12, first);
  stopRegistry.set(12, second);

  // The first turn's `finally` runs late, after a newer turn already
  // registered. Evicting here would strand the new turn exactly as #1378
  // stranded the adopted one.
  assert.equal(stopRegistry.deleteIf(12, first), false);
  assert.equal(stopRegistry.get(12), second, "the newer turn's handle survives");

  assert.equal(stopRegistry.deleteIf(12, second), true);
  assert.equal(stopRegistry.get(12), undefined);
  // Idempotent: a double-clear (stop path + finally) must not throw.
  assert.equal(stopRegistry.deleteIf(12, second), false);
  assert.equal(stopRegistry.deleteIf(12, null), false);
  assert.equal(stopRegistry.deleteIf(12, undefined), false);
});

test('requiring the registry wires session-state phase/stopping to it', () => {
  const idle = sessionState.liveState(99);
  assert.equal(idle.phase, null);
  assert.equal(idle.stopping, false);

  const handle = stopRegistry.createHandle({ sessionId: 99, phase: 'cc' });
  stopRegistry.set(99, handle);
  assert.equal(sessionState.liveState(99).phase, 'cc');
  assert.equal(sessionState.liveState(99).stopping, false);

  handle.stopped = true;
  assert.equal(sessionState.liveState(99).stopping, true, 'a pending stop is broadcast live');

  handle.phase = 'mayor2';
  assert.equal(sessionState.liveState(99).phase, 'mayor2');

  stopRegistry.deleteIf(99, handle);
  assert.equal(sessionState.liveState(99).phase, null);
});

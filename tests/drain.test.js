'use strict';

// What a process a release replaced waits for before it exits
// (services/drain.js, docs/plans/draining-releases.md), and the registries
// whose keys are this process's holds (services/processes.js heldMap and
// heldSet): in memory, for its own drain, read by no other process. On a fake
// clock: nothing here waits for real.
//
// Run with: node --test tests/drain.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const drain = require('../src/services/drain');
const processes = require('../src/services/processes');

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += Math.max(1, ms); } };
}

test('the drain ends as soon as the process is idle', async () => {
  const c = clock();
  let polls = 0;
  const out = await drain.untilIdle({ deadline: c.now() + 60_000, idle: () => ++polls >= 3, ...c });
  assert.equal(out.reason, 'idle');
  assert.equal(polls, 3);
  assert.ok(out.waitedMs < 5000);
});

test('the drain ends at its deadline with work still held', async () => {
  const c = clock();
  const out = await drain.untilIdle({ deadline: c.now() + 30_000, idle: () => false, ...c });
  assert.equal(out.reason, 'deadline');
  assert.ok(out.waitedMs >= 30_000 && out.waitedMs < 31_000);
});

test('the drain ends early when too many newer processes drain too, asked every few seconds only', async () => {
  const c = clock();
  let asked = 0;
  const out = await drain.untilIdle({
    deadline: c.now() + 600_000, idle: () => false, supersedeEveryMs: 10_000,
    superseded: async () => { asked += 1; return asked >= 2; }, ...c,
  });
  assert.equal(out.reason, 'superseded');
  assert.equal(asked, 2);
  assert.ok(out.waitedMs >= 20_000 && out.waitedMs < 25_000, 'asked at 10s and 20s, not every poll');
});

test('a check that throws is neither idle nor superseded, and never ends the wait early', async () => {
  const c = clock();
  const out = await drain.untilIdle({
    deadline: c.now() + 15_000, idle: () => { throw new Error('boom'); },
    superseded: async () => { throw new Error('db down'); }, describe: () => { throw new Error('nope'); },
    reportEveryMs: 1000, ...c,
  });
  assert.equal(out.reason, 'deadline');
});

test('how many processes may drain at once comes from PLATFORM_DRAINING_MAX', () => {
  assert.equal(drain.drainingMax({}), drain.DEFAULT_DRAINING_MAX);
  assert.equal(drain.drainingMax({ PLATFORM_DRAINING_MAX: '0' }), 0);
  assert.equal(drain.drainingMax({ PLATFORM_DRAINING_MAX: '3' }), 3);
  assert.equal(drain.drainingMax({ PLATFORM_DRAINING_MAX: 'lots' }), drain.DEFAULT_DRAINING_MAX);
  assert.equal(drain.drainingMax({ PLATFORM_DRAINING_MAX: '-1' }), drain.DEFAULT_DRAINING_MAX);
});

test('a held Map holds each key until it is deleted, whatever is set under it meanwhile', () => {
  processes._reset();
  const m = processes.heldMap('agent_turn');
  m.set('7', { a: 1 });
  m.set('7', { a: 2 });
  assert.equal(processes.heldHere('agent_turn', 7), true);
  assert.equal(processes.localCount(), 1);
  assert.equal(m.delete('8'), false);
  assert.equal(m.delete('7'), true);
  assert.equal(processes.heldHere('agent_turn', 7), false);
  m.set('9', {}); m.set('10', {});
  m.clear();
  assert.equal(processes.localCount(), 0, 'clear releases every key');
});

test('a held Map can map its keys to refs, and a key with no ref is kept but holds nothing', () => {
  processes._reset();
  const m = processes.heldMap('agent_turn', (key) => String(key).split(':')[0]);
  m.set('42:abc', 1);
  m.set('42:def', 2);
  assert.equal(processes.heldHere('agent_turn', 42), true);
  m.delete('42:abc');
  assert.equal(processes.heldHere('agent_turn', 42), true, 'the other head still holds the session');
  m.delete('42:def');
  assert.equal(processes.heldHere('agent_turn', 42), false);
  const n = processes.heldMap('session', () => null);
  n.set('x', 1);
  assert.equal(n.get('x'), 1);
  assert.equal(processes.localCount(), 0);
});

test('a held Set holds what it contains', () => {
  processes._reset();
  const s = processes.heldSet('handoff');
  s.add('app-1'); s.add('app-1');
  assert.equal(processes.heldHere('handoff', 'app-1'), true);
  s.delete('app-1');
  assert.equal(processes.heldHere('handoff', 'app-1'), false);
});

test('what a session is doing here holds it, and isSessionBusyHere tells this process\'s part apart', () => {
  processes._reset();
  const aw = require('../src/services/active-workers');
  aw.activeWorkers.add(77);
  assert.equal(processes.heldHere('session', 77), true);
  assert.equal(aw.isSessionBusyHere(77), true);
  aw.activeWorkers.delete(77);
  const release = aw.beginSessionOperation(78);
  assert.equal(processes.heldHere('session', 78), true);
  release(); release();
  assert.equal(processes.heldHere('session', 78), false, 'an operation released twice releases its hold once');
  // What another process runs is read from the database, never from here.
  assert.equal(aw.isSessionBusyElsewhere, undefined);
  assert.equal(typeof aw.isSessionBusyAnywhere, 'function');
  assert.equal(processes.heldElsewhere, undefined);
  assert.equal(processes.holders, undefined);
});

test('a turn this process executes holds its session for as long as it is in flight, whatever started it', () => {
  processes._reset();
  const worker = require('../src/services/worker');
  worker._registryUpsertForTests(9101, { inFlight: true, activeTurnMode: 'shots' });
  assert.equal(processes.heldHere('session', 9101), true, 'the shots agent (or an eval trial) is seen like any turn');
  worker._registryUpsertForTests(9101, { lastUsedMs: Date.now() });
  assert.equal(processes.heldHere('session', 9101), true, 'a bookkeeping update keeps it');
  worker._registryUpsertForTests(9101, { inFlight: false });
  assert.equal(processes.heldHere('session', 9101), false, 'the exec ended');
  assert.equal(processes.localCount(), 0);
});

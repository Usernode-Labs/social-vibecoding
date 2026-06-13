// Tests for the journal liveness watchdog's strike accounting and the
// __USERNODE_WARN__ → onProgress forwarding (spurious "exited with code
// -1" fix). The strike policy is exercised through the pure helpers
// worker.js exports (newWatchdogCounters / recordWatchdogProbe), so no
// docker is involved.
//
// Run with: node --test tests/worker-watchdog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');
const log = require('../src/services/logger');

// ── Watchdog strike accounting ──────────────────────────────────────────

test('watchdog: three consecutive probe FAILURES (null) do not abandon', () => {
  const c = worker.newWatchdogCounters();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(worker.recordWatchdogProbe(c, null), { abandon: false, cause: null });
  }
  // This is exactly the sequence that used to kill healthy turns: the
  // old code counted nulls as idle strikes and gave up after two.
  assert.equal(c.probeFailures, 3);
  assert.equal(c.idleStrikes, 0);
});

test('watchdog: two consecutive definite idles abandon with turn_process_gone', () => {
  const c = worker.newWatchdogCounters();
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: false, cause: null });
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: true, cause: 'turn_process_gone' });
});

test('watchdog: twelve consecutive probe failures abandon with probe_unobservable', () => {
  const c = worker.newWatchdogCounters();
  let verdict;
  for (let i = 0; i < 11; i++) {
    verdict = worker.recordWatchdogProbe(c, null);
    assert.equal(verdict.abandon, false, `failure ${i + 1} must not abandon yet`);
  }
  verdict = worker.recordWatchdogProbe(c, null);
  assert.deepEqual(verdict, { abandon: true, cause: 'probe_unobservable' });
});

test('watchdog: a busy probe resets both counters', () => {
  const c = worker.newWatchdogCounters();
  worker.recordWatchdogProbe(c, false);
  for (let i = 0; i < 11; i++) worker.recordWatchdogProbe(c, null);
  assert.deepEqual(worker.recordWatchdogProbe(c, true), { abandon: false, cause: null });
  assert.equal(c.idleStrikes, 0);
  assert.equal(c.probeFailures, 0);
  // Fresh budget afterwards: a single idle is one strike, not two.
  assert.deepEqual(worker.recordWatchdogProbe(c, false), { abandon: false, cause: null });
});

test('watchdog: a definite idle ends the consecutive-failure run', () => {
  const c = worker.newWatchdogCounters();
  for (let i = 0; i < 11; i++) worker.recordWatchdogProbe(c, null);
  // The probe itself succeeded (it just saw idle) — failures reset.
  worker.recordWatchdogProbe(c, false);
  assert.equal(c.probeFailures, 0);
  assert.equal(c.idleStrikes, 1);
  // Interleaved idle/null never reaches either limit.
  assert.deepEqual(worker.recordWatchdogProbe(c, null), { abandon: false, cause: null });
});

test('newWatchState initializes markerlessCause to null', () => {
  const state = worker.newWatchState();
  assert.equal(state.markerlessCause, null);
});

// ── __USERNODE_WARN__ forwarding ────────────────────────────────────────

test('parseLine: __USERNODE_WARN__ forwards to onProgress with ⚠ prefix and still logs', () => {
  const progressLines = [];
  const warns = [];
  const origWarn = log.warn;
  log.warn = (cat, msg, data) => warns.push({ cat, msg, data });
  try {
    const state = worker.newWatchState();
    worker.parseLine(
      '__USERNODE_WARN__ resume failed (exit 2); retrying fresh',
      (t) => progressLines.push(t),
      state
    );
  } finally {
    log.warn = origWarn;
  }
  assert.deepEqual(progressLines, ['⚠ resume failed (exit 2); retrying fresh']);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].msg, 'resume failed (exit 2); retrying fresh');
});

test('parseLine: non-warn marker lines keep their existing behavior', () => {
  const progressLines = [];
  const state = worker.newWatchState();
  worker.parseLine('__USERNODE_EXIT__ 0', (t) => progressLines.push(t), state);
  assert.equal(state.execExitSeen, true);
  assert.equal(state.exitCode, 0);
  assert.deepEqual(progressLines, []);
});

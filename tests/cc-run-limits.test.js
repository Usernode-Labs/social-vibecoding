// Tests for token-optimization step 6 — per-dispatch Claude Code run
// limits (max-turns, timeout, cost ceiling) and the partial-completion
// signal parsing.
//
// Run with: node --test tests/cc-run-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');

test('ccRunLimitsForMode gives builds more room than scouts', () => {
  const build = worker.ccRunLimitsForMode('build');
  const scout = worker.ccRunLimitsForMode('scout');
  assert.ok(build.maxTurns > 0 && build.timeoutS > 0 && build.costCents > 0);
  assert.ok(scout.maxTurns > 0 && scout.timeoutS > 0 && scout.costCents > 0);
  // Builds > scouts on every ceiling — a read-only scout should never get
  // to burn as much as a full coding run.
  assert.ok(build.maxTurns > scout.maxTurns, 'build max-turns > scout');
  assert.ok(build.timeoutS > scout.timeoutS, 'build timeout > scout');
  assert.ok(build.costCents > scout.costCents, 'build cost ceiling > scout');
});

test('ccRunLimitsForMode returns no-limit zeros for sync and unknown modes', () => {
  for (const mode of ['sync', 'weird', undefined]) {
    const l = worker.ccRunLimitsForMode(mode);
    assert.deepEqual(l, { maxTurns: 0, timeoutS: 0, costCents: 0 });
  }
});

test('parseLine reads limit_hit from the RESULT line', () => {
  const state = worker.newWatchState();
  assert.equal(state.limitHit, null, 'defaults to null (natural finish)');

  worker.parseLine(
    '__USERNODE_RESULT__ cc_exit=0 ahead=1 behind=0 sha=abc push_ok=1 mode=build limit_hit=timeout',
    () => {}, state);
  assert.equal(state.limitHit, 'timeout');
  assert.equal(state.ccExit, 0, 'partial work reports a clean exit');
  assert.equal(state.pushOk, true, 'partial work was pushed');
});

test('parseLine leaves limit_hit null when the key is empty (natural finish)', () => {
  const state = worker.newWatchState();
  worker.parseLine(
    '__USERNODE_RESULT__ cc_exit=0 ahead=0 behind=0 sha=abc push_ok=1 mode=build limit_hit=',
    () => {}, state);
  assert.equal(state.limitHit, null);
});

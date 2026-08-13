'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const recoveryRetry = require('../src/services/recovery-retry');

function fakeTimers() {
  const queued = [];
  return {
    queued,
    setTimer(fn, delay) {
      const timer = { fn, delay, unref() {} };
      queued.push(timer);
      return timer;
    },
    clearTimer(timer) {
      const i = queued.indexOf(timer);
      if (i >= 0) queued.splice(i, 1);
    },
    async runNext() {
      const timer = queued.shift();
      assert.ok(timer, 'expected a queued retry timer');
      await timer.fn();
    },
  };
}

test('retryDelay backs off exponentially and respects its cap', () => {
  assert.equal(recoveryRetry.retryDelay(0, 10, 80), 10);
  assert.equal(recoveryRetry.retryDelay(1, 10, 80), 20);
  assert.equal(recoveryRetry.retryDelay(3, 10, 80), 80);
  assert.equal(recoveryRetry.retryDelay(20, 10, 80), 80);
});

test('failed durable cleanup becomes a retained retryable recovery error', () => {
  assert.equal(recoveryRetry.requireDurableTurnCleanup(true), true);
  assert.throws(
    () => recoveryRetry.requireDurableTurnCleanup(false, { journal: '/turn.log' }),
    (err) => {
      assert.equal(err?.code, 'recovery_cleanup_pending');
      assert.equal(err?.retainActiveTurn, true);
      assert.equal(err?.recoveryJournal, '/turn.log');
      assert.equal(recoveryRetry.isDurableTurnCleanupError(err), true);
      assert.equal(recoveryRetry.shouldRetryRecoveryError(err), true);
      return true;
    },
  );
});

test('a missing ledger attempt is a permanent recovery error', () => {
  const err = new Error('agent attempt not found');
  err.code = 'agent_attempt_not_found';
  assert.equal(recoveryRetry.isDurableTurnCleanupError(err), false);
  assert.equal(recoveryRetry.shouldRetryRecoveryError(err), false);
});

test('permanent recovery errors persist quarantine while transient errors only retain', async () => {
  const activeTurn = {
    turnId: 'logical-1', phase: 'tail_pending', journal: '/turn.log',
  };
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/SET active_turn = active_turn \|\|/.test(sql)) {
        return {
          rows: [{ active_turn: { ...activeTurn, ...JSON.parse(params[2]) } }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const transient = new Error('database unavailable');
  const retry = await recoveryRetry.retainOrQuarantineRecoveryError({
    pool, sessionId: 42, activeTurn, error: transient,
  });
  assert.equal(retry.action, 'retry');
  assert.equal(transient.retainActiveTurn, true);
  assert.equal(calls.length, 0, 'a transient failure does not mutate the replay phase');

  const permanent = new Error('attempt disappeared');
  permanent.code = 'agent_attempt_not_found';
  const quarantine = await recoveryRetry.retainOrQuarantineRecoveryError({
    pool, sessionId: 42, activeTurn, error: permanent,
  });
  assert.equal(quarantine.action, 'quarantine');
  assert.equal(permanent.retainActiveTurn, true);
  assert.equal(quarantine.activeTurn.phase, 'quarantined');
  assert.equal(quarantine.activeTurn.quarantineCode, 'agent_attempt_not_found');
  assert.equal(calls.length, 1);
});

test('retained recovery stays owned across failure and releases on success', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let holds = 0;
  let releases = 0;
  let completed = 0;
  const key = 'test:retry-success';

  assert.equal(recoveryRetry.scheduleRetainedRecovery({
    key,
    run: async () => {
      runs += 1;
      if (runs === 1) throw new Error('transient persist failure');
    },
    hold: () => { holds += 1; },
    release: () => { releases += 1; },
    onError: async () => true,
    onComplete: () => { completed += 1; },
    baseDelayMs: 10,
    maxDelayMs: 80,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  }), true);
  assert.equal(recoveryRetry.isScheduled(key), true);
  assert.equal(holds, 1, 'ownership is acquired while waiting for attempt one');

  await timers.runNext();
  assert.equal(runs, 1);
  assert.equal(holds, 2, 'ownership is reasserted before the next backoff');
  assert.equal(releases, 0, 'a retryable failure never releases ownership');
  assert.equal(timers.queued[0].delay, 20);

  await timers.runNext();
  assert.equal(runs, 2);
  assert.equal(releases, 1);
  assert.equal(completed, 1);
  assert.equal(recoveryRetry.isScheduled(key), false);
});

test('non-retryable recovery failure releases ownership without completing', async () => {
  const timers = fakeTimers();
  let releases = 0;
  let completed = 0;
  const key = 'test:retry-stop';
  recoveryRetry.scheduleRetainedRecovery({
    key,
    run: async () => { throw new Error('terminal'); },
    release: () => { releases += 1; },
    onError: async () => false,
    onComplete: () => { completed += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await timers.runNext();
  assert.equal(releases, 1);
  assert.equal(completed, 0);
  assert.equal(recoveryRetry.isScheduled(key), false);
});

test('invalid durable state cannot be retried even when the error hook asks to retry', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let errors = 0;
  let releases = 0;
  const key = 'test:invalid-durable-state';
  const invalid = new Error('ledger identity mismatch');
  invalid.code = 'recovery_retry_state_invalid';

  recoveryRetry.scheduleRetainedRecovery({
    key,
    run: async () => { runs += 1; throw invalid; },
    release: () => { releases += 1; },
    onError: async () => { errors += 1; return true; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await timers.runNext();
  assert.equal(runs, 1);
  assert.equal(errors, 1, 'the caller still gets a chance to terminalize visible state');
  assert.equal(releases, 1, 'the busy reservation is released');
  assert.equal(timers.queued.length, 0, 'no second attempt is armed');
  assert.equal(recoveryRetry.isScheduled(key), false);
});

test('a retained recovery key can only own one timer', () => {
  const timers = fakeTimers();
  const key = 'test:dedupe';
  const args = {
    key,
    run: async () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };
  assert.equal(recoveryRetry.scheduleRetainedRecovery(args), true);
  assert.equal(recoveryRetry.scheduleRetainedRecovery(args), false);
  assert.equal(timers.queued.length, 1);
  assert.equal(recoveryRetry.cancel(key), true);
});

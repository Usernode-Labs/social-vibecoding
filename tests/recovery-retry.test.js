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

// Sheep countrr's session 5030 (usernode-bot/sheep-countrr-a08857#48):
// a recovery that failed the same way every time was retried ~1,357 times
// over 23 hours, because nothing bounded the loop.
test('a retained recovery stops after maxFailures, runs onExhausted once, and releases', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let releases = 0;
  let completed = 0;
  const exhausted = [];
  const key = 'test:exhausted';
  recoveryRetry.scheduleRetainedRecovery({
    key,
    run: async () => { runs += 1; throw Object.assign(new Error('No commits between main and dev/x'), { code: 'no_commits' }); },
    release: () => { releases += 1; },
    onError: async () => true,
    onExhausted: async (err, info) => { exhausted.push({ code: err.code, ...info }); },
    onComplete: () => { completed += 1; },
    maxFailures: 3,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await timers.runNext();
  await timers.runNext();
  assert.equal(releases, 0, 'still owned while attempts remain');
  assert.equal(exhausted.length, 0);
  await timers.runNext();
  assert.equal(runs, 3);
  assert.deepEqual(exhausted, [{ code: 'no_commits', failures: 3, key }]);
  assert.equal(releases, 1, 'the reservation is released so the stale-turn watchdog can end the turn');
  assert.equal(completed, 0, 'giving up is not completing');
  assert.equal(timers.queued.length, 0, 'no further attempt is armed');
  assert.equal(recoveryRetry.isScheduled(key), false);
});

test('the default limit is far above an ordinary restart recovery and far below a day of retries', () => {
  assert.equal(recoveryRetry.DEFAULT_MAX_FAILURES, 30);
  let totalMs = 0;
  for (let failures = 0; failures < recoveryRetry.DEFAULT_MAX_FAILURES; failures += 1) {
    totalMs += recoveryRetry.retryDelay(failures, recoveryRetry.DEFAULT_BASE_DELAY_MS, recoveryRetry.DEFAULT_MAX_DELAY_MS);
  }
  assert.ok(totalMs > 20 * 60 * 1000 && totalMs < 30 * 60 * 1000, `about 25 minutes of retrying (${totalMs} ms)`);
});

test('an onExhausted hook that throws still releases the job', async () => {
  const timers = fakeTimers();
  let releases = 0;
  const hookErrors = [];
  const key = 'test:exhausted-hook-throws';
  recoveryRetry.scheduleRetainedRecovery({
    key,
    run: async () => { throw new Error('still failing'); },
    release: () => { releases += 1; },
    onExhausted: async () => { throw new Error('db down'); },
    onHookError: (err) => hookErrors.push(err.message),
    maxFailures: 1,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await timers.runNext();
  assert.equal(releases, 1);
  assert.deepEqual(hookErrors, ['db down']);
  assert.equal(recoveryRetry.isScheduled(key), false);
});

test('both retained-recovery schedulers terminalize what the user sees when they give up', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sessions = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  const orphan = server.slice(server.indexOf('function scheduleRetainedOrphanRecovery('),
    server.indexOf('function scheduleInteractiveTurnRecovery('));
  assert.match(orphan, /onExhausted: async \(err, \{ failures \}\) => \{\n\s+log\.error\('server', 'Retained orphan recovery gave up; leaving the turn to the stale-turn watchdog'/);
  const headless = sessions.slice(sessions.indexOf('function scheduleRetainedHeadlessRecovery('));
  assert.match(headless, /onExhausted: async \(err, \{ failures \}\) => \{[\s\S]{0,300}await failHeadlessRun\(/);
  // The watchdog ends an unowned turn, but never a quarantined one: giving
  // up must leave the turn in a phase it reaps.
  assert.doesNotMatch(orphan.slice(orphan.indexOf('onExhausted')), /markQuarantined/);
});

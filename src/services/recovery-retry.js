'use strict';

// Owns retry timers for recovery work whose active_turn must remain durable.
// The caller supplies the actual recovery function and busy-set hooks; this
// module only provides deduplication, exponential backoff, and the invariant
// that the session stays owned while it is waiting for the next attempt.

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60 * 1000;
const turnLifecycle = require('./turn-lifecycle');
const jobs = new Map();
const PERMANENT_RECOVERY_ERROR_CODES = new Set([
  'recovery_retry_state_invalid',
  'agent_attempt_not_found',
]);

function retryDelay(failures, baseDelayMs, maxDelayMs) {
  const exponent = Math.max(0, Math.min(Number(failures) || 0, 10));
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

// Durable identity mismatches cannot heal through backoff. Callers leave the
// active_turn in place as an operator-visible quarantine, but must not keep a
// session reservation or run the same failed recovery forever.
function shouldRetryRecoveryError(err) {
  return !PERMANENT_RECOVERY_ERROR_CODES.has(err?.code);
}

// Classify one failed durable recovery and persist the non-retryable branch.
// Retryable errors retain the existing phase/journal untouched. Permanent
// identity contradictions transition the exact owner to quarantined so the
// scheduler stops without making the record eligible for stale reaping.
async function retainOrQuarantineRecoveryError({
  pool,
  sessionId,
  activeTurn,
  error,
}) {
  const err = error instanceof Error ? error : new Error(String(error || 'recovery failed'));
  err.retainActiveTurn = true;
  if (shouldRetryRecoveryError(err)) {
    return { action: 'retry', error: err };
  }

  const identity = turnLifecycle.cleanupArgs(activeTurn);
  try {
    const transition = await turnLifecycle.markQuarantined(pool, {
      sessionId,
      ...identity,
      code: err.code || 'recovery_state_invalid',
    });
    return {
      action: 'quarantine',
      error: err,
      activeTurn: transition.activeTurn || activeTurn,
    };
  } catch (quarantineErr) {
    // If the quarantine write itself is unavailable, that failure can heal.
    // Keep ownership and let the scheduler retry rather than losing the
    // original durable pointer because a secondary write failed.
    quarantineErr.retainActiveTurn = true;
    throw quarantineErr;
  }
}

// finishTurn deliberately returns false (rather than deleting its journal)
// when the durable active_turn clear does not commit. Recovery callers must
// promote that result to a tagged failure so their scheduler keeps ownership
// and retries instead of reporting a completed recovery.
function requireDurableTurnCleanup(cleared, { journal = null } = {}) {
  if (cleared) return true;
  const err = new Error('durable recovered-turn cleanup did not commit');
  err.code = 'recovery_cleanup_pending';
  err.retainActiveTurn = true;
  err.recoveryJournal = journal;
  throw err;
}

function isDurableTurnCleanupError(err) {
  return err?.code === 'recovery_cleanup_pending';
}

function scheduleRetainedRecovery({
  key,
  run,
  hold = () => {},
  release = () => {},
  onError = async () => true,
  onComplete = () => {},
  onHookError = () => {},
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!key) throw new Error('recovery-retry: key required');
  if (typeof run !== 'function') throw new Error('recovery-retry: run required');
  if (jobs.has(key)) return false;

  const state = {
    key,
    failures: 0,
    timer: null,
    clearTimer,
    release,
    cancelled: false,
  };
  jobs.set(key, state);

  const safeCall = (fn, ...args) => {
    try { return fn(...args); } catch (err) {
      try { onHookError(err); } catch {}
      return undefined;
    }
  };

  const finish = (completed) => {
    if (jobs.get(key) !== state) return;
    jobs.delete(key);
    state.cancelled = true;
    if (state.timer != null) {
      try { state.clearTimer(state.timer); } catch {}
      state.timer = null;
    }
    safeCall(release);
    if (completed) safeCall(onComplete);
  };

  const arm = () => {
    if (state.cancelled) return;
    // The recovery function may use its own add/finally-delete busy wrapper.
    // Re-assert ownership after every failure and keep it through backoff so
    // the stale-turn watchdog cannot reap the state being retried.
    safeCall(hold);
    const delay = retryDelay(state.failures, baseDelayMs, maxDelayMs);
    state.timer = setTimer(runOnce, delay);
    state.timer?.unref?.();
  };

  async function runOnce() {
    if (state.cancelled) return;
    state.timer = null;
    try {
      await run();
      finish(true);
    } catch (err) {
      state.failures += 1;
      const retryable = shouldRetryRecoveryError(err);
      let retry = retryable;
      try {
        // Always run the hook so callers can terminalize user-visible state,
        // but a permanent durable-state error cannot be promoted back to a
        // retry even if the hook observes an active_turn and returns true.
        const requestedRetry = (await onError(err, { failures: state.failures, key })) !== false;
        retry = retryable && requestedRetry;
      } catch (hookErr) {
        safeCall(onHookError, hookErr);
        retry = retryable;
      }
      if (!retry) {
        finish(false);
        return;
      }
      arm();
    }
  }

  arm();
  return true;
}

function isScheduled(key) {
  return jobs.has(key);
}

function cancel(key) {
  const state = jobs.get(key);
  if (!state) return false;
  jobs.delete(key);
  state.cancelled = true;
  if (state.timer != null) {
    try { state.clearTimer(state.timer); } catch {}
  }
  try { state.release(); } catch {}
  return true;
}

module.exports = {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  retryDelay,
  shouldRetryRecoveryError,
  retainOrQuarantineRecoveryError,
  requireDurableTurnCleanup,
  isDurableTurnCleanupError,
  scheduleRetainedRecovery,
  isScheduled,
  cancel,
};

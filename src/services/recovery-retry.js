'use strict';

// What a recovery that keeps a turn's durable record does with an error:
// whether trying again could help (shouldRetryRecoveryError), quarantining a
// record whose identity cannot heal (retainOrQuarantineRecoveryError), the
// cleanup it insists on (requireDurableTurnCleanup), and saying it gave up
// (recordGaveUp). Who tries again is the turn's work item, in whichever
// workflow process runs it (services/turns.js RECOVERY_RETRY), not a timer
// in one process.

const turnLifecycle = require('./turn-lifecycle');
const PERMANENT_RECOVERY_ERROR_CODES = new Set([
  'recovery_retry_state_invalid',
  'agent_attempt_not_found',
]);

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

// Say that a retained recovery was given up on (events
// 'turn_recovery_gave_up'): until this, giving up was a log line, and an
// interrupted turn nothing could pick up again was found by its owner. The
// platform signals file a request for them (signal-observers/
// turn-recovery.js). The key is `<recovery>:<session id>` (services/turns.js:
// `interactive:` for a coding run, `headless:`). Written to `pool`, or the
// process's shared pool (db/pool.js) when the caller passes none. Never
// throws, and never waits: what the user sees is terminalized either way.
function recordGaveUp({ pool = null, key, err, failures }) {
  try {
    const events = require('./events');
    const m = /^([a-z][a-z0-9_-]*):(\d+)$/i.exec(String(key));
    const id = m ? Number(m[2]) : 0;
    const sessionId = Number.isSafeInteger(id) && id > 0 ? id : null;
    // An error's code is the platform's own word for it (no_commits,
    // recovery_cleanup_pending, ECONNRESET), never its message.
    const code = err?.code == null ? null : String(err.code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) || null;
    events.record(pool || undefined, {
      type: events.EVENT_TYPES.TURN_RECOVERY_GAVE_UP,
      sessionId,
      metadata: { sessionId, recovery: m ? m[1].toLowerCase() : null, code, failures: Number(failures) || 0 },
    });
  } catch { /* a record is a help; giving up still happens */ }
}

module.exports = {
  shouldRetryRecoveryError,
  retainOrQuarantineRecoveryError,
  requireDurableTurnCleanup,
  isDurableTurnCleanupError,
  recordGaveUp,
};

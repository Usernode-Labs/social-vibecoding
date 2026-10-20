'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const recoveryRetry = require('../src/services/recovery-retry');

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

test('who tries a retained recovery again is the turn\'s work item, not a timer in one process', () => {
  // services/turns.js: a coding run's recovery and a headless run are tried
  // again inside their item, bounded (RECOVERY_RETRY), and a give-up is
  // recorded as it was (recordGaveUp, whose signal files a request).
  assert.deepEqual(Object.keys(recoveryRetry).sort(), [
    'isDurableTurnCleanupError', 'recordGaveUp', 'requireDurableTurnCleanup',
    'retainOrQuarantineRecoveryError', 'shouldRetryRecoveryError',
  ]);
  const turns = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'turns.js'), 'utf8');
  assert.match(turns, /recordGaveUp\(\{ pool, key: `interactive:\$\{Number\(sessionId\)\}`, err, failures: tried \}\)/);
  assert.match(turns, /recordGaveUp\(\{ pool, key: `headless:\$\{Number\(sessionId\)\}`, err, failures: tried \}\)/);
});

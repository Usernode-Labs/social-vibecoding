'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/services/turn-lifecycle');

function makeDb(initial = null) {
  let activeTurn = initial;
  const calls = [];
  return {
    calls,
    get activeTurn() { return activeTurn; },
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/SELECT active_turn/.test(text)) return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      if (/SET active_turn = \$2::jsonb/.test(text)) {
        const allow = /active_turn IS NULL/.test(text)
          ? activeTurn == null
          : activeTurn != null && (
            String(activeTurn.turnId || '') === String(params[2] || '')
            || String(activeTurn.journal || '') === String(params[2] || '')
          );
        if (!allow) return { rows: [], rowCount: 0 };
        activeTurn = JSON.parse(params[1]);
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      if (/SET headless_status = \$4/.test(text)) {
        const same = activeTurn && (
          String(activeTurn.turnId || '') === String(params[1] || '')
          || String(activeTurn.journal || '') === String(params[1] || '')
        );
        if (!same) return { rows: [], rowCount: 0 };
        activeTurn = { ...activeTurn, ...JSON.parse(params[2]) };
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      if (/SET active_turn = active_turn \|\|/.test(text)) {
        const same = activeTurn && (
          String(activeTurn.turnId || '') === String(params[1] || '')
          || String(activeTurn.journal || '') === String(params[1] || '')
        );
        const phases = params[3] || null;
        const currentPhase = lifecycle.phaseOf(activeTurn);
        // #1378: markStopRequested's "first stop wins" guard.
        const stopGuard = /stopRequestedAt' IS NULL/.test(text)
          && activeTurn && activeTurn.stopRequestedAt;
        if (!same || stopGuard || (phases && !phases.includes(currentPhase))) {
          return { rows: [], rowCount: 0 };
        }
        activeTurn = { ...activeTurn, ...JSON.parse(params[2]) };
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      if (/jsonb_set\(\s*active_turn, '\{tail\}'/.test(text)) {
        const same = activeTurn && (
          String(activeTurn.turnId || '') === String(params[2] || '')
          || String(activeTurn.journal || '') === String(params[2] || '')
        );
        if (!same || !(params[3] || []).includes(lifecycle.phaseOf(activeTurn))) {
          return { rows: [], rowCount: 0 };
        }
        activeTurn = {
          ...activeTurn,
          tail: { ...(activeTurn.tail || {}), ...JSON.parse(params[1]) },
        };
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      if (/jsonb_set\(\s*active_turn, '\{byokCents\}'/.test(text)) {
        const same = activeTurn
          && String(activeTurn.turnId || '') === String(params[2] || '');
        if (!same || !(params[3] || []).includes(lifecycle.phaseOf(activeTurn))) {
          return { rows: [], rowCount: 0 };
        }
        activeTurn = {
          ...activeTurn,
          byokCents: Number(activeTurn.byokCents || 0) + Number(params[0]),
        };
        return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
      }
      if (/SET active_turn = NULL/.test(text)) {
        const same = activeTurn && (
          String(activeTurn.turnId || '') === String(params[1] || '')
          || String(activeTurn.journal || '') === String(params[1] || '')
        );
        if (!same || lifecycle.phaseOf(activeTurn) !== lifecycle.PHASE_CLEANUP_PENDING) {
          return { rows: [], rowCount: 0 };
        }
        activeTurn = null;
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

test('new records receive a stable identity and explicit dispatch phase', async () => {
  const db = makeDb();
  const turn = await lifecycle.persistNewTurn(db, 42, {
    mode: 'build', journal: '/turn-a.log', backend: 'claude_code',
  });
  assert.match(turn.turnId, /^[0-9a-f-]{36}$/);
  assert.equal(turn.phase, lifecycle.PHASE_DISPATCH_PENDING);
  assert.equal(db.activeTurn.turnId, turn.turnId);
});

test('the durable path reaches cleanup and clearing is idempotent', async () => {
  const db = makeDb({
    turnId: 'turn-a', phase: 'dispatch_pending', journal: '/turn-a.log',
  });
  await lifecycle.markExecuting(db, { sessionId: 42, turnId: 'turn-a' });
  await lifecycle.markTailPending(db, { sessionId: 42, turnId: 'turn-a' });
  await lifecycle.markCleanupPending(db, { sessionId: 42, turnId: 'turn-a' });
  assert.equal(lifecycle.recoveryAction(db.activeTurn), 'cleanup');
  assert.deepEqual(
    await lifecycle.clearCleanupPending(db, { sessionId: 42, turnId: 'turn-a' }),
    { cleared: true },
  );
  assert.equal(db.activeTurn, null);
  assert.deepEqual(
    await lifecycle.clearCleanupPending(db, { sessionId: 42, turnId: 'turn-a' }),
    { cleared: true, alreadyCleared: true },
  );
});

test('cleanup from an older owner cannot clear a replacement turn', async () => {
  const db = makeDb({
    turnId: 'turn-b', phase: 'cleanup_pending', journal: '/turn-b.log',
  });
  await assert.rejects(
    lifecycle.clearCleanupPending(db, { sessionId: 42, turnId: 'turn-a' }),
    (err) => err?.code === 'stale_turn_owner' && err.currentTurnId === 'turn-b',
  );
  assert.equal(db.activeTurn.turnId, 'turn-b');
});

test('recovery action is entirely derivable after any number of restarts', () => {
  const serialized = JSON.stringify({
    turnId: 'turn-a', phase: 'cleanup_pending', journal: '/turn-a.log',
  });
  assert.equal(lifecycle.recoveryAction(serialized), 'cleanup');
  assert.equal(lifecycle.recoveryAction(JSON.parse(serialized)), 'cleanup');
  assert.equal(lifecycle.recoveryAction({ turnId: 'turn-a', phase: 'tail' }), 'resume');
  assert.equal(lifecycle.recoveryAction({ turnId: 'turn-a', phase: 'quarantined' }), 'quarantine');
});

test('an invalid phase transition fails closed without mutating state', async () => {
  const db = makeDb({ turnId: 'turn-a', phase: 'cleanup_pending' });
  await assert.rejects(
    lifecycle.markExecuting(db, { sessionId: 42, turnId: 'turn-a' }),
    (err) => err?.code === 'invalid_turn_transition',
  );
  assert.equal(db.activeTurn.phase, 'cleanup_pending');
});

test('permanent recovery contradictions quarantine the exact durable owner', async () => {
  const db = makeDb({
    turnId: 'turn-a', phase: 'tail_pending', journal: '/turn-a.log',
  });
  const result = await lifecycle.markQuarantined(db, {
    sessionId: 42,
    turnId: 'turn-a',
    code: 'agent_attempt_not_found',
  });
  assert.equal(result.transitioned, true);
  assert.equal(db.activeTurn.phase, 'quarantined');
  assert.equal(db.activeTurn.quarantineCode, 'agent_attempt_not_found');
  assert.ok(db.activeTurn.quarantinedAt);
  assert.equal(lifecycle.recoveryAction(db.activeTurn), 'quarantine');

  await assert.rejects(
    lifecycle.markQuarantined(db, {
      sessionId: 42,
      turnId: 'turn-old',
      code: 'agent_attempt_not_found',
    }),
    (err) => err?.code === 'stale_turn_owner',
  );
  assert.equal(db.activeTurn.turnId, 'turn-a');
});

test('headless terminal publication atomically enters cleanup_pending', async () => {
  const db = makeDb({
    turnId: 'turn-a', phase: 'tail_pending', journal: '/turn-a.log',
  });
  const activeTurn = await lifecycle.markHeadlessTerminal(db, {
    sessionId: 42,
    turnId: 'turn-a',
    status: 'ready',
    outcome: 'code',
  });
  assert.equal(activeTurn.phase, 'cleanup_pending');
  const update = db.calls.find((call) => /SET headless_status = \$4/.test(call.sql));
  assert.deepEqual(update.params.slice(3, 5), ['ready', 'code']);
  assert.match(update.sql, /headless_turn_id = NULL/);
});

test('tail milestones merge only onto the exact tail owner', async () => {
  const db = makeDb({
    turnId: 'turn-a', phase: 'tail_pending', journal: '/turn-a.log', tail: { pushOk: true },
  });
  const merged = await lifecycle.mergeTailMilestones(db, {
    sessionId: 42,
    turnId: 'turn-a',
    milestones: { wrapUpPosted: true },
  });
  assert.equal(merged.updated, true);
  assert.deepEqual(db.activeTurn.tail, { pushOk: true, wrapUpPosted: true });

  await assert.rejects(
    lifecycle.mergeTailMilestones(db, {
      sessionId: 42,
      turnId: 'turn-old',
      milestones: { completionRowPosted: true },
    }),
    (err) => err?.code === 'stale_turn_owner',
  );
  assert.equal(db.activeTurn.tail.completionRowPosted, undefined);
});

test('delayed BYOK accounting cannot mutate a replacement turn', async () => {
  const db = makeDb({
    turnId: 'turn-new', phase: 'executing', byokCents: 4,
  });
  const stale = await lifecycle.incrementByokCents(db, {
    sessionId: 42, turnId: 'turn-old', cents: 7,
  });
  assert.equal(stale.updated, false);
  assert.equal(db.activeTurn.byokCents, 4);

  const owned = await lifecycle.incrementByokCents(db, {
    sessionId: 42, turnId: 'turn-new', cents: 7,
  });
  assert.equal(owned.updated, true);
  assert.equal(db.activeTurn.byokCents, 11);
});

// #1378: a turn adopted after a platform restart has no in-process stop
// handle, so "the user asked for this to end" has to survive the restart
// somewhere. It lives on the active_turn record: the recovery path reads it
// back when it re-adopts the turn, and answers the stop instead of narrating
// an interruption and retrying.
test('a stop request is stamped onto the turn that owns the session', async () => {
  const db = makeDb({ turnId: 'turn-a', phase: 'executing', journal: '/turn-a.log' });

  const res = await lifecycle.markStopRequested(db, {
    sessionId: 42, turnId: 'turn-a', by: 'evan',
  });

  assert.equal(res.updated, true);
  assert.equal(db.activeTurn.stopRequestedBy, 'evan');
  assert.ok(db.activeTurn.stopRequestedAt, 'a timestamp is recorded');
  // Deliberately NOT a phase move: stopping is an intent recorded against
  // whatever phase the turn is in; the phase machine keeps running until the
  // turn actually unwinds.
  assert.equal(db.activeTurn.phase, 'executing');

  const read = lifecycle.stopRequestOf(db.activeTurn);
  assert.equal(read.by, 'evan');
  assert.equal(read.at, db.activeTurn.stopRequestedAt);
  assert.equal(typeof read.atMs, 'number');
});

test('the first stop wins — a repeat request cannot move the clock', async () => {
  const db = makeDb({ turnId: 'turn-a', phase: 'executing' });
  const first = await lifecycle.markStopRequested(db, {
    sessionId: 42, turnId: 'turn-a', by: 'evan',
  });
  const stampedAt = db.activeTurn.stopRequestedAt;

  // The client's ladder silently re-POSTs at 15s. Rewriting the timestamp
  // there would restart the escalation and Force stop would never arrive.
  const second = await lifecycle.markStopRequested(db, {
    sessionId: 42, turnId: 'turn-a', by: 'someone-else',
  });

  assert.equal(first.updated, true);
  assert.equal(second.updated, false);
  assert.equal(db.activeTurn.stopRequestedAt, stampedAt);
  assert.equal(db.activeTurn.stopRequestedBy, 'evan');
  // A miss still hands back the current record, so the caller can read the
  // stamp that IS there rather than re-querying.
  assert.equal(lifecycle.stopRequestOf(second.activeTurn).by, 'evan');
});

test('a stop stamp never lands on a replacement turn', async () => {
  const db = makeDb({ turnId: 'turn-new', phase: 'executing' });

  const res = await lifecycle.markStopRequested(db, {
    sessionId: 42, turnId: 'turn-old', by: 'evan',
  });

  assert.equal(res.updated, false);
  assert.equal(db.activeTurn.stopRequestedAt, undefined, 'the live turn is untouched');
  assert.equal(lifecycle.stopRequestOf(db.activeTurn), null);
});

test('markStopRequested is a quiet no-op when the turn is already gone', async () => {
  const db = makeDb(null);
  const res = await lifecycle.markStopRequested(db, {
    sessionId: 42, turnId: 'turn-a', by: 'evan',
  });
  // Not a throw: a stop for a turn that just finished is ordinary, and the
  // route answers it politely rather than 500ing.
  assert.equal(res.updated, false);
  assert.equal(res.activeTurn, null);
});

test('stopRequestOf tolerates every shape the caller can hand it', () => {
  assert.equal(lifecycle.stopRequestOf(null), null);
  assert.equal(lifecycle.stopRequestOf(undefined), null);
  assert.equal(lifecycle.stopRequestOf('turn-a'), null);
  assert.equal(lifecycle.stopRequestOf({ phase: 'executing' }), null);
  // An unparsable timestamp still counts as "a stop was requested" — the
  // intent is the load-bearing part; atMs is only the ladder's anchor.
  const odd = lifecycle.stopRequestOf({ stopRequestedAt: 'not-a-date' });
  assert.equal(odd.atMs, null);
  assert.equal(odd.by, null);
});

test('a stopped turn is still a RECOVERABLE phase', () => {
  // The recovery path must ADOPT such a turn (to answer the stop), not skip
  // it — skipping would leave the agent running with nothing watching it.
  assert.equal(lifecycle.RECOVERABLE_PHASES.has('executing'), true);
  assert.equal(lifecycle.RECOVERABLE_PHASES.has('tail_pending'), true);
  assert.equal(lifecycle.RECOVERABLE_PHASES.has('quarantined'), false);
});

'use strict';

const { withSessionLock } = require('../db/session-locks');
const { WORKER_EVICTION_LOCK } = require('./advisory-locks');
const { stopTarget, sameScope, sameTurn } = require('../workflow/worker-stop/target.ts');
const turnLifecycle = require('./turn-lifecycle');
const log = require('./logger');

function workflowOnly() {
  const role = require('./process-role');
  if (!role.runsWorkflow(role.processRole())) throw Object.assign(new Error('Worker interruption requires a workflow process'), { code: 'workflow_role_required' });
}

// One signal, probe or legacy runtime stop. The machine owns confirmation's
// attempts and timers; no handle or local loop is needed on this process.
async function perform(pool, { target, action }, { renew, signal }) {
  workflowOnly();
  const worker = require('./worker');
  let lost = false;
  const checkpoint = async () => {
    if (lost || signal.aborted) throw new Error('Worker interruption lost its lock or claim');
    await renew();
    if (lost || signal.aborted) throw new Error('Worker interruption lost its lock or claim');
  };
  return withSessionLock(pool, [WORKER_EVICTION_LOCK, target.sessionId], async () => {
    const check = async () => {
      await checkpoint();
      const current = await stopTarget(pool, target.sessionId, target.userId);
      if (!sameScope(current, target)) return { done: true, confirmed: false, reason: 'not_authorized' };
      if (target.active && !current.active) return { done: true, confirmed: true, reason: 'ended' };
      if (!sameTurn(current, target)) return { done: true, confirmed: false, reason: 'turn_changed' };
      if (Date.now() >= target.expiresAt) return { done: true, confirmed: false, reason: 'giveup' };
      await checkpoint();
      return { current };
    };
    const before = await check();
    if (before.done) return before;
    if (action !== 'probe' && before.current.active) {
      const by = target.userId === null ? target.by ?? null : before.current.username;
      if (target.turnId || target.journal) {
        await turnLifecycle.markStopRequested(pool, {
          sessionId: target.sessionId, ...turnLifecycle.cleanupArgs(before.current.turn), by,
        });
      } else {
        await pool.query(`UPDATE chat_sessions SET active_turn = active_turn || $3::jsonb
          WHERE id = $1 AND active_turn = $2::jsonb AND active_turn->>'stopRequestedAt' IS NULL`,
        [target.sessionId, JSON.stringify(before.current.turn), JSON.stringify({ stopRequestedAt: new Date().toISOString(), stopRequestedBy: by })]);
      }
      const stamped = await check();
      if (stamped.done) return stamped;
    }
    if (Date.now() >= target.expiresAt) return { done: true, confirmed: false, reason: 'giveup' };
    const remaining = () => Math.max(1, target.expiresAt - Date.now());
    if (action === 'runtime') {
      let declined;
      const mayStop = async () => {
        const out = await check();
        if (out.done) { declined = out; return false; }
        if (Date.now() >= target.expiresAt) { declined = { done: true, confirmed: false, reason: 'giveup' }; return false; }
        return true;
      };
      const out = await worker.stopWorkerByIdentity(target.sessionId, {
        waitMs: remaining(), pollMs: 250, renew: checkpoint,
        proceed: async () => {
          if (!(await mayStop())) return false;
          await worker.rescueUnpushedCommit(target.sessionId, { turnId: target.turnId, forTurnStart: true });
          return mayStop();
        },
      });
      return out.skipped ? declined : { done: true, confirmed: true, reason: 'runtime_stopped' };
    }
    if (!before.current.active) return { done: true, confirmed: true, reason: 'no_turn' };
    if (action === 'signal') {
      if (target.journal) {
        await worker.stopTurnByJournal(target.sessionId, target.journal, { force: false, timeoutMs: Math.min(30000, remaining()) });
      } else {
        // Legacy records have no journal fence. Retain their existing
        // signal behavior under the current-job and startup-lock checks.
        await worker.signalLegacyTurn(target.sessionId, { timeoutMs: Math.min(30000, remaining()) });
      }
      const after = await check();
      return after.done ? after : { signalled: true };
    }
    if (action !== 'probe') throw new Error('Unknown worker interruption action');
    const executing = await worker.isWorkerExecuting(worker.workerRuntimeName(target.sessionId), { timeoutMs: Math.min(8000, remaining()) });
    const after = await check();
    return after.done ? after : { executing };
  }, { onLost: () => { lost = true; } });
}

// Retry-time cancellation is already owned by the running conductor turn.
// Keep its existing bounded idle wait here, outside the HTTP module.
async function waitForTurnStopped(sessionId, containerName, { timeoutMs = 30000 } = {}) {
  try { workflowOnly(); } catch {
    log.warn('worker-stop', 'Retry idle wait skipped outside the conductor', { sessionId });
    return false;
  }
  const worker = require('./worker');
  try { await worker.stopTurn(sessionId); } catch {}
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await worker.isWorkerExecuting(containerName).catch(() => null);
    if (busy === false) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 2000));
  }
}

// A classic dispatch can cross Stop before its record exists. Its owning
// conductor supplies the actual new record, never a session-wide retarget.
async function confirmDispatchedStop(pool, { sessionId, turnId, journal, by = null }) {
  workflowOnly();
  return require('../workflow/worker-stop/interrupt.ts').appendWorkerInterrupt(pool, {
    sessionId, turnId, journal, by,
  });
}

module.exports = { perform, waitForTurnStopped, confirmDispatchedStop };

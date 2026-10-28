'use strict';

// The conductor's force-stop fallback. No web-side runtime fallback: a
// request always names the job it saw, and retries never retarget a worker.
const { setTimeout: sleep } = require('node:timers/promises');
const { withSessionLock } = require('../db/session-locks');
const { WORKER_EVICTION_LOCK } = require('./advisory-locks');
const { stopTarget, sameScope, sameTurn } = require('../workflow/worker-stop/target.ts');
const worker = require('./worker');
const turnLifecycle = require('./turn-lifecycle');
const agentTurn = require('./agent-turn');
const recoveryRetry = require('./recovery-retry');
const log = require('./logger');

const changed = () => Object.assign(new Error('The running job changed. Retry Stop.'), { code: 'turn_changed' });
const unconfirmed = () => Object.assign(new Error('Could not confirm that the coding job stopped. Retry Stop.'), { code: 'stop_unconfirmed' });

async function settle(pool, target, check) {
  let current = await check();
  if (!current.active) return false;
  const activeTurn = current.turn;
  if (activeTurn.backend === 'codex_openrouter' && activeTurn.turnUuid) {
    let attempt = await agentTurn.getCodexAttemptRecoveryState({ pool, turnUuid: activeTurn.turnUuid });
    if (attempt?.status === 'running') {
      await sleep(250); await check();
      attempt = await agentTurn.getCodexAttemptRecoveryState({ pool, turnUuid: activeTurn.turnUuid });
    }
    if (attempt?.status === 'running' || !attempt) {
      await check();
      try {
        await agentTurn.completeCodexAttempt({
          pool, turnUuid: activeTurn.turnUuid, status: 'cancelled', errorCode: 'user_cancelled',
          errorDetail: 'Turn was force-stopped by the user.',
          telemetryComponent: turnLifecycle.phaseOf(activeTurn) === turnLifecycle.PHASE_DISPATCH_PENDING ? null : activeTurn.telemetryComponent || null,
          telemetryMetrics: {
            requestMode: activeTurn.telemetryRequestMode || null,
            requestMessageCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
            requestUserMessageCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
            requestContentBlockCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
            requestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
            requestUserTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
            requestPayloadCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
            modelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
            modelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
          },
        });
      } catch (err) {
        await check();
        await recoveryRetry.retainOrQuarantineRecoveryError({ pool, sessionId: target.sessionId, activeTurn, error: err });
        log.warn('worker-stop', 'Retained a stopped turn whose ledger could not be settled', { sessionId: target.sessionId, code: err.code });
        return true;
      }
    }
  }
  current = await check();
  if (!current.active) return false;
  return !(await worker.clearActiveTurn(target.sessionId, turnLifecycle.cleanupArgs(activeTurn)));
}

async function run(pool, target, { renew = async () => {}, signal = null } = {}) {
  const role = require('./process-role');
  if (!role.runsWorkflow(role.processRole())) throw new Error('Worker stops require a workflow process');
  let lost = false; let removed = false;
  const checkpoint = async () => {
    if (lost || signal?.aborted) throw new Error('Worker stop lost its claim or session lock');
    await renew();
    if (lost || signal?.aborted) throw new Error('Worker stop lost its claim or session lock');
  };
  return withSessionLock(pool, [WORKER_EVICTION_LOCK, target.sessionId], async () => {
    const check = async () => {
      await checkpoint();
      const current = await stopTarget(pool, target.sessionId, target.userId);
      if (!sameScope(current, target)) throw Object.assign(new Error('Session not found'), { code: 'not_authorized' });
      if (!(target.active && !current.active) && !sameTurn(current, target, removed)) throw changed();
      await checkpoint();
      return current;
    };
    let current = await check();
    if (target.active && !current.active) return { ok: true, stopped: true };
    if (Date.now() >= target.expiresAt) throw unconfirmed();
    // The force-orphan path need not have passed through an ordinary stop.
    // A restart after signalling must still recover this as a user's stop.
    if (current.active) {
      await turnLifecycle.markStopRequested(pool, {
        sessionId: target.sessionId, ...turnLifecycle.cleanupArgs(current.turn), by: current.username || 'homeroom',
      });
      current = await check();
      if (!current.active) return { ok: true, stopped: true };
    }
    let stopped = false;
    // A journal-scoped hard kill confirms the whole turn tree and keeps
    // unrelated processes alive. A root-only idle probe is not confirmation.
    if (target.journal) {
      await check();
      const remaining = target.expiresAt - Date.now();
      if (remaining <= 0) throw unconfirmed();
      try {
        const out = await worker.stopTurnByJournal(target.sessionId, target.journal, { timeoutMs: Math.min(5000, remaining) });
        if (out === 'stopped') stopped = true;
        else {
          current = await check();
          // A pending dispatch whose record is released below observes
          // that release after its exec and stops its own journal.
          if (current.turn?.phase === 'dispatch_pending') stopped = true;
          // An unchanged record can outlive its journal (a failed wrapper
          // or replaced volume). Confirm it by removing the captured
          // runtime identity below; a different recorded job still fails check().
        }
      } catch (err) {
        if (err.code === 'turn_changed' || err.code === 'not_authorized') throw err;
        log.warn('worker-stop', 'Journal kill unconfirmed; removing captured worker identity', { sessionId: target.sessionId, code: err.code });
      }
    }
    if (!stopped) {
      const until = Math.min(target.expiresAt, Date.now() + 20_000);
      const out = await worker.removeWorker(target.sessionId, {
        waitMs: Math.max(0, until - Date.now()), pollMs: 250, renew: checkpoint,
        proceed: async () => {
          const before = await check();
          if (target.active && !before.active) return false;
          if (Date.now() >= until) throw unconfirmed();
          // A saved commit is never discarded by the fallback. An active
          // record that cannot safely be rescued makes this stop retryable.
          await worker.rescueUnpushedCommit(target.sessionId, { turnId: target.turnId, forTurnStart: true });
          await check();
          if (Date.now() >= until) throw unconfirmed();
          return true;
        },
      });
      if (out.skipped) {
        current = await check();
        if (target.active && !current.active) return { ok: true, stopped: true };
        throw changed();
      }
      removed = true;
    }
    await sleep(250);
    await check();
    const retained = await settle(pool, target, check);
    current = await check();
    const by = target.userId == null ? 'homeroom' : current.username;
    const text = `Stopped${by ? ` by @${by}` : ''} (forced).`;
    const quickReplies = require('./recovery-pills').turnFallbackQuickReplies({ outcome: 'stopped' });
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       SELECT $1, 'system', $2, $3::jsonb WHERE NOT EXISTS
         (SELECT 1 FROM chat_session_messages WHERE session_id = $1 AND metadata->>'workerStopRequest' = $4)`,
      [target.sessionId, text, JSON.stringify({ quickReplies, workerStopRequest: target.requestId }), target.requestId]);
    await checkpoint();
    const bus = require('./session-bus'); const ws = require('./ws');
    for (const [index, event] of [
      { type: 'status', text, quickReplies }, { type: 'stopped', phase: null, by, forced: true }, { type: 'done' },
    ].entries()) {
      const data = { ...event, _seq: `force-${target.requestId}-${index}` };
      try { bus.publish(target.sessionId, data); } catch {}
      try { ws.broadcastGlobal({ ...data, sessionId: target.sessionId, event: event.type, type: 'session_event' }); } catch {}
    }
    log.info('worker-stop', 'Turn force-stopped', { sessionId: target.sessionId, removed, retained });
    return { ok: true, stopped: true, retained };
  }, { onLost: () => { lost = true; } });
}

module.exports = { run };

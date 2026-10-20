'use strict';

// A person's turn, as the turn machine's work item (src/workflow/turn/): run
// whole, in whichever workflow process claims it. Before, the web process
// that took the request ran it, and when that process went the leader
// adopted what it left; now a process that goes takes only the item's lease,
// and the process that claims the item next carries the turn on:
//
//   agent     a conversation's Mayor (services/mayor/agent-turn.js
//             runAgentTurn), with the coding run it dispatches and its
//             wrap-up. Resumed: the coding run its record names this item
//             as owner of is followed to its end, its tail and wrap-up
//             finished (services/turn-recovery.js, the adoption's path for
//             it), and a local agent's turn it dispatched is waited for and
//             finished the same way (services/local-agent-recovery.js); one
//             cut before its dispatch is ended as interrupted, with Retry;
//             one whose wrap-up was written is over.
//
// What the turn shows goes to its stream (services/session-bus.js), which
// the request that asked for it follows from any process.

const log = require('./logger');
const { turnOwner } = require('../workflow/rules/turn-stop.ts');

async function loadUser(pool, userId) {
  const { rows: [u] } = await pool.query('SELECT id, username FROM users WHERE id = $1', [Number(userId)]);
  return u ? { id: Number(u.id), username: u.username } : null;
}

// The change whose coding turn record names this item as its owner.
async function ownedChange(pool, workId) {
  const { rows: [r] } = await pool.query(
    `SELECT id FROM chat_sessions WHERE active_turn->'owner'->>'workId' = $1 ORDER BY id DESC LIMIT 1`, [String(workId)]);
  return r ? Number(r.id) : null;
}

// A coding run's recovery that could not read what it needs (the worker's
// state, who holds the session) throws `retryWorkerRecovery`: tried again
// here, this often and this many times, before the turn gives up on it.
const RECOVERY_RETRY = { ms: 10 * 1000, tries: 30 };

function pause(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function recoverChange(ctx, { config, pool }, sessionId) {
  for (let tried = 1; ; tried += 1) {
    try {
      return await require('./turn-recovery').recoverOwnedTurn({ config, pool, sessionId });
    } catch (err) {
      if (!err || !err.retryWorkerRecovery || tried >= RECOVERY_RETRY.tries || ctx.signal?.aborted) throw err;
      log.warn('turns', 'A coding run\'s recovery will be tried again', { sessionId, tried, err: err.message });
      await pause(RECOVERY_RETRY.ms, ctx.signal);
      if (ctx.signal?.aborted) throw err;
    }
  }
}

// What this item dispatched and has not seen to its end, carried on here:
// a local agent's turn it waited for (its waiter id taken over, its tail
// run: services/local-agent-recovery.js), else a coding run its record
// names it the owner of (services/turn-recovery.js). True when there was one.
async function carryOn(ctx, { config, pool }) {
  const local = await require('./local-agent').takeOverOwnedTurn(pool, ctx.workId);
  if (local) {
    log.info('turns', 'Carrying a local agent\'s turn on', { localTurnId: String(local.id), sessionId: local.session_id, workId: ctx.workId });
    const recovery = require('./turn-recovery');
    await require('./local-agent-recovery').finishAdoptedTurn({
      config, pool, turn: local,
      deps: { finalizeRecoveredTurn: recovery.finalizeRecoveredTurn, buildRecoveryStopHandle: recovery.buildRecoveryStopHandle },
    });
    return true;
  }
  const changeId = await ownedChange(pool, ctx.workId);
  if (changeId) {
    log.info('turns', 'Carrying a coding run on from its record', { changeId, workId: ctx.workId });
    await recoverChange(ctx, { config, pool }, changeId);
    return true;
  }
  return false;
}

// The end of a turn that never got going, on its stream: the request that
// asked for it, and every screen, settle.
function endUnstarted({ agentSessionId, turnId, error }) {
  const sessionBus = require('./session-bus');
  const key = require('./mayor/agent-turn').busKey(agentSessionId);
  const seq = String(turnId).slice(0, 8);
  sessionBus.publish(key, { type: 'error', _seq: `${seq}-e`, agentSessionId, error });
  sessionBus.publish(key, { type: 'done', _seq: `${seq}-z`, agentSessionId });
}

async function runAgent(ctx, { config, pool }, input) {
  const agentTurn = require('./mayor/agent-turn');
  const agentSessionId = Number(input.agentSessionId);
  const user = await loadUser(pool, input.userId);
  if (!user) {
    endUnstarted({ agentSessionId, turnId: input.turnId, error: 'The account that asked for this turn is gone.' });
    return { ended: 'no_user' };
  }
  const mayor = await agentTurn.resolveAgentMayor({
    pool, config, userId: user.id, agentSessionId, ...(input.model ? { requestedModel: input.model } : {}),
  });
  if (!mayor || !mayor.ok) {
    endUnstarted({ agentSessionId, turnId: input.turnId, error: (mayor && mayor.error) || 'The agent could not start this turn.' });
    return { ended: 'no_payer' };
  }
  await agentTurn.runAgentTurn({
    pool,
    config,
    user,
    agentSessionId,
    turnId: input.turnId,
    messageText: input.messageText || null,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    recorded: input.recorded || null,
    retry: input.retry === true,
    followUp: input.followUp || null,
    mayor,
    res: null,
    owner: turnOwner(ctx, 'turn', input.instanceKey),
  });
  // A run this item dispatched and still holds after the turn returned (its
  // dispatch failed part way): carried to its end here, as a restart would.
  await carryOn(ctx, { config, pool });
  return { ended: 'done' };
}

async function resumeAgent(ctx, { config, pool }, input) {
  const agentTurn = require('./mayor/agent-turn');
  const agentSessionId = Number(input.agentSessionId);
  if (await carryOn(ctx, { config, pool })) return { ended: 'recovered' };
  const { rows: [wrapped] } = await pool.query(
    `SELECT 1 FROM chat_session_messages
      WHERE agent_session_id = $1 AND role = 'assistant' AND metadata->>'agentTurnId' = $2
        AND (metadata->>'wrapUp' = 'true' OR metadata->>'dispatch' IS NULL)
      LIMIT 1`, [agentSessionId, String(input.turnId)]);
  if (wrapped) {
    // Its answer is written: over.
    require('./session-bus').publish(agentTurn.busKey(agentSessionId),
      { type: 'done', _seq: `${String(input.turnId).slice(0, 8)}-z`, agentSessionId });
    return { ended: 'done' };
  }
  // Cut before its answer: ended as interrupted, with Retry.
  await require('./agent-sessions').endInterruptedTurn(pool, {
    agentSessionId, turnId: input.turnId, content: agentTurn.INTERRUPTED_TEXT,
  });
  require('./session-bus').publish(agentTurn.busKey(agentSessionId),
    { type: 'done', _seq: `${String(input.turnId).slice(0, 8)}-z`, agentSessionId });
  return { ended: 'interrupted' };
}

const KINDS = new Map([
  ['agent', { run: runAgent, resume: resumeAgent }],
]);

/** The turn machine's `turn.run` handler (src/workflow/turn/services.ts). */
async function run(ctx, deps) {
  const input = ctx.input || {};
  const kind = KINDS.get(input.kind);
  if (!kind) throw Object.assign(new Error(`not a turn kind: ${input.kind}`), { permanent: true });
  const resumed = !!ctx.resumeFrom || (Number(ctx.lostAttempts) || 0) > 0;
  try {
    return await (resumed ? kind.resume : kind.run)(ctx, deps, input);
  } finally {
    // Unless this process lost the item (the next claim carries it on), a
    // coding record it still holds is released as it ends.
    if (!(ctx.signal && ctx.signal.aborted)) {
      await require('./turn-recovery').releaseLeftRecord({ pool: deps.pool, workId: ctx.workId }).catch((err) => {
        log.warn('turns', 'Could not release a record the turn left', { workId: ctx.workId, err: err.message });
      });
    }
  }
}

module.exports = { run, ownedChange, RECOVERY_RETRY };

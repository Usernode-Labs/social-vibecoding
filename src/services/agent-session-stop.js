'use strict';

// One owner-scoped view of the conversation AND the job it dispatched. A
// browser, a reconnect, and another pod all read the same durable stop stamp.
const sessions = require('./agent-sessions');
const lifecycle = require('./turn-lifecycle');
const mayor = require('./mayor/agent-turn');
const workers = require('./active-workers');
const registry = require('./stop-registry');

function epoch(value) {
  const n = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readWork(pool, { agentSessionId, userId }, deps = {}) {
  const { rows } = await pool.query(
    `SELECT s.active_turn, s.active_change_id,
            c.id AS change_id, c.active_turn AS change_turn,
            (s.active_turn IS NOT NULL) AS turn_live
       FROM agent_sessions s
       LEFT JOIN chat_sessions c ON c.id = s.active_change_id
         AND c.user_id = s.user_id AND c.agent_session_id = s.id
      WHERE s.id = $1 AND s.user_id = $2`,
    [agentSessionId, userId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  const local = (deps.mayor || mayor).turnState(agentSessionId);
  const changeId = row.change_id ? Number(row.change_id) : null;
  const job = lifecycle.parseActiveTurn(row.change_turn);
  const handle = changeId ? (deps.registry || registry).get(changeId) : null;
  const isBusy = deps.isChangeBusy || workers.isSessionBusy;
  const mode = job?.mode || (changeId && (deps.activeTurnMode || require('./worker').getActiveTurnMode)(changeId));
  const coding = changeId && mode !== 'shots' && (!!job || isBusy(changeId));
  const lease = row.active_turn;
  const live = local || (row.turn_live && lease ? sessions.leaseTurn(lease) : null);
  if (!coding && !live) return { busy: false, turn: null, row };
  // The worker's identity wins while it exists. A stale stop from a previous
  // job must never apply to its replacement, even in the same conversation.
  const jobId = job && lifecycle.turnIdentity(job);
  const token = jobId ? `change:${changeId}:${jobId}` : (live?.id ? `agent:${live.id}` : null);
  const requestedAt = epoch(job?.stopRequestedAt) || epoch(handle?.stopRequestedAt)
    || epoch(lease?.stopRequestedAt) || epoch(local?.stopRequestedAt);
  const stopping = !!requestedAt || !!handle?.stopped || !!live?.stopping;
  return {
    busy: true,
    turn: {
      ...(live || {}),
      phase: coding && live?.phase !== 'mayor2' ? 'cc' : (live?.phase || 'cc'),
      id: live?.id || null,
      changeId: coding ? changeId : null,
      startedAt: epoch(job?.startedAt) || live?.startedAt || null,
      stopping,
      stopRequestedAt: requestedAt,
      stopToken: token,
      // Compatibility for a browser still running the previous control.
      canForceStop: false,
    },
    row,
  };
}

async function requestStop({ pool, user, agentSessionId, token = null, scheduleInteractiveRecovery = null }, deps = {}) {
  const work = await readWork(pool, { agentSessionId, userId: user.id }, deps);
  const fail = (status, error, code) => ({ status, body: { error, code } });
  if (!work) return fail(404, 'Agent session not found', 'not_found');
  if (!work.busy) return { status: 200, body: { stopped: false, reason: 'no_active_turn' } };
  if (token && token !== work.turn.stopToken) return fail(409, 'The running job changed. Try Stop again.', 'turn_changed');
  if (work.turn.phase === 'mayor2') return { status: 200, body: { stopped: false, reason: 'wrap_up_not_stoppable' } };
  const { row, turn } = work;
  // Stamped on the turn's claim, which the turn reads between its steps
  // wherever it runs, then told to the turn's machine, which stops its
  // coding agent by its journal (src/workflow/turn/).
  if (row.active_turn?.id) {
    const marked = await sessions.markTurnStopRequested(pool, {
      agentSessionId, userId: user.id, turnId: row.active_turn.id, by: user.username,
    });
    if (!marked) return fail(409, 'The running turn changed. Try Stop again.', 'turn_changed');
    await (deps.platform || require('../workflow/platform.ts')).stopTurn({
      key: `agent:${Number(agentSessionId)}`, by: user.username,
    });
  }
  (deps.mayor || mayor).stopAgentTurn(agentSessionId, { by: user.username, expectedTurnId: row.active_turn?.id || null });
  if (turn.changeId) {
    const stopJob = deps.stopJob || require('../routes/sessions').requestSessionStop;
    const result = await stopJob({
      pool, user, sessionId: turn.changeId, force: true, immediate: true,
      expectedTurnId: lifecycle.turnIdentity(row.change_turn), scheduleInteractiveRecovery,
    });
    if (result.status >= 400) return result;
    if (!result.body.stopped) return fail(409, 'The coding job has not stopped. Retry Stop.', 'stop_not_confirmed');
  }
  // Accepted does not mean terminated. Only subsequent authoritative reads
  // may hand the composer back to Send.
  return { status: 202, body: { stopped: true, stopping: true, stopRequestedAt: turn.stopRequestedAt || Date.now() } };
}

module.exports = { readWork, requestStop };

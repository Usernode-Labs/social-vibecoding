'use strict';

// Finishing a local agent's turn after a restart (#907).
//
// A turn handed to a machine of the user's has no worker and no durable
// turn record: the platform's whole side of it is a waiter in the process
// that dispatched it (routes/sessions.js dispatchLocalBuild /
// dispatchLocalScout → localAgent.awaitTurnResult), and the tail that runs
// when the waiter returns (PR, staging, checks, the completion card, the
// wrap-up). A deploy or a crash kills that process while the laptop keeps
// working, and nothing was left to finish the turn: the commits the agent
// uploaded sat on the branch with no PR, preview, card or wrap-up, and the
// conversation offered Retry, which could build it all again.
//
// A turn a work item dispatched (every person's turn: src/workflow/turn/)
// names that item as its owner, and the item is its waiter: when the item's
// process goes, the process that claims the item next takes the waiter id
// over (localAgent.takeOverOwnedTurn: a new waiter id, one conditional
// UPDATE, so no turn has two waiters) and runs finishAdoptedTurn below
// (services/turns.js), which waits for it like the dead waiter would have,
// claims its tail once with that id, and runs the post-turn path restart
// recovery runs for a worker's turn: server.js finalizeRecoveredTurn for a
// build, the spec publication for a scout, then the wrap-up
// (routes/sessions.js runRecoveredWrapUp, which writes a conversation's into
// the conversation). The lease sweeper still fails a turn whose machine
// stopped heartbeating ('abandoned'); this finishes that turn too, with the
// honest "disconnected" card the live waiter writes.
//
// Exactly once: the tail is claimed under the waiter id (localAgent.claimTail),
// so the live waiter and this one cannot both run it. A
// recovery that dies inside the tail is not repeated (the tail has no
// durable receipts on this path, as a legacy record's does not); the turn
// keeps tail_claimed_at without tail_finished_at.

const log = require('./logger');

const SESSION_SQL = `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
        a.self_hosted AS app_self_hosted, u.username
   FROM chat_sessions cs
   JOIN apps a ON cs.app_id = a.id
   JOIN users u ON cs.user_id = u.id
  WHERE cs.id = $1`;

function defaults(deps = {}) {
  return {
    localAgent: deps.localAgent || require('./local-agent'),
    activeWorkers: deps.activeWorkers || require('./active-workers'),
    stopRegistry: deps.stopRegistry || require('./stop-registry'),
    recoveryPills: deps.recoveryPills || require('./recovery-pills'),
    turnWatchdog: deps.turnWatchdog || require('./turn-watchdog'),
    notifications: deps.notifications || require('./notifications'),
    agentSessions: deps.agentSessions || require('./agent-sessions'),
    agentTurn: deps.agentTurn || require('./mayor/agent-turn'),
    pushToUser: deps.pushToUser || ((userId, payload) => require('./ws').pushToUser(userId, payload)),
    broadcastGlobal: deps.broadcastGlobal || ((payload) => require('./ws').broadcastGlobal(payload)),
    sessionsRoutes: deps.sessionsRoutes || require('../routes/sessions'),
    staging: deps.staging || require('./staging'),
    // server.js's own: the recovered build tail and the adopted turn's stop
    // handle (its WS + session-bus fan-out, relayed to the conversation).
    finalizeRecoveredTurn: deps.finalizeRecoveredTurn,
    buildRecoveryStopHandle: deps.buildRecoveryStopHandle,
  };
}

async function finishAdoptedTurn({ config, pool, turn, deps = {} }) {
  const d = defaults(deps);
  const sessionId = Number(turn.session_id);
  const mode = turn.mode === 'scout' ? 'scout' : 'build';
  const { rows } = await pool.query(SESSION_SQL, [sessionId]);
  const session = rows[0] || null;
  const { rows: leaseRows } = await pool.query(
    'SELECT label FROM session_agent_leases WHERE id = $1',
    [turn.lease_id]
  );
  const label = (leaseRows[0] && leaseRows[0].label) || 'your machine';

  // A change closed while the platform was down has no tail to run: the
  // laptop is told to stop, and the turn is claimed so no pass takes it again.
  if (!session || !['active', 'promoted'].includes(session.status)) {
    await d.localAgent.requestStop(pool, { sessionId, userId: null }).catch(() => {});
    await d.localAgent.claimTail(pool, turn.id, turn.waiter_id).catch(() => null);
    return { outcome: 'closed' };
  }

  // The change is busy again, as it was while the dead waiter waited: the
  // sweepers leave it alone, a new message is told a build is running, and
  // POST /stop reaches the laptop through the handle's localTurnId.
  const relayTo = [];
  const conversations = await d.agentSessions.conversationsOfChange(pool, sessionId).catch(() => []);
  for (const c of conversations) {
    relayTo.push(c.agentSessionId);
    try {
      d.pushToUser(c.userId, { type: 'agent_session_changed', agentSessionId: c.agentSessionId, busy: true });
    } catch { /* the lists catch up on their next read */ }
  }
  const handle = d.buildRecoveryStopHandle({
    sessionId, containerName: null, activeTurn: null, broadcastGlobal: d.broadcastGlobal, relayTo,
  });
  handle.localTurnId = String(turn.id);
  d.stopRegistry.set(sessionId, handle);
  d.activeWorkers.activeWorkers.add(sessionId);
  const emit = handle.send;
  const agentMeta = { agentBackend: 'claude_code', agentModel: null, runner: 'local', localAgentLabel: label, localMode: mode };

  let tailHeartbeat = null;
  try {
    // ── Wait, as the dead waiter would have ────────────────────────────
    // The progress card is rebuilt wholesale from the turn's own lines (the
    // dead waiter had appended some of them already), and each line is sent
    // once to the screens following the change.
    const acceptedLine = `[${label} accepted the ${mode === 'scout' ? 'scout ' : ''}turn]`;
    let sent = 0;
    const progressFor = (row) => {
      const lines = Array.isArray(row.progress) ? row.progress.map(String) : [];
      const accepted = row.status !== 'queued' && row.status !== 'offered';
      return accepted ? [acceptedLine, ...lines] : lines;
    };
    const writeProgress = (lines) => pool.query(
      `UPDATE chat_session_messages
          SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
        WHERE id = (
          SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system' AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
        )`,
      [JSON.stringify(lines), sessionId]
    ).catch(() => {});
    let lastLines = [];
    const createdMs = Date.parse(turn.created_at) || Date.now();
    const { outcome, turn: finished } = await d.localAgent.awaitTurnResult(pool, turn.id, {
      waiterId: turn.waiter_id,
      // The outer bound counts from when the turn was dispatched, not from
      // this takeover.
      turnTimeoutMs: Math.max(0, d.localAgent.TURN_TIMEOUT_MS - (Date.now() - createdMs)),
      onProgress: async (row) => {
        lastLines = progressFor(row);
        for (const text of lastLines.slice(sent)) emit('cc_progress', { text, ...agentMeta });
        sent = Math.max(sent, lastLines.length);
        await writeProgress(lastLines);
      },
    });
    if (outcome === 'adopted' || outcome === 'missing' || !finished) {
      // Someone else holds the tail now, or the turn is gone with its change.
      return { outcome };
    }
    // The tail is this process's now (claimTail). Its heartbeat keeps saying
    // so while it runs: a staging build alone can take minutes, and a
    // conversation must not be ended as interrupted meanwhile.
    tailHeartbeat = setInterval(() => {
      d.localAgent.touchWaiter(pool, turn.id, turn.waiter_id).catch(() => {});
    }, d.localAgent.WAITER_RENEW_MS);
    if (typeof tailHeartbeat.unref === 'function') tailHeartbeat.unref();
    const terminalLines = progressFor(finished);
    // Lines the laptop posted after the last poll, then the card's end.
    for (const text of terminalLines.slice(sent)) emit('cc_progress', { text, ...agentMeta });
    const terminal = outcome === 'completed' ? '[done]' : '[interrupted]';
    if (d.turnWatchdog.appendTerminalLine(terminalLines, terminal)) emit('cc_progress', { text: terminal });
    await writeProgress(terminalLines.length ? terminalLines : lastLines);

    const result = d.localAgent.buildTurnResult({
      turn: finished, outcome, label, behind: session.behind_main || 0, mode,
    });
    const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

    // ── A stop is a deliberate end: no tail, no wrap-up ────────────────
    if (outcome === 'stopped') {
      const { describeStoppedLanding, stopLandingMeta } = d.sessionsRoutes;
      const landing = { sha: result.sha || null, ahead: result.sha ? null : 0, pushOk: true };
      const text = `Stopped${describeStoppedLanding(landing)}.`;
      const pills = d.recoveryPills.turnFallbackQuickReplies({ outcome: 'stopped' });
      const stopLanding = stopLandingMeta({ headline: 'Stopped', ...landing });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [sessionId, text, JSON.stringify({ quickReplies: pills, recovered: true, stopped: true, stopLanding, ...agentMeta })]
      );
      emit('status', { text, quickReplies: pills, stopLanding });
      emit('stopped', { by: null });
      await d.localAgent.recordTurnRunner(pool, sessionId, 'local', label);
      await d.localAgent.markTailFinished(pool, turn.id);
      return { outcome };
    }

    // ── The post-turn path a recovered worker turn takes ───────────────
    let wrapUpOutcome;
    let wrapUpPillKind;
    let wrapUpSummary = null;
    let stalled = false;
    if (mode === 'scout') {
      const { captureSpecOutput, persistScoutPublication } = d.sessionsRoutes;
      const captured = captureSpecOutput(result.lastResultText);
      if (outcome === 'completed' && captured.text) {
        const publication = await persistScoutPublication({
          pool,
          sessionId,
          content: captured.text,
          contentHtml: captured.html,
          hadSpec: !!(session.spec_md || '').trim(),
          quickReplies: d.recoveryPills.buildRecoveryQuickReplies('spec_done'),
          recovered: true,
          localAgentLabel: label,
          localMode: 'scout',
        });
        if (publication.applied !== false) {
          emit('status', { text: publication.scoutText, ...publication.metadata });
          emit('spec_updated', {
            length: captured.text.length, lines: publication.lineCount, version: publication.specVersion,
          });
        }
        wrapUpOutcome = 'spec';
        wrapUpPillKind = 'spec_done';
        wrapUpSummary = `The scout drafted the change's spec on ${label} (${publication.lineCount} lines). It is in the `
          + 'spec viewer; when the user is ready, they will ask you to build it.';
      } else {
        stalled = true;
        const pills = d.recoveryPills.buildRecoveryQuickReplies('unrecoverable');
        const text = result.fatalError || d.recoveryPills.SCOUT_NO_SPEC_BREADCRUMB;
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, text, JSON.stringify({ ...(pills ? { quickReplies: pills } : {}), recovered: true, ...agentMeta })]
        );
        emit('status', { text, quickReplies: pills || undefined });
        wrapUpOutcome = 'failed';
        wrapUpPillKind = 'unrecoverable';
        wrapUpSummary = `The scout on ${label} did not produce a spec${result.fatalError ? `: ${result.fatalError}` : '.'}`;
      }
    } else {
      const finalized = await d.finalizeRecoveredTurn({
        config, pool, staging: d.staging, session, sessionId, result, repoOwner, repoName,
        emit, containerName: null,
        // There is no worker to keep or reap: the run happened on the laptop.
        keepWorker: true,
        startedAtMs: createdMs,
        alreadyDone: null,
        activeTurn: null,
        localAgentLabel: label,
      });
      const landed = result.ahead > 0 && !!result.sha;
      wrapUpSummary = finalized.summary;
      if (finalized.outcome === 'push_failed') {
        wrapUpOutcome = 'push_failed';
        wrapUpPillKind = 'push_failed';
        stalled = true;
      } else if (!landed && result.ccIsError) {
        wrapUpOutcome = 'failed';
        wrapUpPillKind = 'unrecoverable';
        stalled = true;
      } else {
        wrapUpOutcome = landed ? 'code' : 'no_changes';
        wrapUpPillKind = 'code_done';
      }
    }

    handle.phase = 'mayor2';
    emit('phase', { phase: 'mayor2' });
    await d.sessionsRoutes.runRecoveredWrapUp({
      pool, config, session, sessionId,
      outcome: wrapUpOutcome,
      dispatchSummary: wrapUpSummary,
      fallbackPillKind: wrapUpPillKind,
      turnModel: null,
      turnId: null,
      emit,
    });

    // The owner was not watching a turn whose waiter died with the platform:
    // the bell says how it ended, as for any recovered turn.
    try {
      await pool.query('UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1', [sessionId]).catch(() => {});
      const create = stalled
        ? d.notifications.createSessionStalledNotification
        : d.notifications.createSessionDoneNotification;
      const created = await create(pool, { userId: session.user_id, appId: session.app_id, sessionId });
      if (created && created.length) await d.notifications.hydrateAndPush(pool, created[0]);
    } catch (err) {
      log.warn('local-agent', 'Recovered local turn: notification failed', { sessionId, err: err.message });
    }

    await d.localAgent.recordTurnRunner(pool, sessionId, 'local', label);
    d.localAgent.recordTurnEvent(pool, {
      userId: session.user_id, appId: session.app_id, sessionId, outcome,
      runtime: turn.runtime || 'claude-code', durationMs: Date.now() - createdMs, mode,
    })?.catch?.(() => {});
    await d.localAgent.markTailFinished(pool, turn.id);
    log.info('local-agent', 'Recovered local turn finished', {
      turnId: String(turn.id), sessionId, outcome, mode, wrapUp: wrapUpOutcome,
    });
    return { outcome, wrapUp: wrapUpOutcome };
  } finally {
    if (tailHeartbeat) clearInterval(tailHeartbeat);
    d.stopRegistry.deleteIf(sessionId, handle);
    d.activeWorkers.activeWorkers.delete(sessionId);
    emit('done', {});
    // The conversation whose Mayor dispatched this build hears it is over;
    // its claim is its turn machine's to release.
    await d.agentTurn.handBackAfterRecovery({ pool, changeId: sessionId })
      .catch((err) => log.warn('local-agent', 'Recovered local turn: conversation hand-back failed', {
        sessionId, err: err.message,
      }));
    await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [sessionId]).catch(() => {});
  }
}

module.exports = { finishAdoptedTurn };

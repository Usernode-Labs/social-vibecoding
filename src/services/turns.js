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
//   classic   a change's own dev chat (services/mayor/turn.js runMayorTurn,
//             for the changes that still take one: a CLI hand-off, a
//             request's spec), with the coding run it dispatches. Resumed:
//             what it dispatched is carried on as above; a turn cut before
//             its reply gets the dev chat's own repair (the reply's pills,
//             or the "didn't answer" note: turn-recovery.js
//             repairUnansweredTurn).
//   headless  an auto session on a request (routes/sessions.js
//             runHeadlessSessionInner). Resumed: carried on from the
//             change's row (resumeOneHeadlessRun).
//   recover   a coding record no work item holds (an older release's, with
//             no owner, or one its settled item left), taken through the
//             leader's adoption (turn-leftovers.js).
//
// What the turn shows goes to its stream (services/session-bus.js), which
// the request that asked for it follows from any process. A coding record
// a turn leaves retained (its cleanup not confirmed) is this item's to carry
// on as it ends (carryOn), so the turn's "recovering" scheduler only says so.

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

async function recoverChange(ctx, { config, pool }, sessionId, { owned = true } = {}) {
  for (let tried = 1; ; tried += 1) {
    try {
      return await require('./turn-recovery').recoverOwnedTurn({ config, pool, sessionId, owned });
    } catch (err) {
      if (err && err.retryWorkerRecovery && tried >= RECOVERY_RETRY.tries) {
        require('./recovery-retry').recordGaveUp({ pool, key: `interactive:${Number(sessionId)}`, err, failures: tried });
      }
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
  // Asked with its claim, so the claim names it until it ends. One that no
  // longer does was ended while it waited (ROLLOUT-ONLY: a release from
  // before the turn machine ends a claim not renewed for 90 seconds, and its
  // lease may then take it for a turn of its own): over, without running.
  const { rows: [claim] } = await pool.query(
    `SELECT active_turn->>'id' AS turn_id FROM agent_sessions WHERE id = $1`, [agentSessionId]);
  if (!claim || claim.turn_id !== String(input.turnId)) {
    require('./session-bus').publish(agentTurn.busKey(agentSessionId),
      { type: 'done', _seq: `${String(input.turnId).slice(0, 8)}-z`, agentSessionId });
    return { ended: 'claim_gone' };
  }
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
    scheduleInteractiveRecovery: ITEM_CARRIES_ON,
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

// The retained-turn scheduler a turn under an item is given: the item
// carries the record on itself (carryOn, as it ends).
const ITEM_CARRIES_ON = async () => true;

// A response nobody reads: the turn's events reach its request through its
// stream (runMayorTurn publishes every one there).
const NO_RESPONSE = Object.freeze({
  write() { return true; }, end() {}, writeHead() {}, setHeader() {}, on() {}, once() {},
  destroyed: false, writableEnded: false, headersSent: true,
});

const CLASSIC_SESSION_SQL = `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
        a.self_hosted as app_self_hosted
   FROM chat_sessions cs
   JOIN apps a ON cs.app_id = a.id
  WHERE cs.id = $1 AND cs.user_id = $2
    AND cs.status IN ('active', 'promoted')
    AND cs.is_headless = FALSE
    AND cs.source IS DISTINCT FROM 'imported'
    AND cs.agent_session_id IS NULL`;

// The end of a change's turn that never got going, on the change's stream.
function endUnstartedChange({ sessionId, turnId, error }) {
  const sessionBus = require('./session-bus');
  const seq = `t${String(turnId).slice(0, 8)}`;
  sessionBus.publish(Number(sessionId), { type: 'error', _seq: `${seq}-e`, error });
  sessionBus.publish(Number(sessionId), { type: 'done', _seq: `${seq}-z` });
}

// How often a running classic turn reads whether a person stopped it.
const STOP_POLL = { ms: 2000 };

// A person's Stop of a classic turn is its instance's (StopRequested sets
// `stoppedBy`, from any process: workflow/platform.ts stopWorkflowTurn);
// the turn reads it between its steps and stops itself the way the dev
// chat's Stop always has, through its in-process handle
// (routes/sessions.js requestSessionStop, forwarded: past the routing it
// already went through). Returns the function that stops watching.
function watchClassicStop({ pool, key, turnId, session }) {
  let acted = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (acted || busy) return;
    busy = true;
    try {
      const { rows: [r] } = await pool.query(
        `SELECT data->'running'->>'stoppedBy' AS by FROM wf_instances
          WHERE machine = 'turn' AND key = $1 AND data->'running'->>'turnId' = $2`, [key, String(turnId)]);
      if (!r || !r.by) return;
      const out = await require('../routes/sessions').requestSessionStop({
        pool, sessionId: Number(session.id), forwarded: true,
        user: { id: Number(session.user_id), username: r.by, canAdminWrite: true },
      });
      // A turn whose handle is not registered yet (a Stop at its very
      // start) answers "no active turn": asked again at the next poll.
      if (out && out.body && out.body.stopped === false && out.body.reason === 'no active turn') return;
      acted = true;
      log.info('turns', 'A person stopped a dev chat turn', { sessionId: session.id, by: r.by });
    } catch (err) {
      log.warn('turns', 'Could not read or apply a dev chat turn\'s stop', { sessionId: session.id, err: err.message });
    } finally {
      busy = false;
    }
  }, STOP_POLL.ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

async function runClassic(ctx, { config, pool }, input) {
  const sessionId = Number(input.sessionId);
  const user = await loadUser(pool, input.userId);
  const { rows: [session] } = user ? await pool.query(CLASSIC_SESSION_SQL, [sessionId, user.id]) : { rows: [] };
  if (!session) {
    endUnstartedChange({ sessionId, turnId: input.turnId, error: 'This change can no longer take a message here.' });
    return { ended: 'gone' };
  }
  const sessions = require('../routes/sessions');
  const payer = await sessions.resolveClassicPayer({
    pool, config, userId: user.id, isOpenRouterSession: input.isOpenRouterSession === true,
  });
  if (!payer.ok) {
    endUnstartedChange({ sessionId, turnId: input.turnId, error: payer.body.error });
    return { ended: 'no_payer' };
  }
  const unwatch = watchClassicStop({ pool, key: input.instanceKey, turnId: input.turnId, session });
  try {
    await require('./mayor/turn').runMayorTurn({
      session,
      isOpenRouterSession: input.isOpenRouterSession === true,
      res: NO_RESPONSE,
      pool,
      config,
      req: { user },
      messageText: input.messageText,
      selectedModel: input.selectedModel,
      turnAttachments: Array.isArray(input.turnAttachments) ? input.turnAttachments : [],
      scheduleInteractiveRecovery: ITEM_CARRIES_ON,
      userApiKey: payer.userApiKey,
      userMessageId: input.userMessageId ?? null,
      clientMessageId: input.clientMessageId ?? null,
      owner: turnOwner(ctx, 'turn', input.instanceKey),
    }, sessions.MAYOR_TURN_DEPS);
  } finally {
    unwatch();
  }
  await carryOn(ctx, { config, pool });
  return { ended: 'done' };
}

async function resumeClassic(ctx, { config, pool }, input) {
  const sessionId = Number(input.sessionId);
  if (await carryOn(ctx, { config, pool })) return { ended: 'recovered' };
  // Cut before it replied, or before its reply's pills landed: the dev
  // chat's own repair, then its stream settles.
  await require('./turn-recovery').repairUnansweredTurn(pool, sessionId);
  require('./session-bus').publish(sessionId, { type: 'done', _seq: `t${String(input.turnId).slice(0, 8)}-z` });
  return { ended: 'interrupted' };
}

// ── A headless run (an auto session on a request) ─────────────────────

// Its durable state retained after a step failed (the retained-recovery
// path: routes/sessions.js retainOrQuarantineRecoveryError): carried on
// from the change's row (resumeOneHeadlessRun, which reads its step and
// follows a coding run's journal), tried again as a coding run's recovery is
// (RECOVERY_RETRY), then failed for good.
async function carryHeadlessOn(ctx, { config, pool }, sessionId, owner) {
  const sessions = require('../routes/sessions');
  const recoveryRetry = require('./recovery-retry');
  let latest = null;
  for (let tried = 1; ; tried += 1) {
    let retained = false;
    try {
      const fresh = await sessions.reloadRecoverableHeadlessSession(pool, sessionId);
      if (!fresh) return;
      latest = fresh;
      await sessions.resumeOneHeadlessRun({ pool, config, session: fresh, owner, onRetained: () => { retained = true; } });
      if (!retained) return;
      if (tried >= RECOVERY_RETRY.tries) throw new Error('its durable state is still retained');
    } catch (err) {
      const again = (err && err.retainActiveTurn && recoveryRetry.shouldRetryRecoveryError(err)) || retained;
      if (!again || tried >= RECOVERY_RETRY.tries || ctx.signal?.aborted) {
        if (ctx.signal?.aborted) throw err;
        log.error('turns', 'A headless run could not be carried on; failing it', { sessionId, err: err.message });
        if (again) recoveryRetry.recordGaveUp({ pool, key: `headless:${Number(sessionId)}`, err, failures: tried });
        if (latest) {
          await sessions.failHeadlessRun(pool, latest,
            `Auto session could not be completed: ${String(err.message || err).substring(0, 200)}`);
        }
        return;
      }
      log.warn('turns', 'A headless run will be carried on again', { sessionId, tried, err: err.message });
    }
    await pause(RECOVERY_RETRY.ms, ctx.signal);
    // Stopped between tries: nothing to report, so the next claim carries
    // it on (a normal return would settle the item as done).
    if (ctx.signal?.aborted) throw ctx.signal.reason || new Error('stopped between tries');
  }
}

async function runHeadless(ctx, { config, pool }, input) {
  const sessionId = Number(input.sessionId);
  const sessions = require('../routes/sessions');
  const session = await sessions.reloadRecoverableHeadlessSession(pool, sessionId);
  // Stopped, failed or finished meanwhile: nothing to run.
  if (!session || session.headless_status !== 'generating') return { ended: 'gone' };
  const owner = turnOwner(ctx, 'turn', input.instanceKey);
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!repoOwner || !repoName) {
    await sessions.failHeadlessRun(pool, session, 'Auto session failed: no GitHub repo configured.');
    return { ended: 'failed' };
  }
  // What the run is asked with is ids only: the request is read here, as a
  // resumed planning step reads it, and the payer is read as it runs (the
  // run re-reads it before each model phase), never carried in the input.
  const github = require('./github');
  const issueNumber = Number(session.headless_issue_number);
  const { issue } = await github.fetchPublicIssue(repoOwner, repoName, issueNumber);
  const { comments } = await github.fetchIssueComments(repoOwner, repoName, issueNumber);
  let botUsername = null;
  try { botUsername = await github.getBotUsername(); } catch { /* the bot's name is optional */ }
  const isOpenRouterSession = require('../agents/registry').resolveBackend(session.agent_backend) === 'codex_openrouter';
  const billing = isOpenRouterSession
    ? { apiKey: null }
    : await require('./limits').resolveBillingPath(pool, config.dataEncryptionKey, session.user_id);
  let retained = false;
  await sessions.runHeadlessSessionInner({
    pool, config, session,
    user: { id: Number(session.user_id), username: session.username },
    selectedModel: input.selectedModel,
    repoOwner, repoName,
    userApiKey: billing.error ? null : billing.apiKey,
    issueNumber, issue, comments, botUsername,
    owner,
    onRetained: () => { retained = true; },
  });
  if (retained) await carryHeadlessOn(ctx, { config, pool }, sessionId, owner);
  return { ended: 'done' };
}

async function resumeHeadless(ctx, { config, pool }, input) {
  await carryHeadlessOn(ctx, { config, pool }, Number(input.sessionId), turnOwner(ctx, 'turn', input.instanceKey));
  return { ended: 'recovered' };
}

// ── A coding record nothing carries (services/turn-leftovers.js) ──────

// A coding run's record no work item holds (an older release's, with no
// owner, or one whose item settled without releasing it): the adoption the
// leader ran, as it ran it (a turn a live process still runs is left alone
// there too), tried again as an owned one is.
async function runRecover(ctx, { config, pool }, input) {
  const sessionId = Number(input.sessionId);
  try {
    await recoverChange(ctx, { config, pool }, sessionId, { owned: false });
  } catch (err) {
    if (!input.last || ctx.signal?.aborted) throw err;
    log.warn('turns', 'A record nothing carries could not be recovered on its last ask', { sessionId, err: err.message });
  }
  if (!input.last) return { ended: 'recovered' };
  // The last ask (turn-leftovers.js RECORD_RETRY): a record still there,
  // the same one, is ended as a forced Stop ends one nobody runs.
  const { rows: [left] } = await pool.query(
    `SELECT 1 FROM chat_sessions WHERE id = $1 AND active_turn IS NOT NULL
        AND COALESCE(active_turn->>'turnId', active_turn->>'logicalTurnId', active_turn->>'turnUuid', 'record') = $2`,
    [sessionId, String(input.identity)]);
  if (!left) return { ended: 'recovered' };
  log.error('turns', 'Ending a turn record no recovery could take to its end', { sessionId, identity: input.identity });
  await require('../routes/sessions').forceStopSession(pool, sessionId, 'homeroom', null);
  return { ended: 'ended' };
}

// ROLLOUT-ONLY: a release from before the turn machine reads a
// conversation's claim as abandoned once it has not been renewed for 90
// seconds: its leader ends the turn as interrupted, and its lease takes the
// claim for a turn of its own. While a process of that release may run
// beside this one, the claim of the turn this item runs is renewed as that
// release renewed it (agent-sessions.js renewTurnLease, before the turn
// machine), which no screen redraws for (schema.sql agent_session_state_touch).
// Delete with turn-leftovers.js's rollout parts.
const CLAIM_RENEW = { ms: 30 * 1000 };

function renewClaim(pool, input) {
  if (input.kind !== 'agent') return () => {};
  const renew = () => pool.query(
    `UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW())
      WHERE id = $1 AND active_turn->>'id' = $2`, [Number(input.agentSessionId), String(input.turnId)])
    .catch((err) => log.warn('turns', 'Could not renew the conversation\'s claim', { agentSessionId: input.agentSessionId, err: err.message }));
  renew();
  const timer = setInterval(renew, CLAIM_RENEW.ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ROLLOUT-ONLY: a headless run holds its session for the whole of its item,
// as it held it before the turn machine (routes/sessions.js
// runHeadlessSession): a release from before it resumes a 'generating' run
// no process holds (its resumeHeadlessRuns, at its leader's election and
// every few minutes), and reads this process's holds as processes.js writes
// them for it. Delete with turn-leftovers.js's rollout parts.
function holdHeadlessRun(input) {
  if (input.kind !== 'headless' || !(Number(input.sessionId) > 0)) return () => {};
  return require('./processes').hold('session', Number(input.sessionId));
}

const KINDS = new Map([
  ['agent', { run: runAgent, resume: resumeAgent }],
  ['classic', { run: runClassic, resume: resumeClassic }],
  ['headless', { run: runHeadless, resume: resumeHeadless }],
  ['recover', { run: runRecover, resume: runRecover }],
]);

// A turn's item that loses its lease while this process runs on (the
// database out of reach for most of a lease, or this process stalled): the
// next claim carries the turn on from its record, and nothing here can stop
// the run part way (its coding run's journal is followed to its end), so two
// would follow one turn. Unless the item was settled (a cancel: nothing runs
// it again) or this process is stopping (its runtime's stop, or a shutdown:
// it exits by itself), this process
// ends here, as one that died would; the platform restarts it. A database it
// cannot read counts as not settled.
const LOST_LEASE = { exit: (code) => process.exit(code) };

function endOnLostLease(ctx, pool) {
  const signal = ctx.signal;
  if (!signal || signal.aborted) return () => {};
  let running = true;
  const onAbort = () => {
    if (signal.reason && signal.reason.stopping === true) return;
    void (async () => {
      if (require('./lifecycle').isShuttingDown()) return;
      let settled = false;
      try {
        const { rows: [w] } = await pool.query('SELECT status FROM wf_work WHERE id = $1', [ctx.workId]);
        settled = !!w && w.status === 'settled';
      } catch { /* out of reach: not known to be settled */ }
      if (settled || !running) return;
      log.error('turns', 'A turn lost its work item\'s lease while it ran here; ending this process so the next claim carries it on alone', {
        workId: ctx.workId, kind: ctx.input?.kind || null, instance: ctx.input?.instanceKey || null,
      });
      LOST_LEASE.exit(1);
    })();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { running = false; signal.removeEventListener('abort', onAbort); };
}

/** The turn machine's `turn.run` handler (src/workflow/turn/services.ts). */
async function run(ctx, deps) {
  const input = ctx.input || {};
  const kind = KINDS.get(input.kind);
  if (!kind) throw Object.assign(new Error(`not a turn kind: ${input.kind}`), { permanent: true });
  // A turn asked to resume (an older release's headless run:
  // turn-leftovers.js) starts where its row says it is, as a resumed one.
  const resumed = !!ctx.resumeFrom || (Number(ctx.lostAttempts) || 0) > 0 || input.resume === true;
  const stopRenewing = renewClaim(deps.pool, input);
  const releaseRun = holdHeadlessRun(input);
  const settledHere = endOnLostLease(ctx, deps.pool);
  try {
    const out = await (resumed ? kind.resume : kind.run)(ctx, deps, input);
    // Its end, which the request that asked for it waits for (session-bus.js
    // relay): the run's own `done` may come before the rest of its item (a
    // coding run carried on), and another turn's never ends that request.
    if (input.instanceKey && input.turnId != null) {
      const { turnEndEvent } = require('../workflow/turn/machine.ts');
      const key = String(input.instanceKey);
      require('./session-bus').publish(key.startsWith('agent:') ? key : Number(key.replace(/^session:/, '')),
        turnEndEvent(key, String(input.turnId)));
    }
    return out;
  } finally {
    settledHere();
    releaseRun();
    stopRenewing();
    // Unless this process lost the item (the next claim carries it on), a
    // coding record it still holds is released as it ends.
    if (!(ctx.signal && ctx.signal.aborted)) {
      await require('./turn-recovery').releaseLeftRecord({ pool: deps.pool, workId: ctx.workId }).catch((err) => {
        log.warn('turns', 'Could not release a record the turn left', { workId: ctx.workId, err: err.message });
      });
    }
  }
}

module.exports = { run, ownedChange, RECOVERY_RETRY, STOP_POLL, CLAIM_RENEW, LOST_LEASE, NO_RESPONSE };

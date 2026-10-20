'use strict';

// A coding turn whose process went before it ended: adopted, followed through
// its journal to its end, and its tail and wrap-up finished; or, its worker
// gone, abandoned with what it left (services/worker.js). Moved out of
// server.js unchanged: what a turn's own work item runs when it resumes
// (src/workflow/turn/), and, until every turn is one, what the leader's
// sweeps run.

const { getPool } = require('../db/pool');
const github = require('./github');
const worker = require('./worker');
const activeWorkersSvc = require('./active-workers');
const turnWatchdog = require('./turn-watchdog');
const recoveryRetry = require('./recovery-retry');
const turnLifecycle = require('./turn-lifecycle');
const { workflowTurnHeldSql } = require('../workflow/session-work.ts');
const stopRegistry = require('./stop-registry');
const sessionBus = require('./session-bus');
const turnEffects = require('./turn-effects');
const recoveryPills = require('./recovery-pills');
const stagingRecovery = require('./staging-recovery');
const stagingSvc = require('./staging');
const limits = require('./limits');
const events = require('./events');
const ws = require('./ws');
const log = require('./logger');
const processes = require('./processes');

let config = null;
function sharedConfig() {
  if (!config) config = require('../config').load();
  return config;
}

async function persistedActiveTurnExists(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      'SELECT active_turn FROM chat_sessions WHERE id = $1',
      [sessionId]
    );
    return !!rows[0]?.active_turn;
  } catch {
    // An unavailable DB cannot prove the retained state disappeared. Keep
    // ownership and try again rather than letting the watchdog race us.
    return null;
  }
}

function turnCleanupArgs(activeTurn) {
  return turnLifecycle.cleanupArgs(activeTurn);
}

async function reconcilePendingTurnCleanup(config) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT id, active_turn
       FROM chat_sessions
      WHERE active_turn->>'phase' = $1`,
    [turnLifecycle.PHASE_CLEANUP_PENDING],
  );
  for (const row of rows) {
    // A live process still finishing the turn cleans it up itself
    // (docs/plans/draining-releases.md); one whose holders cannot be read is
    // left for a later sweep.
    let held = true;
    try { held = (await processes.holders('session', row.id, pool)).length > 0; } catch { held = true; }
    if (held) continue;
    const args = turnCleanupArgs(row.active_turn);
    const cleared = await worker.finishTurn(row.id, args);
    if (!cleared) {
      log.warn('server', 'Pending turn cleanup remains durable for a later sweep', {
        sessionId: row.id,
      });
    }
  }
}

function scheduleRetainedOrphanRecovery(orphan, deps) {
  const sessionId = Number(orphan.sessionId);
  let releaseReservation = null;
  return recoveryRetry.scheduleRetainedRecovery({
    key: `interactive:${sessionId}`,
    hold: () => {
      if (!releaseReservation) {
        releaseReservation = activeWorkersSvc.beginSessionOperation(sessionId);
      }
    },
    release: () => {
      releaseReservation?.();
      releaseReservation = null;
    },
    // Every retry re-reads the durable phase. The timer is only scheduling;
    // it never remembers semantic recovery state in a closure.
    run: async () => {
      const activeTurn = await turnLifecycle.loadActiveTurn(deps.pool, sessionId);
      const action = turnLifecycle.recoveryAction(activeTurn);
      if (action === 'none' && !orphan.retryWorkerRecovery) return;
      if (action === 'cleanup') {
        const args = turnCleanupArgs(activeTurn);
        recoveryRetry.requireDurableTurnCleanup(
          await worker.finishTurn(sessionId, args),
          args,
        );
        return;
      }
      if (action === 'quarantine') return;
      await adoptOrphanWorker(orphan, deps);
    },
    onError: async (err, { failures }) => {
      if (!recoveryRetry.shouldRetryRecoveryError(err)) {
        log.error('server', 'Orphan recovery has invalid durable state; leaving it quarantined', {
          name: orphan.name, sessionId, err: err.message,
        });
        return false;
      }
      const retained = err?.retainActiveTurn
        ? true
        : await persistedActiveTurnExists(deps.pool, sessionId);
      if (retained !== false) {
        log.warn('server', 'Retrying retained orphan recovery', {
          name: orphan.name, sessionId, failures, err: err.message,
          activeTurnObservable: retained !== null,
        });
        return true;
      }
      log.warn('server', 'Retried orphan adoption failed after durable turn cleared', {
        name: orphan.name, sessionId, err: err.message,
      });
      return false;
    },
    // Out of attempts (recovery-retry DEFAULT_MAX_FAILURES). The reservation
    // is released and the durable turn left in place, so the stale-turn
    // watchdog ends it like any unowned turn and tells the user.
    onExhausted: async (err, { failures }) => {
      log.error('server', 'Retained orphan recovery gave up; leaving the turn to the stale-turn watchdog', {
        name: orphan.name, sessionId, failures, err: err.message, code: err.code || null,
      });
    },
    onComplete: () => log.info('server', 'Retained orphan recovery completed', {
      name: orphan.name, sessionId,
    }),
    onHookError: (err) => log.warn('server', 'Orphan recovery retry hook failed', {
      name: orphan.name, sessionId, err: err.message,
    }),
  });
}

// Live handlers use the exact orphan-adoption state machine after retaining
// an active_turn. Supplying it at route construction avoids a circular
// sessions.js -> server.js import while keeping one semantic recovery path
// for live failures and process restarts.
function scheduleInteractiveTurnRecovery(sessionId) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const key = `interactive:${id}`;
  const scheduled = scheduleRetainedOrphanRecovery({
    name: worker.workerContainerName(id),
    sessionId: id,
    // Warm workers remain running after their detached turn exits; cleanup
    // phases bypass this value before adoption is attempted.
    state: 'running',
  }, {
    config: sharedConfig(),
    pool: getPool(sharedConfig()),
    staging: stagingSvc,
    ghub: github,
    broadcastGlobal: ws.broadcastGlobal,
  });
  // A duplicate request means the retained owner is already scheduled, not
  // that recovery is absent.
  return scheduled || recoveryRetry.isScheduled(key);
}

function recoveredAgentIdentity(session, activeTurn = null) {
  const backend = activeTurn?.backend || session?.agent_backend || 'claude_code';
  const isOpenRouter = backend === 'codex_openrouter';
  return {
    backend,
    isOpenRouter,
    name: isOpenRouter ? 'OpenRouter' : 'Claude Code',
    metadata: {
      agentBackend: backend,
      agentModel: activeTurn?.model || session?.agent_model || null,
    },
  };
}

// Codex owns a durable per-attempt ledger row in addition to active_turn.
// Once the latter is cleared there is no remaining pointer from recovery to
// the running attempt, so terminalize it first. A transient ledger failure
// retains the turn for retry; a missing attempt quarantines it through the
// same policy used by the stale-turn watchdog.
async function abandonCodexAttempt(pool, sessionId, turn, { label, errorDetail }) {
  if (turn?.backend !== 'codex_openrouter' || !turn?.turnUuid) return;
  const agentTurn = require('./agent-turn');
  try {
    await agentTurn.completeCodexAttempt({
      pool,
      turnUuid: turn.turnUuid,
      status: 'failed',
      errorCode: 'recovery_abandoned',
      errorDetail,
      telemetryComponent: turnLifecycle.phaseOf(turn) === turnLifecycle.PHASE_DISPATCH_PENDING
        ? null
        : turn.telemetryComponent || null,
      telemetryMetrics: {
        requestMode: turn.telemetryRequestMode || null,
        requestMessageCount: turn.telemetryRequestTextCharacters == null ? null : 1,
        requestUserMessageCount: turn.telemetryRequestTextCharacters == null ? null : 1,
        requestContentBlockCount: turn.telemetryRequestTextCharacters == null ? null : 1,
        requestTextCharacters: turn.telemetryRequestTextCharacters ?? null,
        requestUserTextCharacters: turn.telemetryRequestTextCharacters ?? null,
        requestPayloadCharacters: turn.telemetryRequestTextCharacters ?? null,
        modelContextWindowTokens: turn.telemetryModelContextWindowTokens ?? null,
        modelMaxOutputTokens: turn.telemetryModelMaxOutputTokens ?? null,
      },
    });
  } catch (ledgerErr) {
    const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
      pool,
      sessionId,
      activeTurn: turn,
      error: ledgerErr,
    });
    log.error('server', disposition.action === 'retry'
      ? `${label} Codex turn retained because ledger terminalization failed`
      : `${label} Codex turn quarantined because its ledger attempt is missing`, {
      sessionId, err: ledgerErr.message,
    });
    throw ledgerErr;
  }
}

// A shots turn cannot outlive the process that dispatched it: its
// MCP bridge calls back to that process's pod address, and the run it
// answers to exists only in that process's control registry. Resumed, the
// agent retries tool calls that can no longer succeed, holding the session
// busy and spending the user's model credit with no bound. End it instead,
// without chat narration — shots turns never write chat rows. A turn the
// shots machine's run follows is left to it (adoptOrphanWorker): only a
// turn with no run taking shots is ended here.
async function abandonOrphanShotsTurn({
  pool, sessionId, containerName, activeTurn, containerRunning, retryRuntimeRecovery,
}) {
  // A follower promoted to leader recovers its own workers too, and one of
  // them may be executing a shots run this process dispatched and still
  // bounds.
  if (worker.getActiveTurnMode(sessionId) === 'shots') {
    log.info('server', 'Shots turn is live in this process; leaving it to its run', {
      containerName, sessionId,
    });
    return;
  }
  const args = turnCleanupArgs(activeTurn);
  if (containerRunning) {
    worker.adoptWarmWorker(sessionId, containerName);
    await worker.stopTurn(sessionId);
    // The stop targeted the orphan. Left pending, it would make the next
    // dispatch — the user's preview retry — skip as stopped during spin-up.
    worker.clearPendingStop(sessionId);
    if (await worker.isWorkerExecuting(containerName) !== false) {
      throw retryRuntimeRecovery('Orphaned shots turn is not confirmed stopped');
    }
  }
  await abandonCodexAttempt(pool, sessionId, activeTurn, {
    label: 'Orphaned shots',
    errorDetail: 'Visual-shots turn was abandoned after the platform process that dispatched it exited.',
  });
  recoveryRetry.requireDurableTurnCleanup(
    containerRunning
      ? await worker.finishTurn(sessionId, args)
      : await worker.clearActiveTurn(sessionId, args),
    args,
  );
  log.warn('server', 'Abandoned an orphaned shots turn its process left', {
    containerName, sessionId,
    turnId: turnLifecycle.turnIdentity(activeTurn),
    backend: activeTurn.backend || null,
  });
  if (!containerRunning) await worker.destroyWorker(containerName);
}

// #3654: a benchmark trial's worker that outlived a restart and that no
// durable build holds any more (its build ended, or failed: bot-build's
// `build.lost` records the trial, services/bench/lane.js recordLostTrial).
// The same abandonment as a shots turn's (above), then the session is
// archived. The trial is its build's: nothing here puts it back.
async function abandonOrphanBenchTurn({
  pool, session, sessionId, containerName, containerRunning, retryRuntimeRecovery,
}) {
  const activeTurn = session.active_turn || null;
  if (activeTurn) {
    const args = turnCleanupArgs(activeTurn);
    if (containerRunning) {
      worker.adoptWarmWorker(sessionId, containerName);
      await worker.stopTurn(sessionId);
      worker.clearPendingStop(sessionId);
      if (await worker.isWorkerExecuting(containerName) !== false) {
        throw retryRuntimeRecovery('Orphaned benchmark turn is not confirmed stopped');
      }
    }
    await abandonCodexAttempt(pool, sessionId, activeTurn, {
      label: 'Orphaned benchmark',
      errorDetail: 'A benchmark trial was abandoned after the platform process that dispatched it exited.',
    });
    recoveryRetry.requireDurableTurnCleanup(
      containerRunning
        ? await worker.finishTurn(sessionId, args)
        : await worker.clearActiveTurn(sessionId, args),
      args,
    );
  }
  // Closed by the proposal machine, which destroys its worker too.
  const { rows: [now] = [] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
  if (now && ['active', 'paused'].includes(now.status)) {
    await require('../workflow/platform.ts').closeProposal({ sessionId: Number(sessionId), reason: 'bench', from: now.status })
      .catch((err) => log.warn('server', 'Could not close an abandoned benchmark trial\'s session', { sessionId, err: err.message }));
  }
  await worker.destroyWorker(containerName).catch(() => {});
  log.warn('server', 'Abandoned a benchmark trial\'s worker its process left', { containerName, sessionId });
}

function homeroomBotRecovery() {
  return require('./homeroom-bot');
}

/**
 * #3401: a worker of the Homeroom bot's that outlived a restart and that no
 * durable build owns (a build's session is its build's: adoptOrphanWorker
 * leaves it alone before this). What is left is a read (its triage), which
 * the bot's queue reads again: its turn is stopped and its record cleared,
 * its ledger attempt closed, and its session put back to rest. The bot's
 * builds no longer come here: they carry themselves on (services/build-runs.js).
 */
async function adoptBotOrphan({ pool, session, sessionId, containerName, containerState }) {
  const bot = homeroomBotRecovery();
  const activeTurn = session.active_turn || null;
  if (activeTurn) {
    const args = turnCleanupArgs(activeTurn);
    if (containerState === 'running') {
      worker.adoptWarmWorker(sessionId, containerName);
      await worker.stopTurn(sessionId).catch(() => {});
      worker.clearPendingStop(sessionId);
    }
    await abandonCodexAttempt(pool, sessionId, activeTurn, {
      label: 'Orphaned Homeroom bot read',
      errorDetail: 'A Homeroom bot read was stopped after the platform process that dispatched it exited; its request is read again.',
    });
    recoveryRetry.requireDurableTurnCleanup(
      containerState === 'running'
        ? await worker.finishTurn(sessionId, args)
        : await worker.clearActiveTurn(sessionId, args),
      args,
    );
  }
  if (containerState !== 'running') await worker.destroyWorker(containerName).catch(() => {});
  await bot.abandonRecoveredTurn({
    pool, session, why: activeTurn ? 'the platform restarted during its turn' : 'no turn was in flight',
  });
}

// `owned`: the caller is the work item the turn's record names as its owner
// (a turn carried on after its process went: services/turns.js), so the
// turn is its to finish: none of the checks that leave a turn to someone
// else apply.
async function adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal }, { owned = false } = {}) {
  const { name: containerName, sessionId } = orphan;
  let containerState = orphan.state;
  const kubernetesWorker = worker.usesKubernetesWorkers();
  const retryRuntimeRecovery = (message) => Object.assign(new Error(message), {
    retainActiveTurn: true, retryWorkerRecovery: true,
  });

  const { rows } = await pool.query(
    // #896: app_self_hosted rides along so the recovered turn's Mayor
    // wrap-up gets the same system prompt a live turn would (the
    // self-hosted block changes what the Mayor is allowed to say).
    // And whether a durable build that owns the session is still under way
    // (bot-build, docs/plans/bot-build-workflow.md).
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
            a.self_hosted AS app_self_hosted, u.username,
            u.is_synthetic AS user_is_synthetic,
            ((cs.workflow_owner IS NOT NULL AND EXISTS (
              SELECT 1 FROM wf_instances w
               WHERE w.machine = split_part(cs.workflow_owner, '/', 1)
                 AND w.key = substr(cs.workflow_owner, length(split_part(cs.workflow_owner, '/', 1)) + 2)
                 AND w.state = 'building'
            )) OR ${workflowTurnHeldSql('cs.active_turn')}) AS workflow_owned
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     JOIN users u ON cs.user_id = u.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) {
    // Session gone (archived/deleted). Just reap the container.
    log.info('server', 'Orphan has no session row — removing', { containerName });
    await worker.destroyWorker(containerName);
    return;
  }
  const session = rows[0];

  // A turn this process is following itself is no orphan. A follower serves
  // requests and starts turns during a rollout's overlap, before it is
  // promoted; adopting its own live turn here put a second consumer on its
  // journal and finished it twice (cards, vote resets, wrap-ups), and the
  // adoption's `finally` took the live owner's busy flag with it.
  if (!owned && (worker.getActiveTurnMode(sessionId) || activeWorkersSvc.isSessionBusyHere(sessionId))) {
    log.info('server', 'A turn on this worker is live in this process; not adopting it', { containerName, sessionId });
    return;
  }
  // Nor one another live process is following: the Pod a release replaced
  // finishes its turns while this one leads (docs/plans/draining-releases.md),
  // holding their sessions until they end (services/processes.js). Read
  // exactly: a session whose holders cannot be read is retried, not taken.
  let holders = [];
  try {
    if (!owned) holders = await processes.holders(['session', 'sync'], sessionId, pool);
  } catch (err) {
    throw retryRuntimeRecovery(`could not read who holds the session: ${err.message}`);
  }
  if (holders.length) {
    log.info('server', 'A turn on this worker is live in another process; not adopting it', {
      containerName, sessionId, holders,
    });
    return;
  }

  // A durable build's session, or a turn workflow work runs (its record
  // names its work item, still outstanding): its worker and its turn are
  // that work's, which the next leader claims and carries on from its last
  // saved step. The worker is kept and registered; nothing else is done to
  // it here.
  if (session.workflow_owned && !owned) {
    if (containerState === 'running') worker.adoptWarmWorker(sessionId, containerName);
    log.info('server', 'Leaving a workflow turn\'s worker to its work', {
      containerName, sessionId, owner: session.workflow_owner, state: containerState,
    });
    return;
  }

  const recoveryAction = turnLifecycle.recoveryAction(session.active_turn);
  if (recoveryAction === 'quarantine') {
    log.error('server', 'Orphan turn is quarantined; preserving durable state and stopping worker', {
      sessionId,
      turnId: turnLifecycle.turnIdentity(session.active_turn),
      quarantineCode: session.active_turn?.quarantineCode || null,
    });
    // destroyWorker removes only the container/registry entry; the session
    // volume (and therefore the quarantined journal) remains for operators.
    await worker.destroyWorker(containerName);
    return;
  }
  if (recoveryAction === 'cleanup') {
    const args = turnCleanupArgs(session.active_turn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, args),
      args,
    );
    session.active_turn = null;
  }

  // #1006: except a Homeroom bot session paused under a turn in flight,
  // whose turn is stopped and its record cleared (adoptBotOrphan below),
  // and a benchmark trial's (abandonOrphanBenchTurn): destroying it here, in
  // silence and with its turn record left, lost six platform builds on 10-02.
  if (!['active', 'promoted'].includes(session.status)
      && !homeroomBotRecovery().isRecoveredBotSession(session)
      && !require('./bench/runner').isRecoveredBenchSession(session)) {
    // Session became non-runnable while we were down — drop the container.
    await worker.destroyWorker(containerName);
    return;
  }

  // #3654: a Homeroom bot benchmark trial is never recovered into the
  // dev-chat tail below, which would open a PR, build staging and notify,
  // none of which a trial may do. A trial is a durable build, left to its
  // build above; one that is not (it started before trials were durable)
  // has its turn stopped and abandoned, and the trial put back in the
  // lane's queue (services/bench/lane.js).
  if (require('./bench/runner').isBenchSession(session)) {
    await abandonOrphanBenchTurn({
      pool, session, sessionId, containerName,
      containerRunning: containerState === 'running',
      retryRuntimeRecovery,
    });
    return;
  }

  // #183: headless auto sessions own their multi-step loop for ALL
  // container states — the turn resume AND the Mayor wrap-up continuation
  // both happen in resumeHeadlessRuns (runs right after worker adoption).
  // Running containers are registered warm so that loop can drive them;
  // exited ones are left strictly alone: scraping them here would replay
  // the interactive post-turn tail (PR + staging on the auto branch — the
  // original #183 bug) and clearing active_turn would destroy the journal
  // pointer the cc_running resume step needs. Leftover exited containers
  // are reaped by the normal worker sweeps once the run goes terminal.
  if (session.is_headless) {
    if (containerState === 'running') {
      log.info('server', 'Adopting headless worker (resume owned by resumeHeadlessRuns)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
    } else {
      log.info('server', 'Leaving exited headless worker to resumeHeadlessRuns', {
        containerName, sessionId,
      });
    }
    return;
  }

  if (kubernetesWorker) {
    // Re-read on every retry: the startup inventory may describe a Pod that
    // was still starting. An API failure or non-ready Deployment is not death.
    try { containerState = await worker.getWorkerStatus(containerName); }
    catch (_) { throw retryRuntimeRecovery('Kubernetes worker state is unavailable'); }
    if (!['running', 'not_found'].includes(containerState)) {
      throw retryRuntimeRecovery('Kubernetes worker is not ready for recovery');
    }
  }

  // #3401: the Homeroom bot's own turns are the bot's to finish. A shadow
  // build must leave no PR, staging, wrap-up or notification, which is what
  // the dev-chat tail below would give it.
  if (homeroomBotRecovery().isRecoveredBotSession(session)) {
    await adoptBotOrphan({
      config, pool, staging, broadcastGlobal, session, sessionId, containerName, containerState,
    });
    return;
  }

  if (session.active_turn?.mode === 'sync') {
    // The proposal machine's sync follows its turn through a restart
    // (its branch.sync work over services/durable-turn.js): left to it.
    const syncing = await require('../workflow/platform.ts').syncUnderWay(sessionId).catch(() => null);
    if (syncing) {
      log.info('server', 'A sync turn its proposal follows; not adopting it', { containerName, sessionId });
      return;
    }
  }

  if (session.active_turn?.mode === 'shots') {
    // The shots machine's agent step follows its turn through a restart
    // (services/durable-turn.js): left to it while its run is taking shots.
    const shots = await require('../workflow/platform.ts').shotsInstance(sessionId).catch(() => null);
    if (shots?.state === 'taking_shots') {
      log.info('server', 'A shots turn its run follows; not adopting it', { containerName, sessionId });
      return;
    }
    await abandonOrphanShotsTurn({
      pool, sessionId, containerName,
      activeTurn: session.active_turn,
      containerRunning: containerState === 'running',
      retryRuntimeRecovery,
    });
    return;
  }

  // Long-lived worker reality check: a *running* container could be
  //   (a) a warm-idle wrapper sitting in `sleep infinity` — clean adopt,
  //       no log scrape needed.
  //   (b) a legacy single-shot still in flight — only possible during
  //       rollout from the old worker contract; tail logs as before.
  //   (c) a warm wrapper with a detached turn in flight (or finished
  //       while we were down). The turn's output lives in a journal
  //       file in the CC volume, recorded on chat_sessions.active_turn
  //       — resume it from line 0 and finish the post-turn work as if
  //       we'd never restarted.
  //   (d) a mid-exec wrapper from BEFORE the detached-turn contract
  //       (no active_turn record). Its output went to a dead pipe and
  //       is unrecoverable; kill it so it can't race the next dispatch.
  if (containerState === 'running') {
    // Case (c): detached turn with a durable record — resume it. This now
    // covers TWO shapes, distinguished only by `phase`:
    //   - phase absent  → the exec itself may still be running; the replay
    //                     follows the journal live before the tail runs.
    //   - phase 'tail'  → the agent finished cleanly and the PLATFORM side
    //                     was cut off (session 2954). The journal is
    //                     complete, so the replay returns immediately and
    //                     finalizeRecoveredTurn picks the tail up where it
    //                     stopped, skipping whatever already landed.
    // Both go down the same path deliberately: the tail is the same tail.
    const activeTurn = session.active_turn || null;
    if (activeTurn && activeTurn.journal) {
      worker.adoptWarmWorker(sessionId, containerName);
      await resumeDetachedTurn({
        config, pool, staging, broadcastGlobal, session, sessionId,
        containerName, activeTurn,
      });
      return;
    }

    const busy = await worker.isWorkerExecuting(containerName);
    if (kubernetesWorker && busy === null) {
      throw retryRuntimeRecovery('Kubernetes worker liveness is unavailable');
    }
    if (busy === false) {
      // Nothing is executing and there's no record to resume — normally
      // an idle warm container, correctly adopted in silence.
      //
      // But this branch is ALSO where a lost tail landed before the record
      // was held across it: the container was idle (the agent really had
      // finished), so adoption returned here and the chat kept
      // "Building staging preview..." as its last word forever, with no
      // spinner, no card and no error. Change 1 makes that unreachable —
      // this stays as the guard for a record lost some other way (a
      // clearActiveTurn bug, a journal deleted under us, a pre-upgrade row
      // written by an older build).
      const dangling = await findDanglingTail(pool, sessionId);
      if (dangling) {
        log.warn('server', 'Adopting warm-idle worker with a DANGLING tail — narrating', {
          containerName, sessionId, lastRow: dangling.content,
        });
        await narrateDanglingTail({ config, pool, session, sessionId, broadcastGlobal });
        worker.adoptWarmWorker(sessionId, containerName);
        return;
      }
      log.info('server', 'Adopting warm-idle worker (no in-flight exec)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    if (busy === true && (session.cc_session_id || kubernetesWorker)) {
      // Case (d) conservative recovery: the prior in-flight turn
      // predates the detached contract and is unrecoverable from the
      // host. Kill the orphan exec to free the warm container for
      // fresh dispatches, then post a system message so the user
      // knows to retry.
      log.info('server', 'Adopting mid-exec worker — killing orphan exec', {
        containerName, sessionId,
      });
      // worker.stopTurn walks /proc inside the container — the worker
      // image has no pkill (see TURN_PROC_KILL_SCRIPT in worker.js).
      await worker.stopTurn(sessionId).catch(() => {});
      // #786: the breadcrumb carries the turn's quick-reply pills. The
      // Mayor wrap-up that normally supplies them can't run here, and
      // without pills the bar above the composer stays empty until the
      // user types — so there'd be no one-tap way to retry.
      const killedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          recoveryPills.TURN_UNFINISHED_BREADCRUMB,
          JSON.stringify({
            ...(killedPills ? { quickReplies: killedPills } : {}),
            // #896: the restart moves off the user's screen and into the
            // row's metadata — same text for every unresumable shape,
            // `recoveredReason` keeps them apart for an operator.
            recovered: true,
            recoveredReason: 'mid_exec_killed',
          }),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        quickReplies: killedPills || undefined,
      });
      await notifyTurnStalled(pool, sessionId);
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    // busy === null (couldn't probe) or true with no cc_session_id
    // (legacy single-shot rollout): fall through to the legacy
    // watchWorker scrape. Safe on already-exited containers; for a
    // hung warm wrapper it'd block, but the idle sweeper plus session
    // archive cap the worst case.
  } else if (session.active_turn) {
    // A detached turn was recorded but its container is gone (evicted /
    // host reboot). The journal lives in the unreachable volume, so the
    // turn itself can't be replayed — but if it pushed before dying,
    // the branch is rebuilt below when its code landed. Clear the
    // record and let the user know.
    const goneTurn = session.active_turn;
    const goneTail = (goneTurn && typeof goneTurn.tail === 'object' && goneTurn.tail) || {};
    // Did the work actually land? A held TAIL record knows: the exec is
    // over and its seed milestones carry the commit + push outcome. When
    // it did, "send your request again" is simply wrong — the commit is on
    // GitHub, and resending buys a duplicate run (see
    // buildCodeLandedBreadcrumb). Say what landed and repair the preview.
    const codeLanded = !!goneTail.sha && goneTail.pushOk === true;
    await abandonCodexAttempt(pool, sessionId, goneTurn, {
      label: 'Gone',
      errorDetail: 'Durable turn was abandoned after its worker container disappeared.',
    });
    recoveryRetry.requireDurableTurnCleanup(
      await worker.clearActiveTurn(sessionId, turnCleanupArgs(goneTurn)),
      turnCleanupArgs(goneTurn),
    );
    // Terminal marker so the dead turn's progress card doesn't stay
    // frozen on its last in-progress line ("Pushing", "Editing …").
    await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    if (codeLanded) {
      const prNumber = goneTail.prNumber || session.pr_number || null;
      // 'code_done' rather than 'unrecoverable': the useful next steps are
      // Propose / tweak, not "try that again".
      const landedPills = recoveryPills.buildRecoveryQuickReplies('code_done');
      const landedText = recoveryPills.buildCodeLandedBreadcrumb({
        prNumber, rebuildingPreview: true,
      });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          landedText,
          JSON.stringify({
            ...(landedPills ? { quickReplies: landedPills } : {}),
            recovered: true,
            recoveredReason: 'tail_worker_gone',
            sha: goneTail.sha,
            ...(prNumber ? { prNumber } : {}),
          }),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: landedText,
        quickReplies: landedPills || undefined,
      });
      log.warn('server', 'Tail record with a dead worker — code landed, healing preview', {
        sessionId, sha: String(goneTail.sha).substring(0, 8), prNumber,
      });
      // The preview is the only missing artefact, and rebuildSessionStaging
      // is the shared path that also re-runs the proposal checks. Awaited
      // (not fire-and-forget) so boot recovery's per-session try/catch owns
      // the failure.
      try {
        await stagingRecovery.rebuildSessionStaging({
          config, pool, session, reason: 'tail_worker_gone',
        });
      } catch (err) {
        log.warn('server', 'Tail-recovery staging rebuild failed', {
          sessionId, err: err.message,
        });
      }
      return;
    }
    // #786: pills on the breadcrumb — see the mid-exec branch above.
    const goneP = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [
        sessionId,
        recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        JSON.stringify({
          ...(goneP ? { quickReplies: goneP } : {}),
          recovered: true,
          recoveredReason: 'worker_gone',
        }),
      ]
    ).catch(() => {});
    await notifyTurnStalled(pool, sessionId);
  }

  // All running Kubernetes workers return above. A positively missing one
  // has had its durable recovery handled; there are no container logs to
  // scrape or a legacy result to synthesize.
  if (kubernetesWorker) {
    await worker.destroyWorker(containerName);
    return;
  }

  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  // #896: the same in-flight label a live turn shows. The recovery is
  // plumbing; from the user's side a coding agent is simply running.
  const recoveryAgent = recoveredAgentIdentity(session, session.active_turn);
  emit('status', {
    text: `${recoveryAgent.name} is running...`,
    ...recoveryAgent.metadata,
  });

  const result = await worker.watchWorker(containerName, {
    onProgress: (text) => {
      emit('cc_progress', { text, ...recoveryAgent.metadata });
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(
           metadata, '{progressLog}',
           (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
         )
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify([text]), sessionId]
      ).catch(() => {});
    },
  });

  const finalized = await finalizeRecoveredTurn({
    config, pool, staging, session, sessionId, result, repoOwner, repoName,
    emit, containerName,
    activeTurn: session.active_turn || null,
    // Legacy single-shot containers are per-turn; reap when done.
    keepWorker: false,
  });
  if (recoveryAgent.isOpenRouter && finalized?.summary) {
    const { runRecoveredWrapUp } = require('../routes/sessions');
    await runRecoveredWrapUp({
      pool, config, session, sessionId,
      outcome: result.ahead > 0 && result.sha ? 'code' : 'no_changes',
      dispatchSummary: finalized.summary,
      fallbackPillKind: result.ahead > 0 && result.sha ? 'code_done' : 'chat_generic',
      turnModel: recoveryAgent.metadata.agentModel,
      turnId: session.active_turn?.turnId || null,
      emit,
    });
  }
}

// Shared post-turn finalization for both recovery transports (legacy
// `docker logs` scrape and detached-journal resume): persist the CC
// session id, then — when the turn pushed a commit — run the same PR +
// staging tail the live dev-turn path runs. `keepWorker` distinguishes
// the long-lived warm contract (container stays adoptable) from the
// legacy single-shot contract (container is reaped when done).
// Append one line to the session's latest persisted progressLog row —
// the same row flushProgress/onProgress write to. Used to stamp a
// terminal marker ([interrupted] etc.) on turns whose journal can't
// provide one, so the dev-chat progress card never ends frozen on an
// in-progress label. Best-effort: a session with no progress row is a
// clean no-op (the WHERE id subquery matches nothing).
// The status texts a dev turn's TAIL emits before it is finished. If one
// of these is a session's newest system row and no completion artefact
// followed it, the tail was cut off: the transcript's last word is
// "…preview" or "PR #N created" and nothing will ever come after it.
//
// Matched loosely (prefix / regex) because the wording is shared with the
// live path, which owns it — see sendStatus in routes/sessions.js.
const TAIL_IN_PROGRESS_PATTERNS = [
  /^Building staging preview/i,
  /^PR #\d+ created$/i,
];

// Is session `sessionId`'s transcript sitting on an unfinished tail?
//
// "Finished" means the newest system row carries one of the artefacts a
// completed tail produces — the agent's summary card (ccOutput), the
// Changes-ready card (stagingUrl / changesReady), an explicit failure
// (stagingFailed / checkError / turnError) — or an assistant reply came
// after it (the Mayor's wrap-up, which is always last). Anything else
// with a tail-in-progress row on top is dangling.
//
// Returns the offending row or null. Deliberately cheap: one indexed
// lookup of the last few rows.
async function findDanglingTail(pool, sessionId) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT role, content, metadata FROM chat_session_messages
        WHERE session_id = $1 AND role IN ('system', 'assistant')
        ORDER BY id DESC LIMIT 1`,
      [sessionId]
    ));
  } catch (err) {
    log.warn('server', 'Dangling-tail probe failed', { sessionId, err: err.message });
    return null;
  }
  const row = rows[0];
  if (!row || row.role !== 'system') return null;
  const meta = row.metadata || {};
  if (meta.ccOutput || meta.stagingUrl || meta.changesReady
      || meta.stagingFailed || meta.checkError || meta.turnError) {
    return null;
  }
  const content = String(row.content || '');
  return TAIL_IN_PROGRESS_PATTERNS.some((re) => re.test(content)) ? row : null;
}

// Close out a dangling tail we cannot resume (no record, no journal): the
// honest breadcrumb, a terminal progress marker so the card stops reading
// as in-flight, and a preview heal when the branch carries work.
//
// This is the fallback wording, so it can't inspect a milestone map —
// what it knows comes from the session row. A session with a pr_number
// pushed successfully (the PR could not exist otherwise), so it earns the
// "code landed" wording; anything else gets the resend breadcrumb.
async function narrateDanglingTail({ config, pool, session, sessionId, broadcastGlobal }) {
  await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
  const landed = !!session.pr_number;
  const kind = landed ? 'code_done' : 'unrecoverable';
  const pills = recoveryPills.buildRecoveryQuickReplies(kind);
  const text = landed
    ? recoveryPills.buildCodeLandedBreadcrumb({
      prNumber: session.pr_number, rebuildingPreview: true,
    })
    : recoveryPills.TURN_UNFINISHED_BREADCRUMB;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [sessionId, text, JSON.stringify({
      ...(pills ? { quickReplies: pills } : {}),
      recovered: true,
      recoveredReason: 'dangling_tail',
    })]
  ).catch(() => {});
  broadcastGlobal({
    type: 'session_event', sessionId, event: 'status',
    text, quickReplies: pills || undefined,
  });
  // #3181: the resend breadcrumb is a turn that stopped before finishing.
  if (!landed) await notifyTurnStalled(pool, sessionId);
  if (!landed) return;
  // Heal the preview here rather than leave the row promising a rebuild
  // that nothing started.
  try {
    if (await stagingRecovery.stagingNeedsRebuild(session, { config })) {
      await stagingRecovery.rebuildSessionStaging({
        config, pool, session, reason: 'dangling_tail',
      });
    }
  } catch (err) {
    log.warn('server', 'Dangling-tail staging rebuild failed', { sessionId, err: err.message });
  }
}

async function appendTerminalProgressLine(pool, sessionId, line) {
  await pool.query(
    `UPDATE chat_session_messages
     SET metadata = jsonb_set(metadata, '{progressLog}',
       (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb))
     WHERE id = (
       SELECT id FROM chat_session_messages
       WHERE session_id = $2 AND role = 'system'
         AND metadata->>'progressLog' IS NOT NULL
       ORDER BY id DESC LIMIT 1
     )`,
    [JSON.stringify([line]), sessionId]
  ).catch(() => {});
}

// #3181: a turn the platform could not finish tells its owner, in the bell
// and as a push, that the session stopped before finishing, instead of
// leaving the breadcrumb for them to find whenever they next look. Called
// beside every "didn't finish, send it again" breadcrumb (a worker lost to
// a restart or an eviction, a failed replay, an orphan the watchdog reaps).
// Never throws: notifySessionStalled swallows its own errors.
async function notifyTurnStalled(pool, sessionId) {
  await require('../routes/sessions').notifySessionStalled(pool, sessionId);
}

// Returns { outcome, summary } for the recovered turn:
//
//   outcome — the terminal state for the progress card: 'done' (turn
//     wrapped up, including the no-changes case), 'push_failed' (commit
//     exists only in the worker — re-push heal failed), or 'skip'
//     (headless — owned by resumeHeadlessRuns).
//   summary — the dispatch narrative for the Mayor wrap-up, assembled the
//     same way runClaudeCodeTool builds its `summaryParts` tool result.
//     Null on 'skip'. #896: without this the wrap-up would have to
//     re-derive what happened from the transcript.
//
// Every persisted row carries metadata.recovered so an operator can find
// recovery-written rows in SQL — the audit trail that replaces the
// restart wording the build cards used to carry (#896).
//
// `alreadyDone` is the interrupted turn's tail-milestone map
// (active_turn.tail — written by the live tail as each step landed; see
// the "Post-agent TAIL" note in services/worker.js). It exists because
// this function is now also reached for a turn whose EXEC finished
// cleanly and whose TAIL was cut in half by a restart, so some of the
// work below has already happened once. Every step it gates is one that
// is NOT naturally idempotent: a duplicate completion card, a duplicate
// PR-opened event, a redundant ~5-minute staging rebuild. Absent/empty
// (a genuine mid-exec recovery) means "nothing landed yet" and the whole
// tail runs, exactly as before.
async function finalizeRecoveredTurn({
  config, pool, staging, session, sessionId, result, repoOwner, repoName,
  emit, containerName, keepWorker, startedAtMs, alreadyDone = null,
  activeTurn = null,
  // The machine a local agent's turn ran on (services/local-agent-recovery.js):
  // its completion card names it, as the live card does.
  localAgentLabel = null,
}) {
  const done = alreadyDone && typeof alreadyDone === 'object' ? alreadyDone : {};
  const recoveryAgent = recoveredAgentIdentity(session, activeTurn);
  if (localAgentLabel) {
    recoveryAgent.metadata = {
      agentBackend: 'claude_code', agentModel: null,
      runner: 'local', localAgentLabel, localMode: 'build',
    };
  }
  const noteMilestone = async (milestone) => {
    if (!activeTurn) return false;
    const noted = await worker.noteTailMilestone(
      sessionId,
      milestone,
      turnLifecycle.cleanupArgs(activeTurn),
    );
    if (noted) Object.assign(done, milestone);
    return noted;
  };
  // #183 belt-and-braces: headless rows must never get the interactive
  // post-turn tail (PR on the auto branch + staging + system message) from
  // any recovery transport — resumeHeadlessRuns owns them. adoptOrphanWorker
  // already routes headless sessions away before reaching here; this guard
  // protects against future transports forgetting to.
  if (session.is_headless) {
    log.info('server', 'Skipping recovered-turn finalize for headless session (owned by resumeHeadlessRuns)', {
      sessionId,
    });
    return { outcome: 'skip', summary: null };
  }

  const summaryParts = [];
  // Turn duration for the completion card's "(took 4m 12s)" suffix. The
  // pre-restart process recorded when the turn started on active_turn;
  // a legacy record without it just omits the suffix.
  const durationMs = startedAtMs ? Date.now() - startedAtMs : null;

  // #896: the live path persists an outcome-aware completion row carrying
  // the agent's own summary (sessions.js runClaudeCodeTool). Recovery
  // persisted none, so the coding-agent completion card was missing
  // AND every later Mayor turn was blind to what this turn built
  // (buildMayorMessages folds ccOutput rows into the model's context).
  const persistCompletionRow = async (ccText, ccOutcome) => {
    if (!ccText) return;
    const directOpenRouterReply = recoveryAgent.isOpenRouter && ccOutcome === 'no_changes';
    // The interrupted tail already wrote this card — a second one would
    // duplicate the agent's summary in the transcript AND double-count it
    // in every later Mayor turn's context (buildMayorMessages folds
    // ccOutput rows in). The summary still goes to the wrap-up below.
    if (done.completionRowPosted) {
      log.info('server', 'Recovered turn: completion card already posted — skipping', { sessionId });
      if (directOpenRouterReply) summaryParts.unshift(ccText);
      else summaryParts.unshift(`What the agent did:\n${ccText}`);
      return;
    }
    const statusText = (ccOutcome === 'success'
      ? `${recoveryAgent.name} finished`
      : ccOutcome === 'no_changes'
        ? (recoveryAgent.isOpenRouter
          ? `${recoveryAgent.name} replied`
          : `${recoveryAgent.name} made no changes`)
        : `${recoveryAgent.name} did not complete`)
      + (localAgentLabel ? ` Coding done on ${localAgentLabel}, so no Homeroom credits were used.` : '');
    const metadata = {
      ccOutput: ccText,
      ccOutcome,
      ...recoveryAgent.metadata,
      ...(durationMs != null ? { durationMs } : {}),
      recovered: true,
    };
    let emitted = true;
    if (!directOpenRouterReply) {
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: 'completion_row',
          sessionId,
          run: async (client) => {
            await client.query(
              `INSERT INTO chat_session_messages (session_id, role, content, metadata)
               VALUES ($1, 'system', $2, $3)`,
              [sessionId, statusText, JSON.stringify(metadata)],
            );
            return { persisted: true };
          },
        });
        emitted = receipt.applied;
      } else {
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, statusText, JSON.stringify(metadata)],
        );
      }
      if (emitted) emit('status', { text: statusText, ...metadata });
    }
    await noteMilestone({ completionRowPosted: true });
    if (directOpenRouterReply) summaryParts.unshift(ccText);
    else summaryParts.unshift(`What the agent did:\n${ccText}`);
  };

  // #127 parity: peel the TESTING block off the agent's summary once, up
  // front — the cleaned text is both what the completion card shows and
  // what feeds the PR body prompt below.
  const testingNotes = require('./testing-notes');
  const recoveredTesting = testingNotes.extract(result.lastResultText || '');
  const recoveredCcSummary = (recoveredTesting.cleanedText || '').trim();

  // Capture the CC session id so the next turn can --resume, even though
  // the server process that originally spawned this worker is gone.
  const newCcId = result.sessionId || result.initSessionId || null;
  if (newCcId && newCcId !== session.cc_session_id) {
    await pool.query(
      `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
      [newCcId, sessionId]
    ).catch(() => {});
  }

  const hasChanges = result.ahead > 0 && !!result.sha;
  if (!hasChanges) {
    // #896: persist the same outcome-aware row the live path writes, so
    // the no-changes case survives a reload instead of vanishing with the
    // emit — and so the wrap-up below has something honest to describe.
    const noChangeOutcome = (result.fatalError || result.ccIsError) ? 'error' : 'no_changes';
    await persistCompletionRow(recoveredCcSummary, noChangeOutcome);
    if (result.fatalError) {
      summaryParts.push(`The coding agent hit an error: ${String(result.fatalError).substring(0, 200)}`);
    } else if (result.branchMismatch) {
      summaryParts.push('The coding agent ended up working on a different branch that does not build on this '
        + 'change, so nothing from the turn was saved. Tell the user to send the request again.');
    } else if (!recoveryAgent.isOpenRouter) {
      summaryParts.push('The coding agent finished without committing any changes.');
    }
    if (!keepWorker) await worker.destroyWorker(containerName);
    return { outcome: 'done', summary: summaryParts.join('\n\n') };
  }

  // The turn committed locally (ahead/sha set) but the worker's
  // usernode-push callback never landed the branch on GitHub
  // (push_ok=0 — e.g. the platform was mid-restart when the worker
  // called POST /api/internal/sessions/:id/push). `result.ahead` is
  // computed from the worker's LOCAL `origin/main..HEAD`, so it's >0
  // even with the remote branch still empty. Heal it here, while the
  // worker container still exists, before applyPrMetadata's createPR —
  // otherwise createPR 422s ("No commits between main and <branch>")
  // and, once the worker is evicted, the only copy of the commit is
  // gone. (chat 510 / issue #295: a restart mid-push left the branch
  // un-pushable and the work recoverable only from the CC transcript.)
  if (!result.pushOk) {
    try {
      const pushed = await worker.execPushFromWorker(sessionId, session.branch_name);
      result.pushOk = true;
      log.info('server', 'Recovered turn: re-pushed un-pushed branch', {
        sessionId, branch: session.branch_name,
        sha: (pushed?.sha || result.sha || '').substring(0, 8),
      });
    } catch (err) {
      // #1376: same treatment as the live tail — carry the real reason into
      // chat instead of a fixed "send your request again", which for a
      // permanently unpushable branch is advice that can only fail again.
      const failure = worker.describePushFailure(err);
      log.warn('server', 'Recovered turn: re-push failed — skipping PR creation', {
        sessionId,
        branch: session.branch_name,
        code: failure.code,
        permanent: failure.permanent,
        err: err.message,
      });
      const pushFailedText = failure.text;
      emit('status', { text: pushFailedText });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [sessionId, pushFailedText, JSON.stringify({
          recovered: true,
          pushFailureCode: failure.code,
          pushFailurePermanent: failure.permanent,
        })]
      ).catch(() => {});
      await persistCompletionRow(recoveredCcSummary, 'error');
      summaryParts.push(
        `The agent committed ${result.sha.substring(0, 8)} locally, but the push to `
        + `${session.branch_name} failed, so no PR was opened and no preview was built. `
        + (failure.permanent
          ? 'This failure is permanent for this session — do NOT tell the user to retry. '
            + `Reason: ${failure.text}`
          : 'Tell the user to send their request again to re-push and open the PR.')
      );
      if (!keepWorker) await worker.destroyWorker(containerName);
      return { outcome: 'push_failed', summary: summaryParts.join('\n\n') };
    }
  }

  try {
    // Pull the user's most recent message so the PR title helper has
    // the same "what did you ask for?" signal that the normal dev-turn
    // path gets via the live SSE request body. Without this, recovery
    // would hit the fallback template ("<user>'s changes") and never
    // regenerate titles for iterative edits.
    const { rows: userMsgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId]
    );
    const recoveredUserMessage = userMsgRows[0]?.content || '';

    // The turn committed and pushed: this is the live path's 'success'
    // completion card, written before the PR/staging work so the row
    // order matches a normal turn's transcript.
    await persistCompletionRow(recoveredCcSummary, 'success');
    summaryParts.push(`Commit ${result.sha.substring(0, 8)} pushed to ${session.branch_name}.`);

    // #127: same TESTING-block handling as the live dev-turn path —
    // persist the guidance (peeled off above) before applyPrMetadata
    // reads it back for the "How to test" section.
    if (recoveredTesting.testingMd || recoveredTesting.testingPath) {
      await pool.query(
        `UPDATE chat_sessions SET testing_md = $1, testing_path = $2 WHERE id = $3`,
        [recoveredTesting.testingMd, recoveredTesting.testingPath, sessionId]
      ).catch(() => {});
      session.testing_md = recoveredTesting.testingMd;
      session.testing_path = recoveredTesting.testingPath;
    }

    // Resolve a payer for a genuinely new recovery-side metadata call. A
    // completed/pending live receipt still carries and replays its original
    // payer; if this effect was never started and no payer is available, the
    // PR is completed with deterministic metadata instead of hidden spend.
    let prMetadataApiKey = null;
    let prMetadataGenerationAllowed = false;
    try {
      const billing = await limits.resolveBillingPath(
        pool, config.dataEncryptionKey, session.user_id,
      );
      if (!billing.error) {
        prMetadataApiKey = billing.apiKey;
        prMetadataGenerationAllowed = true;
      } else {
        log.info('server', 'Recovered turn using deterministic PR metadata', {
          sessionId, reason: billing.reason || null,
        });
      }
    } catch (err) {
      log.warn('server', 'Recovered PR metadata billing resolve failed', {
        sessionId, err: err.message,
      });
    }
    const prMetadataBillingByok = prMetadataGenerationAllowed && !!prMetadataApiKey;

    const wasNewPR = !session.pr_number;
    const prMetadata = require('./pr-metadata');
    const prResult = await prMetadata.applyPrMetadata({
      pool, session, repoOwner, repoName,
      userMessage: recoveredUserMessage,
      ccSummary: recoveredCcSummary,
      username: session.username,
      broadcast: (event, data) => emit(event, data),
      apiKey: prMetadataApiKey,
      userId: session.user_id,
      effectTurnId: activeTurn?.turnId || null,
      effectSessionId: sessionId,
      effectBillingByok: prMetadataBillingByok,
      allowModelGeneration: prMetadataGenerationAllowed,
    });
    // Live-path parity: a freshly opened PR gets its own transcript row,
    // so the recovered turn reads "PR #N created" like any other.
    // `done.prNumber` means the interrupted tail already opened (and
    // announced) this PR, so it isn't "new" here even though the session
    // row we were handed may predate that write.
    const prAnnounced = !!done.prNumber || !!done.prOpenedEventRecorded;
    if (prResult && prResult.prNumber && wasNewPR && !prAnnounced) {
      const prStatus = `PR #${prResult.prNumber} created`;
      let emitted = true;
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: 'pr_opened_announcement',
          sessionId,
          run: async (client) => {
            await client.query(
              `INSERT INTO chat_session_messages (session_id, role, content, metadata)
               VALUES ($1, 'system', $2, $3)`,
              [sessionId, prStatus,
                JSON.stringify({ prNumber: prResult.prNumber, recovered: true })],
            );
            await client.query(
              `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [
                session.user_id,
                session.app_id,
                sessionId,
                events.EVENT_TYPES.PR_OPENED,
                JSON.stringify({ prNumber: prResult.prNumber }),
              ],
            );
            return { prNumber: prResult.prNumber };
          },
        });
        emitted = receipt.applied;
      } else {
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, prStatus,
            JSON.stringify({ prNumber: prResult.prNumber, recovered: true })],
        );
        await events.record(pool, {
          type: events.EVENT_TYPES.PR_OPENED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId,
          metadata: { prNumber: prResult.prNumber },
        });
      }
      if (emitted) emit('status', { text: prStatus });
      await noteMilestone({
        prNumber: prResult.prNumber,
        prOpenedEventRecorded: true,
      });
      summaryParts.push(`Opened PR #${prResult.prNumber}: ${prResult.prUrl}`);
    } else if (session.pr_number || prResult?.prNumber) {
      summaryParts.push(`Pushed to existing PR #${session.pr_number || prResult.prNumber}.`);
    }

    // Live-path parity for a PROMOTED session (sessions.js's tail): a new
    // commit invalidates the votes cast against the old one, before the
    // commit goes to the preview machine, whose reviewed-head pin it moves.
    // Gated on the milestone so a reset the live tail already performed is
    // never re-announced.
    const retireVotesOnceStaged = async () => {
      if (session.status !== 'promoted' || done.votesResetFor === result.sha) return;
      try {
        // Claim before the destructive delete. If recovery dies after this
        // point, repeating the reset/announcement would be worse than
        // leaving the already-reset votes unannounced.
        await noteMilestone({ votesResetFor: result.sha });
        // #1688: retired by an epoch bump, not deleted — the same step the
        // live tail takes, so the recovered turn also asks the prior Yes
        // voters back, in the proposal's own thread.
        const retired = await require('../routes/sessions').retireVotesForNewCommit({
          pool, session, sessionId, commitHash: result.sha,
        });
        if (retired.retired > 0) {
          summaryParts.push('Group-chat votes were reset for the new commit.');
        }
      } catch (err) {
        log.warn('server', 'Recovered turn: vote reset failed (non-fatal)', {
          sessionId, err: err.message,
        });
      }
    };

    const stagingFailureSummary = (failure = {}) => (
      `Staging build failed.\n\nWhat still happened: commit ${result.sha.substring(0, 8)} was pushed to `
      + `${session.branch_name}${session.pr_number ? ` and PR #${session.pr_number} was created/updated` : ''}. `
      + `Only the staging preview container is missing — there is no preview URL for this commit.\n\n`
      + `${failure.fix || 'Retry the preview build when the staging issue is resolved.'}`
    );

    // The transcript card and its replay checkpoint commit together: a
    // retained tail must never publish its outcome twice on a later wrap-up
    // retry, nor after the live tail already did; both write it through
    // publishStagingOutcome, under one receipt. A failure a tail of an
    // earlier release checkpointed is still honoured below.
    const publishRecoveredStaging = async ({ outcome, stagingUrl = null }) => {
      const metadata = {
        changesReady: true,
        ...(outcome === 'success' ? { stagingUrl } : { stagingBuild: 'running' }),
        prNumber: prResult?.prNumber || session.pr_number || null,
        prUrl: prResult?.prUrl || session.pr_url || null,
        recovered: true,
      };
      const { applied, ...value } = await require('../routes/sessions')
        .publishStagingOutcome({
          pool,
          sessionId,
          turnId: activeTurn?.turnId || null,
          tailIdentity: activeTurn ? turnLifecycle.cleanupArgs(activeTurn) : null,
          outcome,
          metadata,
          failure: null,
        });
      // A completed receipt is authoritative if two recovery owners reached
      // this boundary with different observations. Restore the checkpoint
      // that committed with the card, not the retrying owner's proposal.
      const settledCheckpoint = value.checkpoint
        && typeof value.checkpoint === 'object'
        && !Array.isArray(value.checkpoint)
        ? value.checkpoint
        : (value.outcome === 'success'
            ? { stagingPublished: true }
            : {
                stagingPublished: true,
                stagingFailed: value.failure || { errMsg: value.metadata?.error || 'Staging build failed' },
              });
      Object.assign(done, settledCheckpoint);

      if (applied && value.outcome === 'success') {
        emit('staging_ready', {
          url: value.metadata.stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
      } else if (applied && value.outcome !== 'building') {
        emit('staging_failed', {
          error: value.metadata.error,
          errorName: value.metadata.stagingErrorName,
          missingKeys: value.metadata.stagingMissingKeys,
          changesReady: true,
          prNumber: value.metadata.prNumber,
          prUrl: value.metadata.prUrl,
        });
      }
      return { applied, ...value };
    };

    if (done.stagingFailed) {
      log.info('server', 'Recovered turn: staging failure already published — skipping rebuild', {
        sessionId,
      });
      summaryParts.push(stagingFailureSummary(
        typeof done.stagingFailed === 'object' ? done.stagingFailed : {},
      ));
      return { outcome: 'done', summary: summaryParts.join('\n\n') };
    }

    // The preview machine builds and checks the recovered commit; a preview
    // it already serves for this commit is joined rather than rebuilt. A
    // promoted proposal's votes are retired first: its reviewed head is the
    // pin the machine checks a revision against.
    emit('status', { text: 'Building staging preview...' });
    await retireVotesOnceStaged();
    // Non-fatal: the commit is pushed, and the boot heal hands a preview
    // that is missing to the machine on a later pass.
    const handed = await require('./preview-workflow').revision({
      pool, session, head: result.sha, source: 'turn', trigger: 'boot-reconcile',
    }).catch((err) => {
      log.warn('server', 'Recovered turn: preview hand-off failed', { sessionId, err: err.message });
      return null;
    });
    // The live tail handed this commit over before it died, and the machine
    // has built it since: the card says it is up rather than opening a
    // "building" one nothing will close.
    const { rows: [serves] } = handed?.status === 'rejected' && handed.reason === 'same_head'
      ? await pool.query(
        'SELECT staging_url FROM chat_sessions WHERE id = $1 AND staging_commit_sha = $2 AND staging_url IS NOT NULL',
        [sessionId, result.sha])
      : { rows: [] };
    if (serves) {
      await publishRecoveredStaging({ outcome: 'success', stagingUrl: serves.staging_url });
      summaryParts.push(`Staging preview is live: ${serves.staging_url}`);
    } else {
      await publishRecoveredStaging({ outcome: 'building' });
      summaryParts.push('The staging preview is building; its checks run once it is up.');
    }
  } finally {
    if (!keepWorker) await worker.destroyWorker(containerName);
  }
  return { outcome: 'done', summary: summaryParts.join('\n\n') };
}

// Resume a detached CC turn after a restart. The turn kept running (or
// finished) while we were down — its output is in the journal file
// recorded on chat_sessions.active_turn. Replays the journal from line
// 0 (rebuilding progress + result state), follows it live if the turn
// is still going, then runs the standard post-turn tail. The warm
// container stays registered for the session's next dispatch.
// #1378: build the stop handle for an ADOPTED turn.
//
// A turn started by POST /chat registers a handle in the shared stop
// registry, and that handle is the ONLY thing POST /stop looks at. A turn
// adopted after a restart or a blue-green cutover is resumed from here
// instead, so until now it had no handle at all: POST /stop classified it
// 'no_active_turn' and answered { ok: true, stopped: false } while
// GET /status still said busy, which painted a live red Stop button that
// did nothing (production session 3539 — 36 minutes unstoppable).
//
// Phase is 'cc' for the journal tail, which is what makes
// stopPolicy.killsWorkerInPhase true so the request drives the
// in-container kill; it moves to 'mayor2' when the wrap-up starts, where
// stopping is refused by design.
function buildRecoveryStopHandle({ sessionId, containerName, activeTurn, broadcastGlobal, relayTo = [] }) {
  // Recovery narration now fans out on BOTH channels. The global WS
  // broadcast reaches tabs listening for session_event; the per-session bus
  // is what a client reconnecting over GET /events replays from. The live
  // turn's send() has always done both — recovery only did the first, so a
  // reconnected client watching an adopted turn saw nothing, which would
  // include the 'stopped' this change makes it able to receive.
  const seqPrefix = `rec-${sessionId}-${process.pid}`;
  let seq = 0;
  const send = (event, data) => {
    const payload = { type: event, _seq: `${seqPrefix}-${++seq}`, ...(data || {}) };
    // Spread first, pin the envelope last — otherwise the inner `type`
    // clobbers `type: 'session_event'` and the client never routes it.
    try {
      broadcastGlobal({ ...payload, sessionId, event, type: 'session_event' });
    } catch {}
    try { sessionBus.publish(sessionId, payload); } catch {}
    // The conversations whose Mayor dispatched this run follow it on their
    // own bus, as they follow a live dispatch. Its end is theirs to announce
    // (handBackAfterRecovery), not the change's.
    if (event === 'done' || event === 'stopped') return;
    for (const agentSessionId of relayTo) {
      try {
        sessionBus.publish(require('./mayor/agent-turn').busKey(agentSessionId), {
          ...payload, changeId: sessionId, agentSessionId,
        });
      } catch {}
    }
  };
  const handle = stopRegistry.createHandle({
    sessionId,
    phase: 'cc',
    workerName: containerName || null,
    send,
  });
  // A stop clicked in the seconds before the restart is durable on the turn
  // record. Seed the handle from it so recovery honours the intent it never
  // got to act on, instead of re-adopting the turn and narrating an
  // interruption the user already asked for.
  const durable = turnLifecycle.stopRequestOf(activeTurn);
  if (durable) {
    handle.stopped = true;
    handle.stoppedBy = durable.by;
    handle.stopRequestedAt = durable.atMs;
  }
  return handle;
}

async function resumeDetachedTurn(args) {
  const { pool, sessionId, containerName, activeTurn, broadcastGlobal } = args;
  const relayTo = [];
  require('./agent-sessions').conversationsOfChange(pool, sessionId)
    .then((conversations) => {
      for (const c of conversations) {
        relayTo.push(c.agentSessionId);
        // Their lists read the dead Mayor's lease as idle; this run is theirs.
        require('./ws').pushToUser(c.userId, {
          type: 'agent_session_changed', agentSessionId: c.agentSessionId, busy: true,
        });
      }
    })
    .catch(() => {});
  const stopHandle = buildRecoveryStopHandle({
    sessionId, containerName, activeTurn, broadcastGlobal, relayTo,
  });
  stopRegistry.set(sessionId, stopHandle);
  // Register the whole recovery (journal tail + finalize's PR/staging
  // work) in the shared activeWorkers set so the auto-pause/staging-GC
  // sweepers see the session as busy — the sessions 2391/2386 incident
  // was the sweeper pausing sessions and destroying their workers in
  // the window between the journal tail ending and finalize completing.
  await activeWorkersSvc.activeWorkers.enter(sessionId);
  // Whether the recovery got to the end of the turn's work: only then has
  // the conversation that dispatched it something new to read.
  let recoveredToEnd = false;
  try {
    const out = await resumeDetachedTurnInner({ ...args, stopHandle });
    recoveredToEnd = true;
    return out;
  } catch (err) {
    let retainedTurn;
    try {
      retainedTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    } catch (loadErr) {
      // A DB outage cannot prove that recovery ownership disappeared.
      // Retry the durable read rather than demoting the original failure to
      // an ordinary, reapable orphan.
      loadErr.retainActiveTurn = true;
      throw loadErr;
    }
    if (retainedTurn) {
      await recoveryRetry.retainOrQuarantineRecoveryError({
        pool,
        sessionId,
        activeTurn: retainedTurn,
        error: err,
      });
    }
    throw err;
  } finally {
    // Identity-guarded: a newer turn may already own the session by the time
    // this recovery unwinds, and clearing unconditionally would strand it.
    stopRegistry.deleteIf(sessionId, stopHandle);
    activeWorkersSvc.activeWorkers.delete(sessionId);
    // The conversation whose Mayor dispatched this run is still leased to
    // that Mayor's dead turn, and its screen follows the run. Whether the run
    // finished, stopped or failed, it is over.
    require('./mayor/agent-turn')
      .handBackAfterRecovery({ pool, changeId: sessionId, finished: recoveredToEnd })
      .catch((err) => log.warn('server', 'Recovered turn: conversation hand-back failed (non-fatal)', {
        sessionId, err: err.message,
      }));
    // Turn completion counts as activity: give the freshly recovered
    // session a full idle window instead of leaving last_activity_at at
    // the pre-restart user message (which made it instantly pause-
    // eligible the moment the busy guard dropped).
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
      [sessionId]
    ).catch(() => {});
  }
}

async function resumeDetachedTurnInner({
  config, pool, staging, broadcastGlobal, session, sessionId,
  containerName, activeTurn, stopHandle = null,
}) {
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  // #1378: the adopted turn's stop handle owns the fan-out (see
  // buildRecoveryStopHandle). Callers that drive this directly get an
  // unregistered handle so the narration still works.
  const handle = stopHandle || buildRecoveryStopHandle({
    sessionId, containerName, activeTurn, broadcastGlobal,
  });
  const emit = handle.send;

  // The milestone map of an interrupted TAIL (empty for a mid-exec
  // recovery). Read once here and threaded into finalizeRecoveredTurn so
  // the tail's non-idempotent steps aren't repeated.
  let tailDone = (activeTurn && typeof activeTurn.tail === 'object' && activeTurn.tail) || {};
  let recoveryActiveTurn = activeTurn;
  const recoveryAgent = recoveredAgentIdentity(session, activeTurn);
  log.info('server', 'Resuming detached turn from journal', {
    sessionId, containerName, mode: activeTurn.mode, journal: activeTurn.journal,
    // 'tail' distinguishes "the agent was done, the platform side wasn't"
    // from a genuine mid-exec resume — the two look identical in the logs
    // otherwise, and only one of them means a turn lost minutes of work.
    phase: activeTurn.phase || 'exec',
    tailDone: Object.keys(tailDone),
  });
  // #896: the same in-flight label a live turn shows — see the note in
  // adoptOrphanWorker. Emit-only (never persisted), as before.
  emit('status', {
    text: `${recoveryAgent.name} is running...`,
    ...recoveryAgent.metadata,
  });

  // The journal replay re-feeds every line from the start of the turn,
  // including ones the previous process already appended to the latest
  // "Claude Code progress" row. Rebuild that row's progressLog
  // WHOLESALE from the replayed lines (idempotent) instead of appending
  // duplicates; live tabs still get each line over the WebSocket.
  const progressLines = [];
  let flushQueued = false;
  const flushProgress = () => {
    flushQueued = false;
    pool.query(
      `UPDATE chat_session_messages
       SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
       WHERE id = (
         SELECT id FROM chat_session_messages
         WHERE session_id = $2 AND role = 'system'
           AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1
       )`,
      [JSON.stringify(progressLines), sessionId]
    ).catch(() => {});
  };

  const onRecoveredProgress = (text) => {
    emit('cc_progress', { text, ...recoveryAgent.metadata });
    progressLines.push(text);
    if (!flushQueued) {
      flushQueued = true;
      setTimeout(flushProgress, 1000);
    }
  };
  // #1378: terminalize an adopted turn that the user stopped.
  //
  // Before this, a stop that landed on a recovered turn was invisible to
  // the recovery path: the tail finished, the code below narrated
  // "[interrupted]" with unrecoverable retry pills, and an api-error tail
  // could even be RETRIED — dispatching more work for a turn the user had
  // explicitly ended. A stop is a deliberate end, so it gets the same
  // closing row and pills the live stop path writes, and the Codex ledger
  // attempt is terminalized 'cancelled' rather than 'failed'.
  const finishAsStopped = async (turnRecord, execResult = null) => {
    const record = turnRecord || recoveryActiveTurn || activeTurn;
    const by = handle.stoppedBy
      || turnLifecycle.stopRequestOf(record)?.by
      || null;
    // #1378: stopping a RECOVERED turn discards more than stopping a live
    // one — the agent may well have committed and pushed before the restart
    // that detached it. Saying only "Stopped." would leave the user's branch
    // silently moved, and re-sending the same request would buy a duplicate
    // run. The durable tail milestones know what landed (markTurnTail writes
    // sha/pushOk at the exec→tail boundary), so reuse the live path's exact
    // wording. They carry no commit COUNT, hence `ahead: null`.
    //
    // Two sources, in order of authority. A stop caught AFTER the journal
    // tail resolved has the exec result itself, which carries the commit
    // COUNT as well as the sha. A stop that surfaced as a throw does not,
    // and falls back to the durable milestones — enough to say a commit
    // landed, not enough to count them, hence `ahead: null`.
    const { describeStoppedLanding, stopLandingMeta } = require('../routes/sessions');
    const stoppedTail = (record && typeof record.tail === 'object' && record.tail) || {};
    const landing = execResult
      ? { sha: execResult.sha || null, ahead: execResult.ahead ?? 0, pushOk: execResult.pushOk === true }
      : { sha: stoppedTail.sha || null, ahead: null, pushOk: stoppedTail.pushOk === true };
    const landed = describeStoppedLanding(landing);
    const text = `Stopped${by ? ` by @${by}` : ''}${landed}.`;
    // Same facts as data, for the transcript's stopped card. The tail-milestone
    // branch's `ahead: null` reaches the row as a countless "changes committed"
    // chip rather than as a fabricated 1.
    const stopLanding = stopLandingMeta({
      headline: `Stopped${by ? ` by @${by}` : ''}`,
      ...landing,
    });
    const pills = recoveryPills.turnFallbackQuickReplies({ outcome: 'stopped' });
    log.info('server', 'Recovered turn was stopped by the user', {
      sessionId, by, turnId: turnLifecycle.turnIdentity(record),
    });
    if (record?.backend === 'codex_openrouter' && record?.turnUuid) {
      const agentTurn = require('./agent-turn');
      try {
        await agentTurn.completeCodexAttempt({
          pool,
          turnUuid: record.turnUuid,
          status: 'cancelled',
          errorCode: 'user_cancelled',
        });
      } catch (err) {
        log.warn('server', 'Recovered stop: Codex attempt terminalization failed', {
          sessionId, err: err.message,
        });
      }
    }
    // The progress card must not stay frozen on the last journal line.
    if (progressLines.length) {
      if (turnWatchdog.appendTerminalLine(progressLines, '[interrupted]')) {
        emit('cc_progress', { text: '[interrupted]' });
      }
      flushProgress();
    } else {
      await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
      emit('cc_progress', { text: '[interrupted]' });
    }
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, text, JSON.stringify({
        quickReplies: pills, recovered: true, stopped: true, stopLanding,
      })]
    ).catch(() => {});
    emit('status', { text, quickReplies: pills, stopLanding });
    emit('stopped', { by });
    const stoppedCleanupArgs = turnCleanupArgs(record);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, stoppedCleanupArgs),
      stoppedCleanupArgs,
    );
    emit('done', {});
  };

  // The Homeroom bot's turns never reach this: a turn workflow work runs
  // (its builds, reads and fixes, the bench's trials) is its work item's to
  // follow (services/durable-turn.js), and adoptOrphanWorker leaves it
  // alone; an older release's bot turn is abandoned there
  // (isRecoveredBotSession), its request read again.

  let result;
  try {
    result = await worker.resumeTurnFromJournal(sessionId, {
      journal: activeTurn.journal,
      turnId: activeTurn.turnId || null,
      agentBackend: activeTurn.backend || 'claude_code',
      // The journal's own harness picks its parser (#3296). Without it the
      // registry falls back to Codex, and a recovered Claude Code turn (every
      // GLM turn since #3749) came back with no result text, progress or
      // usage: a recovered spec lost its spec, a triage its verdict.
      agentHarness: activeTurn.harness || null,
      telemetryComponent: activeTurn.telemetryComponent
        || (activeTurn.mode === 'scout' ? 'coding_agent_scout'
          : activeTurn.mode === 'build' ? 'coding_agent_build' : null),
      telemetryCorrelationId: activeTurn.telemetryCorrelationId || activeTurn.turnId || null,
      telemetryAttemptNumber: activeTurn.telemetryAttemptNumber || activeTurn.attemptNumber || 1,
      telemetryRequestMode: activeTurn.telemetryRequestMode || null,
      telemetryRequestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
      telemetryRequestSystemCharacters: activeTurn.telemetryRequestSystemCharacters ?? null,
      telemetryRequestPayloadCharacters: activeTurn.telemetryRequestPayloadCharacters ?? null,
      telemetryModelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
      telemetryModelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
      requestedModel: activeTurn.model || null,
      startedAt: activeTurn.startedAt || null,
      attemptNumber: activeTurn.attemptNumber || 1,
      billingByok: activeTurn.byok === true,
      providerWasDispatched: turnLifecycle.phaseOf(activeTurn) !== turnLifecycle.PHASE_DISPATCH_PENDING,
      // #664: seed the per-turn BYOK tally from the persisted record so
      // post-restart switched calls accumulate on top of pre-restart ones.
      byokCentsSoFar: Number(activeTurn.byokCents || 0),
      onProgress: onRecoveredProgress,
      // The registry state execInWorker kept for this turn (worker.js).
      mode: activeTurn.mode || null,
      branchName: session.branch_name || null,
      stopRequestedAt: turnLifecycle.stopRequestOf(activeTurn)?.atMs || null,
    });
  } catch (err) {
    // #1378: the stop machinery kills the agent process and appends an exit
    // marker, so a stopped turn usually resolves rather than throwing — but
    // when it does throw, the user still asked for this to end. Close it as
    // a stop instead of reporting a failure they caused on purpose. (A
    // benchmark turn writes no stop card: its trial is put back below.)
    if (handle.stopped) {
      await finishAsStopped(activeTurn);
      return;
    }
    log.warn('server', 'Detached-turn resume failed', { sessionId, err: err.message });
    // Fail the Codex ledger row on a resume failure too (review P1c): the
    // success path terminalizes, but a thrown resume also must not leave
    // the row 'running' / the token usable until expiry.
    if (activeTurn?.backend === 'codex_openrouter' && activeTurn?.turnUuid) {
      const agentTurn = require('./agent-turn');
      try {
        await agentTurn.completeCodexAttempt({
          pool,
          turnUuid: activeTurn.turnUuid,
          status: 'failed',
          errorCode: agentTurn.classifyErrorCode(err),
          errorDetail: agentTurn.sanitizeError(err),
          telemetryComponent: turnLifecycle.phaseOf(activeTurn) === turnLifecycle.PHASE_DISPATCH_PENDING
            ? null
            : activeTurn.telemetryComponent || null,
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
      } catch (ledgerErr) {
        const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
          pool,
          sessionId,
          activeTurn,
          error: ledgerErr,
        });
        log.error('server', disposition.action === 'retry'
          ? 'Recovered Codex terminalization failed; retaining durable state'
          : 'Recovered Codex attempt is missing; durable turn quarantined', {
          sessionId, err: ledgerErr.message,
        });
        throw ledgerErr;
      }
    }
    // Terminal marker: the card must not stay frozen on the last line
    // the journal managed to deliver before the resume died. When the
    // replay produced no lines at all, append to the persisted row
    // instead — a wholesale flush of just ['[interrupted]'] would wipe
    // the log the pre-restart process already persisted.
    emit('cc_progress', { text: '[interrupted]' });
    if (progressLines.length) {
      turnWatchdog.appendTerminalLine(progressLines, '[interrupted]');
      flushProgress();
    } else {
      await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    }
    // #786: the failed-resume breadcrumb carries retry pills — the
    // phase-2 wrap-up that would normally supply them is gone with the
    // dead SSE, so this is the turn's only chance to refill the bar.
    const failedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        JSON.stringify({
          ...(failedPills ? { quickReplies: failedPills } : {}),
          recovered: true,
          recoveredReason: 'resume_failed',
        })]
    ).catch(() => {});
    emit('status', {
      text: recoveryPills.TURN_UNFINISHED_BREADCRUMB,
      quickReplies: failedPills || undefined,
    });
    await notifyTurnStalled(pool, sessionId);
    // Cleanup is deliberately last: if its durable clear needs a retry, the
    // retry scheduler can repeat only cleanup without duplicating narration.
    const cleanupArgs = turnCleanupArgs(activeTurn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, cleanupArgs),
      cleanupArgs,
    );
    return;
  }
  flushProgress();

  // #1378: the tail is done and the user had asked for this turn to stop.
  // Everything below — the Codex fresh-retry, the api-error retry inside
  // finalize, the Mayor wrap-up — is work for a turn that is meant to keep
  // going, so none of it may run. Close the turn as a stop and return.
  // (A benchmark turn writes no stop card either: the lane records the
  // trial as stopped on its clock, below.)
  if (handle.stopped) {
    await finishAsStopped(recoveryActiveTurn, result);
    return;
  }

  // Mirror execInWorker's finally: the exec is over, hand the durable
  // record to the tail. A journal that detached MID-EXEC leaves active_turn
  // in 'executing', and every milestone write below requires 'tail_pending'
  // (mergeTailMilestones) — without this stamp the tail's first
  // noteTailMilestone throws invalid_turn_transition, the tail aborts with
  // the turn retained, and the retained-recovery timer replays the whole
  // tail every minute forever (session 3180: 13+ identical resume attempts,
  // each re-running the finalize narration). A record still in
  // 'dispatch_pending' needs it too, for the same reason: its replay is over
  // as well, whether or not the agent ever started (change 7490, 9 Oct 2026:
  // a follow-up a pending stop skipped left its record there, and recovery
  // retried "milestone attempted from dispatch_pending" through five
  // restarts while the proposal read as running). Only those two phases are
  // stamped — an interrupted TAIL is already 'tail_pending' and re-stamping
  // would clobber its milestone map with the seed. A failed stamp propagates
  // to the caller's retain/quarantine triage like any other recovery error.
  const replayedPhase = turnLifecycle.phaseOf(recoveryActiveTurn);
  if (replayedPhase === turnLifecycle.PHASE_EXECUTING
    || replayedPhase === turnLifecycle.PHASE_DISPATCH_PENDING) {
    await worker.markTurnTail(sessionId, {
      sha: result.sha || null,
      pushOk: result.pushOk === true,
    }, turnLifecycle.cleanupArgs(recoveryActiveTurn));
  }

  // A recovered missing-thread marker still owns its one fresh attempt.
  // Re-dispatch it before consuming the journal, then make thread + ledger
  // persistence required. Any failure here deliberately escapes BEFORE the
  // tail's clearing finally, leaving active_turn and the journal replayable.
  try {
    const agentTurn = require('./agent-turn');
    const sessionsRoutes = require('../routes/sessions');
    const retried = await sessionsRoutes.resumeRecoveredCodexFreshRetry({
      pool, config, session, activeTurn, result,
      onProgress: onRecoveredProgress,
    });
    if (retried) {
      result = retried.result;
      recoveryActiveTurn = retried.activeTurn;
      tailDone = (recoveryActiveTurn.tail
        && typeof recoveryActiveTurn.tail === 'object'
        && recoveryActiveTurn.tail) || {};
    }

    await agentTurn.persistRecoveredAgentThread({ pool, session, result });
    await agentTurn.settleRecoveredAgentAttempt({
      pool,
      activeTurn: recoveryActiveTurn,
      result,
      settleClaude: async () => {
        if (!result.costUsd) return null;
        let byok = recoveryActiveTurn.byok;
        if (byok === undefined || byok === null) {
          try {
            const { rows } = await pool.query(
              'SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND anthropic_key_enc IS NOT NULL) AS byok',
              [session.user_id]
            );
            byok = !!rows[0]?.byok;
          } catch {
            byok = false;
          }
        }
        const limits = require('./limits');
        return limits.settleTurnSpend(pool, session.user_id, Math.round(result.costUsd * 100), {
          turnByok: !!byok,
          byokObservedCents: worker.getTurnByokCents(sessionId),
          turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
          sessionId,
        });
      },
    });
  } catch (err) {
    const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
      pool,
      sessionId,
      activeTurn: recoveryActiveTurn,
      error: err,
    });
    log.error('server', disposition.action === 'retry'
      ? 'Required recovered-turn persistence failed; retaining durable state'
      : 'Recovered turn has invalid durable state; leaving it quarantined without retry', {
      sessionId, err: err.message,
    });
    throw err;
  }

  // Terminal marker for the progress card: pessimistic default so a
  // throw anywhere below still stamps [interrupted]; the happy paths
  // overwrite it with [done] / [push_failed] before the finally runs.
  let terminalLine = '[interrupted]';
  // #786: which pill set the generic breadcrumb below should carry. The
  // scout branches attach their own pills to their own (more specific)
  // row and leave this null — a pill-less system row is transparent to
  // the client's pill resolution, so the earlier row still wins.
  // #896: which recovery-pill set the Mayor wrap-up falls back to when
  // the model declines to call suggest_replies, and what to tell it the
  // dispatch produced. Null wrapUpOutcome means "no wrap-up" — a sync
  // turn, which has no Mayor reply on the live path either.
  let wrapUpOutcome = null;
  let wrapUpPillKind = null;
  let wrapUpSummary = null;
  // #3181: the recovered turn ended on the failures a live turn marks
  // turnError (a scout that wrote no spec, a push that never landed), so
  // its notification says it stopped before finishing.
  let recoveredStalled = false;
  let durableTailComplete = false;
  try {
    if (recoveryActiveTurn.mode === 'scout') {
      // Scout turns push nothing — their product is the spec text.
      // Persist it the same way runScoutTool does (spec_md + frozen
      // version) so the draft isn't lost with the dead SSE.
      const {
        captureSpecOutput, persistScoutPublication,
      } = require('../routes/sessions');
      // #3699: an HTML spec is kept as its markdown copy (ccText) plus the document.
      const capturedSpec = captureSpecOutput(result.lastResultText);
      const ccText = capturedSpec.text;
      if (ccText) {
        const hadSpec = !!(session.spec_md || '').trim();
        // #786: "spec drafted" pills ride the spec row itself rather than
        // the wrap-up — it's the row that describes the state the session
        // actually landed in. They stay as a safety net for the case where
        // the wrap-up below can't run at all.
        const specPills = recoveryPills.buildRecoveryQuickReplies('spec_done');
        const publication = await persistScoutPublication({
          pool,
          sessionId,
          turnId: recoveryActiveTurn.turnId || null,
          content: ccText,
          contentHtml: capturedSpec.html,
          hadSpec,
          quickReplies: specPills,
          recovered: true,
        });
        session.spec_md = ccText;
        if (publication.applied) {
          emit('status', { text: publication.scoutText, ...publication.metadata });
          emit('spec_updated', {
            length: ccText.length,
            lines: publication.lineCount,
            version: publication.specVersion,
          });
        }
        wrapUpOutcome = 'spec';
        wrapUpPillKind = 'spec_done';
        wrapUpSummary = publication.hadSpec
          ? `The scout revised the session's spec doc (now ${publication.lineCount} lines). `
            + 'The user can review it in the dev-chat spec viewer. When they are ready to ship, '
            + 'they will ask you to dispatch the coding agent.'
          : `The scout investigated the repo and drafted a ${publication.lineCount}-line markdown spec. `
            + "It now lives in the session's spec doc; the user can review it in the dev-chat "
            + 'spec viewer. When they are ready to ship, they will ask you to dispatch the coding agent.';
      } else {
        // #786: previously emit-only, so a recovered-but-empty scout turn
        // left no trace at all after a reload. Persist it (with retry
        // pills) so the state is visible and actionable.
        recoveredStalled = true;
        const noSpecPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [
            sessionId,
            recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
            JSON.stringify({
              ...(noSpecPills ? { quickReplies: noSpecPills } : {}),
              recovered: true,
            }),
          ]
        ).catch(() => {});
        emit('status', {
          text: recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
          quickReplies: noSpecPills || undefined,
        });
      }
      // Persist the CC session id for the next --resume.
      const newCcId = result.sessionId || result.initSessionId || null;
      if (newCcId && newCcId !== session.cc_session_id) {
        await pool.query(
          'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
          [newCcId, sessionId]
        ).catch(() => {});
      }
      terminalLine = '[done]';
    } else if (recoveryActiveTurn.mode === 'sync') {
      // A sync turn an older release dispatched (the proposal machine's own
      // syncs are followed by their work item, and never reach here: see
      // the guard above). System work with no wrap-up: its row is told it is
      // no longer integrating, and the app's merge queue looks again.
      log.info('server', 'Recovered an older release\'s sync turn; asking the merge queue to look again', { sessionId });
      terminalLine = '[done]';
      await require('./integration').setBlockReasons(pool, sessionId, []);
      if (session.status === 'promoted' && session.app_id != null) {
        await require('../workflow/platform.ts').wantMerge({ appId: session.app_id, sessionId, reason: 'recovered-sync' })
          .catch((err) => log.warn('server', 'post-recovery merge ask failed', { sessionId, err: err.message }));
      }
    } else {
      const { outcome: finalizeOutcome, summary } = await finalizeRecoveredTurn({
        config, pool, staging, session, sessionId, result, repoOwner, repoName,
        emit, containerName,
        // Warm contract: the container outlives the turn.
        keepWorker: true,
        startedAtMs: recoveryActiveTurn.startedAt
          ? Date.parse(recoveryActiveTurn.startedAt) || null
          : null,
        alreadyDone: tailDone,
        activeTurn: recoveryActiveTurn,
      });
      terminalLine = finalizeOutcome === 'push_failed' ? '[push_failed]' : '[done]';
      const recoveredNoChanges = !(result.ahead > 0 && result.sha);
      wrapUpPillKind = finalizeOutcome === 'push_failed' ? 'push_failed' : 'code_done';
      if (recoveryAgent.isOpenRouter && finalizeOutcome !== 'push_failed' && recoveredNoChanges) {
        wrapUpPillKind = 'chat_generic';
      }
      wrapUpOutcome = finalizeOutcome === 'push_failed'
        ? 'push_failed'
        : (recoveredNoChanges ? 'no_changes' : 'code');
      wrapUpSummary = summary;
      recoveredStalled = finalizeOutcome === 'push_failed';
    }


    // #896: re-issue the Mayor's phase-2 wrap-up. It used to be skipped
    // outright — the turn ended on a bare recovery breadcrumb and no
    // Mayor reply at all, which is exactly what the issue reported.
    // Provider failure degrades to a short static close carrying these pills.
    // Durable receipt/message/spend failures still throw so this tail remains
    // owned and is retried from its committed effects.
    // ...unless the interrupted tail already got its wrap-up onto the
    // transcript (a restart in the seconds between the wrap-up persisting
    // and the record being released). Re-issuing it would post a second
    // assistant reply describing the same build.
    if (wrapUpOutcome && tailDone.wrapUpPosted) {
      log.info('server', 'Recovered turn: wrap-up already posted — skipping re-issue', { sessionId });
      wrapUpOutcome = null;
    }
    if (wrapUpOutcome) {
      const { runRecoveredWrapUp } = require('../routes/sessions');
      // #1378: phase-2 is stop-proof by design — the commit, PR and staging
      // already exist, and killing the summary would leave the user without
      // any context for changes that are real. Moving the handle to
      // 'mayor2' is what makes POST /stop answer 'wrap_up_not_stoppable'
      // for an adopted turn, exactly as it does for a live one.
      handle.phase = 'mayor2';
      emit('phase', { phase: 'mayor2' });
      await runRecoveredWrapUp({
        pool, config, session, sessionId,
        outcome: wrapUpOutcome,
        dispatchSummary: wrapUpSummary,
        fallbackPillKind: wrapUpPillKind,
        turnModel: recoveryActiveTurn.model || null,
        turnId: recoveryActiveTurn.turnId || null,
        emit,
        signal: handle.abort?.signal || null,
      });
      await worker.noteTailMilestone(
        sessionId,
        { wrapUpPosted: true },
        turnLifecycle.cleanupArgs(recoveryActiveTurn),
      );
      tailDone = { ...tailDone, wrapUpPosted: true };
    }

    // #161: the pre-restart SSE is guaranteed dead, so the owner cannot
    // have been watching this turn finish — treat recovered turns as
    // armed regardless of the persisted notify_on_done flag: clear it
    // and always create the session_done notification (the WS push
    // reaches them if they have a tab open elsewhere in the app).
    // #3181: session_stalled instead when the recovered turn failed.
    try {
      const notifications = require('./notifications');
      await pool.query(
        `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
        [sessionId]
      ).catch(() => {});
      const create = recoveredStalled
        ? notifications.createSessionStalledNotification
        : notifications.createSessionDoneNotification;
      const created = await create(pool, {
        userId: session.user_id, appId: session.app_id, sessionId,
      });
      if (created.length) await notifications.hydrateAndPush(pool, created[0]);
    } catch (err) {
      log.warn('server', 'recovered-turn session_done notify failed', {
        sessionId, err: err.message,
      });
    }
    durableTailComplete = true;
  } finally {
    // Stamp the terminal marker on the rebuilt log (dedup: journals from
    // new worker images already end with their own [done]/[push_failed])
    // so the collapsed card label can't stay frozen on "Pushing".
    if (turnWatchdog.appendTerminalLine(progressLines, terminalLine)) {
      emit('cc_progress', { text: terminalLine });
    }
    flushProgress();
    if (durableTailComplete) {
      const cleanupArgs = turnCleanupArgs(recoveryActiveTurn);
      recoveryRetry.requireDurableTurnCleanup(
        await worker.finishTurn(sessionId, cleanupArgs),
        cleanupArgs,
      );
    } else {
      log.warn('server', 'Recovered tail failed; retaining durable turn for replay', {
        sessionId,
        turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
      });
    }
  }
}


/**
 * Carry on the coding turn on session `sessionId` whose record names the
 * caller's work item as its owner (a turn's work item, resumed after its
 * process went: services/turns.js): followed through its journal to its
 * end, its tail and wrap-up finished; or, its worker gone, abandoned with
 * what it left. What the leader's adoption did for an orphaned turn.
 */
async function recoverOwnedTurn({ config = sharedConfig(), pool, sessionId }) {
  const containerName = worker.workerContainerName(sessionId);
  let state = 'not_found';
  try {
    state = await worker.getWorkerStatus(containerName);
  } catch (err) {
    // An unreadable runtime is not a gone worker: tried again by the item.
    throw Object.assign(new Error(`could not read the worker's state: ${err.message}`), { retryWorkerRecovery: true });
  }
  await adoptOrphanWorker({ name: containerName, sessionId: Number(sessionId), state }, {
    config, pool, staging: stagingSvc, ghub: github, broadcastGlobal: ws.broadcastGlobal,
  }, { owned: true });
}

/**
 * A coding turn record the work item `workId` still holds as it ends (a
 * record its recovery could not take to an end: written, then cut before its
 * agent started): released, with the unfinished-turn note and its retry
 * pills, so the change is not left busy for good. Resolves the session id,
 * or null when the item holds none.
 */
async function releaseLeftRecord({ pool, workId }) {
  const { rows: [r] } = await pool.query(
    `SELECT id, active_turn FROM chat_sessions WHERE active_turn->'owner'->>'workId' = $1 ORDER BY id DESC LIMIT 1`,
    [String(workId)]);
  if (!r) return null;
  const sessionId = Number(r.id);
  log.warn('server', 'A turn ended holding its coding record; releasing it', { sessionId, workId });
  await worker.clearActiveTurn(sessionId, turnCleanupArgs(r.active_turn));
  await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
  const pills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', $2, $3)`,
    [sessionId, recoveryPills.TURN_UNFINISHED_BREADCRUMB,
      JSON.stringify({ ...(pills ? { quickReplies: pills } : {}), recovered: true, recoveredReason: 'turn_ended_holding' })],
  ).catch(() => {});
  await notifyTurnStalled(pool, sessionId).catch(() => {});
  return sessionId;
}

module.exports = {
  recoverOwnedTurn,
  releaseLeftRecord,
  persistedActiveTurnExists,
  turnCleanupArgs,
  reconcilePendingTurnCleanup,
  scheduleRetainedOrphanRecovery,
  scheduleInteractiveTurnRecovery,
  recoveredAgentIdentity,
  abandonCodexAttempt,
  abandonOrphanShotsTurn,
  abandonOrphanBenchTurn,
  homeroomBotRecovery,
  adoptBotOrphan,
  adoptOrphanWorker,
  findDanglingTail,
  narrateDanglingTail,
  appendTerminalProgressLine,
  notifyTurnStalled,
  finalizeRecoveredTurn,
  buildRecoveryStopHandle,
  resumeDetachedTurn,
  resumeDetachedTurnInner,
  TAIL_IN_PROGRESS_PATTERNS,
};

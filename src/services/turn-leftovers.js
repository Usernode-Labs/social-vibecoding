'use strict';

// Turns nothing carries any more, taken to an end now that no leader
// recovers them: what a release from before the turn machine leaves behind
// (ROLLOUT-ONLY: the claims, headless runs and local turns below, and the
// process_holds reads), and a coding record whose work item settled without
// releasing it (its release failed: services/turns.js releaseLeftRecord),
// which is the leader's orphan sweep and watchdog's case and stays. Once no
// release from before the turn machine can run, delete the rollout parts:
// the claims, headless and local passes, the `resume` flag in turns.js,
// heldByLiveProcess, olderProcessHolding, receiveOlderStop (and ws.js's
// `session_stop`) and the hold writes in processes.js.
//
// Every turn this release starts belongs to the turn machine
// (src/workflow/turn/): its work item owns its conversation's claim, its
// coding run's record and its local agent's turn, and carries them on. An
// older release's turns have none of that: their process renewed a claim,
// held its sessions (process_holds), and left the rest to its leader's
// recovery at the next boot. A pass, every minute, leaves alone everything
// a live process of that release still holds (it finishes its own turns
// while it drains), and then:
//
//   claims     a conversation's claim no turn instance knows, stale by the
//              old rule (not renewed for 90 seconds) and with nothing still
//              running on its change: released, quietly when the
//              conversation was answered after the turn started (its reply,
//              or its build's recovered wrap-up), else ended as interrupted,
//              with Retry;
//   records    a coding run's record no work item holds (none owns it, or
//              its owner settled), quiet for two minutes: a `recover` turn
//              asked on its change, which runs the adoption the leader ran
//              (turn-recovery.js adoptOrphanWorker), once;
//   headless   a run still 'generating' that no turn carries: a `headless`
//              turn asked to resume it, once;
//   local      a local agent's turn whose waiter went quiet and that no item
//              dispatched: finished by the local recovery pass, as the
//              leader's timer did (its waiter's heartbeat makes it
//              restartable: services/local-agent-recovery.js);
//   unanswered once per release, on the first pass after no process of an
//              older release is live (when the leader's boot ran it): a dev
//              chat turn of that release cut before its reply, or before its
//              reply's pills, repaired as its item would repair one of this
//              release's (#786: turn-recovery.js repairUnansweredTurn).

const log = require('./logger');
const { workflowTurnHeldSql, buildHoldSql } = require('../workflow/session-work.ts');

// The old claim's stale window (agent-sessions.js before the turn machine).
const STALE_SECONDS = 90;
// A process is live while its heartbeat is this fresh (services/processes.js).
const LIVE_SECONDS = 45;
// Per pass and per kind.
const LIMIT = 50;

// ROLLOUT-ONLY: an older release's process records what it runs in
// process_holds, and this release writes its own there for that release to
// read (services/processes.js writeHolds): either is a live process still
// working on the session, so nothing of it is left behind.
const heldByLiveProcess = (ref) => `EXISTS (
  SELECT 1 FROM process_holds h JOIN platform_processes p ON p.id = h.process_id
   WHERE h.kind IN ('session', 'sync') AND h.ref = (${ref})::text
     AND p.heartbeat_at > NOW() - make_interval(secs => ${LIVE_SECONDS}))`;

const CLAIMS_SQL = `
  SELECT a.id, a.user_id, a.active_turn->>'id' AS turn_id,
         EXISTS (SELECT 1 FROM chat_session_messages m
                  WHERE m.agent_session_id = a.id AND m.role = 'assistant'
                    AND m.created_at >= (a.active_turn->>'startedAt')::timestamptz) AS answered
    FROM agent_sessions a
   WHERE a.active_turn IS NOT NULL
     AND COALESCE((a.active_turn->>'renewedAt')::timestamptz, (a.active_turn->>'startedAt')::timestamptz)
           < NOW() - make_interval(secs => ${STALE_SECONDS})
     AND NOT EXISTS (SELECT 1 FROM wf_instances t
                      WHERE t.machine = 'turn' AND t.key = 'agent:' || a.id
                        AND (t.data->'running'->>'turnId' = a.active_turn->>'id'
                             OR t.data->'waiting' @> jsonb_build_array(jsonb_build_object('turnId', a.active_turn->>'id'))))
     AND NOT EXISTS (SELECT 1 FROM wf_events e
                      WHERE e.machine = 'turn' AND e.key = 'agent:' || a.id AND e.status = 'pending')
     AND NOT EXISTS (SELECT 1 FROM chat_sessions cs
                      WHERE cs.id = a.active_change_id
                        AND (cs.active_turn IS NOT NULL
                             OR EXISTS (SELECT 1 FROM local_agent_turns l
                                         WHERE l.session_id = cs.id AND l.tail_finished_at IS NULL
                                           AND l.status IN ('queued', 'offered', 'accepted', 'running'))))
   ORDER BY a.id
   LIMIT ${LIMIT}`;

const IDENTITY = `COALESCE(cs.active_turn->>'turnId', cs.active_turn->>'logicalTurnId', cs.active_turn->>'turnUuid', 'record')`;
// A record that has not moved for this long (a dispatch just made by an
// older release has its hold written long before then).
const QUIET_SECONDS = 120;
const RECORDS_SQL = `
  SELECT cs.id, cs.app_id, ${IDENTITY} AS identity
    FROM chat_sessions cs
   WHERE cs.active_turn IS NOT NULL
     -- No work item holds it: none owns it, or the one that did has settled.
     AND NOT ${workflowTurnHeldSql('cs.active_turn')}
     -- What other work carries: a headless run (below), a durable build, a
     -- shots agent's turn.
     AND cs.is_headless IS NOT TRUE
     AND NOT ${buildHoldSql('cs')}
     AND NOT EXISTS (SELECT 1 FROM wf_instances w
                      WHERE w.machine = 'shots' AND w.key = 'session:' || cs.id AND w.state = 'taking_shots')
     AND COALESCE(cs.active_turn->>'lifecycleUpdatedAt', cs.active_turn->>'startedAt')::timestamptz
           < NOW() - make_interval(secs => ${QUIET_SECONDS})
     AND NOT ${heldByLiveProcess('cs.id')}
     AND NOT EXISTS (SELECT 1 FROM wf_instances t
                      WHERE t.machine = 'turn' AND t.key = 'session:' || cs.id AND t.state = 'running')
     -- Asked once: a pass that finds it again adds nothing.
     AND NOT EXISTS (SELECT 1 FROM wf_events e
                      WHERE e.machine = 'turn' AND e.key = 'session:' || cs.id AND e.type = 'Asked'
                        AND e.payload->>'kind' = 'recover' AND e.payload->'input'->>'identity' = ${IDENTITY})
   ORDER BY cs.id
   LIMIT ${LIMIT}`;

const HEADLESS_SQL = `
  SELECT cs.id, cs.app_id, cs.user_id
    FROM chat_sessions cs
   WHERE cs.is_headless = TRUE AND cs.headless_status = 'generating'
     -- A run with no person behind it (a staging fixture's) is never resumed.
     AND cs.user_id IS NOT NULL
     AND (cs.active_turn IS NULL OR NOT ${workflowTurnHeldSql('cs.active_turn')})
     AND NOT ${heldByLiveProcess('cs.id')}
     AND NOT EXISTS (SELECT 1 FROM wf_instances t WHERE t.machine = 'turn' AND t.key = 'session:' || cs.id)
     AND NOT EXISTS (SELECT 1 FROM wf_events e WHERE e.machine = 'turn' AND e.key = 'session:' || cs.id)
   ORDER BY cs.id
   LIMIT ${LIMIT}`;

// A turn id the turn machine accepts, the same for the same leftover, so a
// second pass asking for it again is a replay.
const leftoverId = (prefix, identity) => `${prefix}-${String(identity).replace(/[^A-Za-z0-9_.:-]/g, '_')}`.slice(0, 80);

async function endOldClaims(pool, d) {
  const { rows } = await pool.query(CLAIMS_SQL);
  let ended = 0;
  for (const r of rows) {
    const agentSessionId = Number(r.id);
    if (r.answered) {
      await d.agentSessions.releaseTurnLease(pool, { agentSessionId, turnId: r.turn_id, finished: true });
    } else {
      await d.agentSessions.endInterruptedTurn(pool, { agentSessionId, turnId: r.turn_id, content: d.interruptedText });
    }
    d.publishDone(agentSessionId, r.turn_id);
    ended += 1;
    log.info('turn-leftovers', 'An older release\'s conversation claim was ended', { agentSessionId, answered: r.answered });
  }
  return ended;
}

async function askForRecords(pool, d) {
  const { rows } = await pool.query(RECORDS_SQL);
  for (const r of rows) {
    await d.platform.askTurn(pool, {
      key: `session:${Number(r.id)}`, turnId: leftoverId('leftover', r.identity), kind: 'recover', appId: r.app_id,
      input: { sessionId: Number(r.id), identity: r.identity },
    });
  }
  return rows.length;
}

async function askForHeadless(pool, d) {
  const { rows } = await pool.query(HEADLESS_SQL);
  for (const r of rows) {
    await d.platform.askTurn(pool, {
      key: `session:${Number(r.id)}`, turnId: leftoverId('leftover-headless', r.id), kind: 'headless', appId: r.app_id,
      input: { sessionId: Number(r.id), userId: Number(r.user_id), resume: true },
    });
  }
  return rows.length;
}

// The changes the boot backfill looked at (#786): a dev chat of the last
// week, nothing on it now.
const UNANSWERED_LIMIT = 200;
const UNANSWERED_WINDOW_DAYS = 7;
const UNANSWERED_SQL = `
  SELECT cs.id, cs.pr_number, cs.spec_md FROM chat_sessions cs
   WHERE cs.status IN ('active', 'promoted')
     AND cs.source IS DISTINCT FROM 'imported'
     AND cs.is_headless = FALSE
     AND cs.agent_session_id IS NULL
     AND cs.active_turn IS NULL
     AND NOT EXISTS (SELECT 1 FROM wf_instances t
                      WHERE t.machine = 'turn' AND t.key = 'session:' || cs.id AND t.state = 'running')
     AND cs.last_activity_at > NOW() - make_interval(days => ${UNANSWERED_WINDOW_DAYS})
   ORDER BY cs.last_activity_at DESC
   LIMIT ${UNANSWERED_LIMIT}`;

async function backfillUnanswered(pool, d) {
  const { rows } = await pool.query(UNANSWERED_SQL);
  const counts = { attached: 0, breadcrumb: 0, skipped: 0 };
  for (const session of rows) {
    try {
      counts[await d.repairUnansweredTurn(pool, session)] += 1;
    } catch (err) {
      counts.skipped += 1;
      log.warn('turn-leftovers', 'An unanswered dev chat turn could not be repaired', { sessionId: session.id, err: err.message });
    }
  }
  log.info('turn-leftovers', 'Dev chat turns an older release cut were repaired', { scanned: rows.length, ...counts });
  return counts;
}

// Whether a process of a release other than this one is live.
async function olderReleaseLive(pool, release) {
  const { rows: [r] } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM platform_processes
                     WHERE release IS DISTINCT FROM $1 AND heartbeat_at > NOW() - make_interval(secs => ${LIVE_SECONDS})) AS live`,
    [release]);
  return !!r.live;
}

/**
 * One pass of the `turn-leftovers` clock. `previous` is the last pass's
 * result (the clock's), whose `backfilled` names the release the unanswered
 * backfill last ran for.
 */
async function sweep(pool, { config, previous = null, deps = {} } = {}) {
  const d = {
    agentSessions: deps.agentSessions || require('./agent-sessions'),
    platform: deps.platform || require('../workflow/platform.ts'),
    interruptedText: deps.interruptedText || require('../workflow/turn/machine.ts').INTERRUPTED_TEXT,
    publishDone: deps.publishDone || ((agentSessionId, turnId) => require('./session-bus').publish(
      require('./mayor/agent-turn').busKey(agentSessionId),
      { type: 'done', _seq: `${String(turnId).slice(0, 8)}-z`, agentSessionId })),
    release: deps.release !== undefined ? deps.release : (String(process.env.GIT_SHA || '').trim().slice(0, 40) || null),
    repairUnansweredTurn: deps.repairUnansweredTurn || ((...a) => require('./turn-recovery').repairUnansweredTurn(...a)),
    localPass: deps.localPass || (() => {
      const recovery = require('./turn-recovery');
      return require('./local-agent-recovery').recoverOrphanedLocalTurns({
        config, pool, deps: { finalizeRecoveredTurn: recovery.finalizeRecoveredTurn, buildRecoveryStopHandle: recovery.buildRecoveryStopHandle },
      });
    }),
  };
  const claims = await endOldClaims(pool, d);
  const records = await askForRecords(pool, d);
  const headless = await askForHeadless(pool, d);
  const { adopted: local } = await d.localPass();
  let backfilled = previous && previous.backfilled !== undefined ? previous.backfilled : undefined;
  let unanswered = null;
  if (backfilled !== d.release && !(await olderReleaseLive(pool, d.release))) {
    unanswered = await backfillUnanswered(pool, d);
    backfilled = d.release;
  }
  return { claims, records, headless, local, unanswered, backfilled: backfilled ?? null };
}

/**
 * ROLLOUT-ONLY: another live process that holds the session `sessionId` (one
 * of an older release finishes its own turns while it drains), or null. Read
 * by the adoption before it takes a turn (turn-recovery.js
 * adoptOrphanWorker), which has asked this process's memory already: this
 * process's own rows (processes.js writeHolds) are not read back. Rejects on
 * a database error: a caller that cannot tell must not act.
 */
async function olderProcessHolding(pool, sessionId) {
  const { rows: [r] } = await pool.query(
    `SELECT h.process_id FROM process_holds h JOIN platform_processes p ON p.id = h.process_id
      WHERE h.kind IN ('session', 'sync') AND h.ref = $1::text AND h.process_id <> $2
        AND p.heartbeat_at > NOW() - make_interval(secs => ${LIVE_SECONDS})
      LIMIT 1`, [Number(sessionId), require('./processes').ID]);
  return r ? r.process_id : null;
}

/**
 * ROLLOUT-ONLY: a Stop an older release forwarded over the bus (its
 * `session_stop`, sent when it saw this release's hold: processes.js
 * writeHolds). Only the process running the turn acts, as that release's
 * receiver did, and it asks the turn's machine, as this release's Stop route
 * does (platform.ts stopWorkflowTurn), which stops the turn wherever its
 * work item runs. The sender has taken its own durable path already.
 */
async function receiveOlderStop(payload, {
  running = (id) => !!require('./stop-registry').get(id),
  stopTurn = (p) => require('../workflow/platform.ts').stopWorkflowTurn(p),
} = {}) {
  const sessionId = Number(payload?.sessionId);
  const by = payload?.user?.username;
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !by || !running(sessionId)) return null;
  const out = await stopTurn({ sessionId, by: String(by), expectedTurnId: payload.expectedTurnId || null });
  log.info('turn-leftovers', 'Ran a stop an older release forwarded', { sessionId, status: out?.status ?? null });
  return out;
}

module.exports = { sweep, backfillUnanswered, olderProcessHolding, receiveOlderStop, STALE_SECONDS, CLAIMS_SQL, RECORDS_SQL, HEADLESS_SQL, UNANSWERED_SQL };

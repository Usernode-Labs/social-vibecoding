'use strict';

// ROLLOUT-ONLY. What a release from before the turn machine leaves behind,
// taken to an end now that no leader recovers it. Delete this module, its
// clock (`turn-leftovers`, src/workflow/clock/services.ts), the `recover`
// turn kind (services/turns.js) and the process_holds reads below once no
// such release can run (one release after this one serves everywhere).
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
//   records    a coding run's record with no owner: a `recover` turn asked
//              on its change, which runs the adoption the leader ran
//              (turn-recovery.js adoptOrphanWorker), once;
//   headless   a run still 'generating' that no turn carries: a `headless`
//              turn asked to resume it, once;
//   local      a local agent's turn whose waiter went quiet and that no item
//              dispatched: finished by the local recovery pass, as the
//              leader's timer did (its waiter's heartbeat makes it
//              restartable: services/local-agent-recovery.js).

const log = require('./logger');

// The old claim's stale window (agent-sessions.js before the turn machine).
const STALE_SECONDS = 90;
// A process is live while its heartbeat is this fresh (services/processes.js).
const LIVE_SECONDS = 45;
// Per pass and per kind.
const LIMIT = 50;

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
const RECORDS_SQL = `
  SELECT cs.id, cs.app_id, ${IDENTITY} AS identity
    FROM chat_sessions cs
   WHERE cs.active_turn IS NOT NULL
     AND cs.active_turn->'owner' IS NULL
     AND cs.workflow_owner IS NULL
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
     AND cs.active_turn IS NULL
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

/** One pass of the `turn-leftovers` clock. */
async function sweep(pool, { config, deps = {} } = {}) {
  const d = {
    agentSessions: deps.agentSessions || require('./agent-sessions'),
    platform: deps.platform || require('../workflow/platform.ts'),
    interruptedText: deps.interruptedText || require('../workflow/turn/machine.ts').INTERRUPTED_TEXT,
    publishDone: deps.publishDone || ((agentSessionId, turnId) => require('./session-bus').publish(
      require('./mayor/agent-turn').busKey(agentSessionId),
      { type: 'done', _seq: `${String(turnId).slice(0, 8)}-z`, agentSessionId })),
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
  return { claims, records, headless, local };
}

module.exports = { sweep, STALE_SECONDS, CLAIMS_SQL, RECORDS_SQL, HEADLESS_SQL };

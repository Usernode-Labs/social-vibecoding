'use strict';

// A coding record nothing carries any more, taken to an end now that no
// leader recovers it: one whose work item settled without releasing it (its
// release failed: services/turns.js releaseLeftRecord), the leader's orphan
// sweep and watchdog's case.
//
// Every turn belongs to the turn machine (src/workflow/turn/): its work item
// owns its conversation's claim, its coding run's record and its local
// agent's turn, and carries them on when its process goes. What is left is
// a record whose item ended without letting it go. A pass, every minute (the
// `turn-leftovers` clock), asks a `recover` turn on its change, which runs
// the adoption the leader ran (turn-recovery.js adoptOrphanWorker), again a
// while after the last ask, a bounded number of times (RECORD_RETRY).

const { workflowTurnHeldSql, buildHoldSql, turnRunLiveSql } = require('../workflow/session-work.ts');

// Per pass.
const LIMIT = 50;

const IDENTITY = `COALESCE(cs.active_turn->>'turnId', cs.active_turn->>'logicalTurnId', cs.active_turn->>'turnUuid', 'record')`;
// A record that has not moved for this long.
const QUIET_SECONDS = 120;
// A record a `recover` turn left (its adoption failed, or kept it) is asked
// for again, `minutes` after the last ask, up to `asks` times; the last ask
// ends it if it is still there (services/turns.js runRecover), as the stale
// turn watchdog reaped one.
const RECORD_RETRY = Object.freeze({ asks: 4, minutes: 10 });
const RECORDS_SQL = `
  SELECT cs.id, cs.app_id, ${IDENTITY} AS identity, ra.asks
    FROM chat_sessions cs
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS asks, MAX(e.created_at) AS last_at FROM wf_events e
       WHERE e.machine = 'turn' AND e.key = 'session:' || cs.id AND e.type = 'Asked'
         AND e.payload->>'kind' = 'recover' AND e.payload->'input'->>'identity' = ${IDENTITY}) ra
   WHERE cs.active_turn IS NOT NULL
     -- No work item holds it: none owns it, or the one that did has settled.
     AND NOT ${workflowTurnHeldSql('cs.active_turn')}
     -- What other work carries: a headless run (its turn's item carries it
     -- on from the change's row), a durable build, a shots agent's turn.
     AND cs.is_headless IS NOT TRUE
     AND NOT ${buildHoldSql('cs')}
     AND NOT EXISTS (SELECT 1 FROM wf_instances w
                      WHERE w.machine = 'shots' AND w.key = 'session:' || cs.id AND w.state = 'taking_shots')
     AND COALESCE(cs.active_turn->>'lifecycleUpdatedAt', cs.active_turn->>'startedAt')::timestamptz
           < NOW() - make_interval(secs => ${QUIET_SECONDS})
     AND NOT EXISTS (SELECT 1 FROM wf_instances t
                      WHERE t.machine = 'turn' AND t.key = 'session:' || cs.id AND t.state = 'running'
                        AND ${turnRunLiveSql('t')})
     -- A turn being stopped (its time ran out, or a Stop that releases it):
     -- its stop work releases the record once the run is confirmed stopped.
     AND NOT EXISTS (SELECT 1 FROM wf_work s
                      WHERE s.kind = 'turn.stop' AND s.status <> 'settled' AND s.work_key LIKE 'stop:' || cs.id || ':%')
     -- Asked again only a while after the last ask, and a bounded number of
     -- times: a pass that finds it in between adds nothing.
     AND ra.asks < ${RECORD_RETRY.asks}
     AND (ra.last_at IS NULL OR ra.last_at < NOW() - make_interval(mins => ${RECORD_RETRY.minutes}))
   ORDER BY cs.id
   LIMIT ${LIMIT}`;

// A turn instance still `running` with no run item behind it: its item
// settled without ending it (a result the kernel refused, a transition that
// failed), so nothing will ever end it and it holds its change until
// MAX_TURN_MS. Only one quiet for as long as a record is one: a turn that has
// just started writes its item in the same transaction as `running`. Both a
// conversation's and a change's instance, by key.
const ORPHAN_TURNS_SQL = `
  SELECT t.key, t.data->'running'->>'turnId' AS turn_id
    FROM wf_instances t
   WHERE t.machine = 'turn' AND t.state = 'running'
     AND NOT ${turnRunLiveSql('t')}
     AND (t.data->'running'->>'startedAt')::timestamptz
           < NOW() - make_interval(secs => ${QUIET_SECONDS})
   ORDER BY t.key
   LIMIT ${LIMIT}`;

// A turn id the turn machine accepts, the same for the same leftover, so a
// second pass asking for it again is a replay.
const leftoverId = (prefix, identity) => `${prefix}-${String(identity).replace(/[^A-Za-z0-9_.:-]/g, '_')}`.slice(0, 80);

/** One pass of the `turn-leftovers` clock. */
async function sweep(pool, { deps = {} } = {}) {
  const platform = deps.platform || require('../workflow/platform.ts');
  const { rows } = await pool.query(RECORDS_SQL);
  for (const r of rows) {
    const asks = Number(r.asks) || 0;
    await platform.askTurn(pool, {
      key: `session:${Number(r.id)}`,
      turnId: leftoverId('leftover', asks ? `${r.identity}-${asks + 1}` : r.identity),
      kind: 'recover', appId: r.app_id,
      input: { sessionId: Number(r.id), identity: r.identity, last: asks + 1 >= RECORD_RETRY.asks },
    });
  }
  // A turn instance nothing will end: ended as its own timer would have at
  // MAX_TURN_MS, now that no run is behind it. Its Tick names the turn, so a
  // pass that races the real result cannot end the turn that follows.
  const orphans = await pool.query(ORPHAN_TURNS_SQL);
  let orphanTurns = 0;
  for (const t of orphans.rows) {
    if (!t.turn_id) continue;
    await platform.endOrphanTurn(pool, { key: t.key, turnId: t.turn_id });
    orphanTurns += 1;
  }
  return { records: rows.length, orphanTurns };
}

module.exports = { sweep, RECORD_RETRY, RECORDS_SQL, ORPHAN_TURNS_SQL };

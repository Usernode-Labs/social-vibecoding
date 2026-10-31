'use strict';

// What holds a change, and how a leftover is released (request #6068).
//
// A change's busy state used to be one boolean over eight records, four of
// them workflow machine states. A machine state is a projection: it changes
// only when a transition runs, so a transition that faulted, or an item that
// settled without its transition applying, could leave a change saying it was
// being worked on with nothing running on it, and no retry could be
// dispatched. src/workflow/session-work.ts now names every holder and counts
// only a live one; this module reads that list, decides whether it is stuck,
// and ends a leftover the way its own owner would.
//
// Three callers share it, so they cannot disagree:
//   - GET /api/sessions/:id/status and the change page's read (holders,
//     stuck);
//   - POST /api/sessions/:id/release, and the Mayor's release_change tool
//     (the owner's Clear status);
//   - the `change-busy` clock (a branch-less change nothing built, cleared
//     within a few minutes with nobody pressing anything).

const log = require('./logger');
const { sessionHoldersSql, workflowTurnHeldSql, workedOnSql } = require('../workflow/session-work.ts');

const MINUTE = 60 * 1000;
const DEFAULT_STUCK_MS = 10 * MINUTE;

// How old a silent holder must be before it is called stuck. Read once, and
// overridable so a test does not wait ten minutes.
function stuckMs() {
  const configured = Number.parseInt(process.env.CHANGE_STUCK_MS || '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_STUCK_MS;
}

// The kinds that make no progress of their own: nothing on screen moves while
// they run, and an old one means something ended badly. `turn`, `sync`,
// `shots` and a preview build each have progress of their own and are never
// called stuck, however long they take.
const SILENT_KINDS = Object.freeze(new Set(['operation', 'bot', 'build', 'local_agent', 'turn_instance']));

// The machine kinds whose release is a Stop to the owning machine.
const STOP_KINDS = Object.freeze(new Set(['bot', 'build', 'shots', 'sync', 'turn_instance']));

// One sweep asks at most this many changes, and tries this many times to end
// one change's machine work (a Stop is a transition the machine applies).
const SWEEP_LIMIT = 50;
const RELEASE_PASSES = 3;

// What the change's thread says after a clear. Platform-written, in the
// change's own thread (never a project channel), like a run's status lines.
const CLEARED_LINE = 'Cleared a stuck status: nothing was running on this change.';

function defaults(deps = {}) {
  return {
    platform: deps.platform || require('../workflow/platform.ts'),
    localAgent: deps.localAgent || require('./local-agent'),
    turnLeftovers: deps.turnLeftovers || require('./turn-leftovers'),
    sessionState: deps.sessionState || require('./session-state'),
  };
}

const asIso = (value) => {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Every record that says work is happening on `sessionId`, one row each. */
async function holders(pool, sessionId) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const { rows } = await pool.query(sessionHoldersSql('$1'), [id]);
  return rows.map((r) => ({
    kind: String(r.kind),
    since: asIso(r.since),
    ref: r.ref == null ? null : String(r.ref),
  }));
}

// A holder's age. A record with no stamp is old by definition: every record
// the platform writes carries one.
function ageMs(holder, now) {
  if (!holder || !holder.since) return Infinity;
  const at = Date.parse(holder.since);
  return Number.isFinite(at) ? now - at : Infinity;
}

const isOld = (holder, now, windowMs) => ageMs(holder, now) >= windowMs;

/**
 * The stuck view of a holder list, or null.
 *
 * Stuck means: no coding turn (a turn is something a person can wait on), no
 * kind that has progress of its own, and every holder older than the window.
 * Pure, so the rule is testable without a database.
 */
function stuckOf(list, { now = Date.now(), windowMs = stuckMs() } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  if (list.some((h) => h && h.kind === 'turn')) return null;
  if (list.some((h) => !h || !SILENT_KINDS.has(h.kind))) return null;
  if (list.some((h) => !isOld(h, now, windowMs))) return null;
  const oldest = list.reduce((a, b) => (ageMs(b, now) > ageMs(a, now) ? b : a), list[0]);
  return {
    holders: list.map((h) => ({ kind: h.kind, since: h.since })),
    since: oldest.since,
    heldMs: Math.round(ageMs(oldest, now)),
  };
}

// Is the session's coding record held by a work item that is still
// outstanding? A record nothing holds is a leftover its recovery can end; one
// still held is work that is really running.
async function turnHeld(pool, sessionId) {
  const { rows: [r] } = await pool.query(
    `SELECT (${workflowTurnHeldSql('cs.active_turn')}) AS held FROM chat_sessions cs WHERE cs.id = $1`,
    [Number(sessionId)]
  );
  return !!(r && r.held);
}

/** One line in the change's own thread, so a clear is never silent. */
async function noteCleared(pool, sessionId, { by = null } = {}) {
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3::jsonb)`,
    [Number(sessionId), CLEARED_LINE, JSON.stringify({ stuckBusyCleared: true, by })]
  ).catch((err) => {
    log.warn('change-busy', 'Could not write the cleared line', { sessionId, err: err.message });
  });
}

/**
 * End whatever stale records still hold `sessionId`, and answer what was
 * released and what is still holding it.
 *
 * Only a stale, silent holder is released, and only while nothing is really
 * running: a coding turn still held by its item stops the whole release. A
 * live holder that is not stale is refused, never stopped.
 */
async function releaseChange(pool, sessionId, { by = null, now = Date.now(), deps = {} } = {}) {
  const id = Number(sessionId);
  const d = defaults(deps);
  const released = [];
  if (!Number.isSafeInteger(id) || id <= 0) return { released, stillHeld: [] };

  // 1. A coding record nothing holds: ask its recovery, the same ask the
  //    leftovers clock makes, under the same turn id so the two are one ask.
  const turn = (await holders(pool, id)).find((h) => h.kind === 'turn');
  if (turn) {
    if (await turnHeld(pool, id)) {
      return { released, stillHeld: await holders(pool, id), working: true };
    }
    const asked = await d.turnLeftovers.recoverNow(pool, id).catch((err) => {
      log.warn('change-busy', 'Could not ask for a leftover turn\'s recovery', { sessionId: id, err: err.message });
      return false;
    });
    if (asked) released.push('turn');
  }

  // 2. The records that can be ended in place. A Stop goes to the one machine
  //    that owns the turn, which is only the stale holder while every other
  //    holder is stale too (otherwise the Stop would end live work).
  for (let pass = 0; pass < RELEASE_PASSES; pass += 1) {
    const list = await holders(pool, id);
    const stale = list.filter((h) => isOld(h, now, stuckMs()) && SILENT_KINDS.has(h.kind));
    if (!stale.length) break;
    let acted = false;

    const operations = stale.filter((h) => h.kind === 'operation' && h.ref);
    for (const op of operations) {
      await d.platform.operationEnded({ sessionId: id, id: op.ref }).catch((err) => {
        log.warn('change-busy', 'Could not end a recorded operation', { sessionId: id, err: err.message });
      });
      released.push('operation');
      acted = true;
    }

    if (stale.some((h) => h.kind === 'local_agent')) {
      const abandoned = await d.localAgent.abandonSessionTurns(pool, id).catch((err) => {
        log.warn('change-busy', 'Could not release a local agent turn', { sessionId: id, err: err.message });
        return 0;
      });
      if (abandoned) released.push('local_agent');
      acted = acted || abandoned > 0;
    }

    const machines = stale.filter((h) => STOP_KINDS.has(h.kind));
    const othersLive = list.some((h) => !isOld(h, now, stuckMs()) || !SILENT_KINDS.has(h.kind));
    if (machines.length && !othersLive) {
      const answer = await d.platform.stopWorkflowTurn({ sessionId: id, by }).catch((err) => {
        log.warn('change-busy', 'Could not stop the machine holding a change', { sessionId: id, err: err.message });
        return null;
      });
      if (answer) released.push(...machines.map((h) => h.kind));
      acted = acted || !!answer;
    }

    if (!acted) break;
    // A Stop is applied by the machine; give it the round trip before the
    // next read, and the next pass ends whatever is left.
    await new Promise((resolve) => { setTimeout(resolve, 50).unref?.(); });
  }

  const stillHeld = await holders(pool, id).catch(() => []);
  return { released: [...new Set(released)], stillHeld };
}

/**
 * Clear a stuck change: release it, say so in its thread, and tell every open
 * screen. Answers what `releaseChange` found.
 */
async function clear(pool, sessionId, { by = null, deps = {} } = {}) {
  const d = defaults(deps);
  const result = await releaseChange(pool, sessionId, { by, deps });
  if (result.released.length) {
    await noteCleared(pool, sessionId, { by });
    try { d.sessionState.touch(Number(sessionId)); } catch { /* best effort */ }
    log.info('change-busy', 'Cleared a stuck change', { sessionId: Number(sessionId), released: result.released, by });
  }
  return result;
}

// Open changes that never had code: the safe set for an automatic clear. A
// change with a branch keeps the manual route, where its owner asked.
const SWEEP_SQL = `
  SELECT cs.id
    FROM chat_sessions cs
   WHERE cs.status IN ('active', 'paused')
     AND cs.branch_name IS NULL
     AND cs.active_turn IS NULL
     AND ${workedOnSql()}
   ORDER BY cs.id
   LIMIT ${SWEEP_LIMIT}`;

/** One pass of the `change-busy` clock. */
async function sweep(pool, { deps = {} } = {}) {
  const { rows } = await pool.query(SWEEP_SQL);
  let cleared = 0;
  for (const row of rows) {
    const id = Number(row.id);
    const list = await holders(pool, id).catch(() => []);
    if (!stuckOf(list)) continue;
    const result = await clear(pool, id, { by: null, deps }).catch((err) => {
      log.warn('change-busy', 'Could not clear a stuck change', { sessionId: id, err: err.message });
      return { released: [] };
    });
    if (result.released.length) cleared += 1;
  }
  return { found: rows.length, cleared };
}

module.exports = {
  holders,
  stuckOf,
  releaseChange,
  clear,
  sweep,
  noteCleared,
  stuckMs,
  SILENT_KINDS,
  CLEARED_LINE,
  SWEEP_SQL,
};

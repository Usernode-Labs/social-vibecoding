// Durable manifests for checks runs whose containers are in flight.
//
// A checks run is a process-local affair: visuals.captureForSession creates
// the capture Job (and the unit-suite Job), streams their stdout, and turns
// the whole log into a verdict at the end. When the platform Pod running it
// is replaced mid-run — every merge to the self-app rolls the deployment —
// the Jobs keep going to completion on the cluster, but the process that knew
// how to read them is gone. The row sat 'pending' until the stale sweeper
// noticed it CHECKS_STALE_MS later and started the whole suite over; #2125
// paid that ten-minute wait four times in half an hour.
//
// This module is the half that survives the process: one row per run,
// written just before the Jobs are created, heartbeated while they run, and
// deleted when the verdict lands. The manifest carries every input the
// verdict needs that is not in the Job's own output (services/check-harvest.js
// is the reader). The heartbeat is how an orphan is recognised — not by the
// Pod's absence, which the platform cannot see from inside, but by a row
// nobody has touched for CHECK_RUN_ORPHAN_MS.
//
// Everything here is best-effort and never throws into the checks pipeline:
// a run that cannot record its manifest still runs; it just cannot be
// harvested if its process dies.

const os = require('os');
const log = require('./logger');

// How often a live run refreshes heartbeat_at, and how long a row may go
// without one before the harvester treats its owner as dead. The gap is
// deliberately wide (4×): a heartbeat is a single UPDATE and can be late
// under load, and adopting a run whose owner is alive would settle one
// verdict twice (harmless — storeChecks is idempotent on the commit — but
// wasteful).
const HEARTBEAT_MS = Math.max(1000, Number(process.env.CHECK_RUN_HEARTBEAT_MS) || 15_000);
const ORPHAN_MS = Math.max(HEARTBEAT_MS * 2, Number(process.env.CHECK_RUN_ORPHAN_MS) || 60_000);

// ── The platform's own check-run queue (#4317) ──────────────────────────
//
// Check runs reserve real cluster room (8 CPU each), the worker namespace's
// Job and Secret quotas are finite, and Kubernetes refuses the surplus
// outright ("exceeded quota") or leaves a Job Pending until its own
// activeDeadlineSeconds — counted from Job creation, Pending time included —
// kills it. Both looked like the proposal's checks failing. So the platform
// admits at most MAX_CONCURRENT runs and holds the rest as rows in
// state 'queued', starting each when a slot frees.
const MAX_CONCURRENT = Math.max(1, Number(process.env.CHECKS_MAX_CONCURRENT) || 4);
// A draft that has waited this long ranks with the proposals up for a vote,
// so a long stream of votes cannot starve drafts indefinitely.
const AGE_CAP_MS = Math.max(0, Number(process.env.CHECKS_QUEUE_AGE_CAP_MS) || 20 * 60 * 1000);
// How often a waiter polls its row and how often the leader re-dispatches.
const POLL_MS = Math.max(250, Number(process.env.CHECKS_QUEUE_POLL_MS) || 2000);
// A run the cluster turned away (quota refused, Pod unschedulable) waits
// this long before it is eligible again; retries are unlimited because a
// refusal is about capacity and never a verdict.
const RETRY_MS = Math.max(1000, Number(process.env.CHECKS_REQUEUE_BACKOFF_MS) || 60_000);

// The advisory lock key the dispatch transaction holds. Beside the
// leadership keys' range so it can never collide with one.
const DISPATCH_LOCK_KEY = 726_431_7;

// The identity a row is stamped with. HOSTNAME is the Pod name under
// Kubernetes, so a row from a Pod that no longer exists carries a name no
// live process will ever answer to — which is what lets the harvester adopt a
// row from its OWN previous incarnation immediately rather than waiting the
// orphan window out (see listOrphans).
function selfOwner() {
  return `${process.env.HOSTNAME || os.hostname()}:${process.pid}`;
}

// Upsert the manifest for a run. Called twice per run in the normal case: a
// thin provisional row the moment the run is admitted (launched: false — a
// process that dies here has nothing to harvest, so the adopter re-drives
// straight away), then the full manifest just before the Jobs are created.
async function record(pool, { runId, sessionId, commitSha, manifest }) {
  if (!pool || !runId || !sessionId) return false;
  try {
    await pool.query(
      `INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest, state, started_at, heartbeat_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'preparing', NOW(), NOW())
       ON CONFLICT (run_id) DO UPDATE
         SET manifest = EXCLUDED.manifest,
             commit_sha = EXCLUDED.commit_sha,
             owner = EXCLUDED.owner,
             heartbeat_at = NOW()`,
      [runId, sessionId, commitSha || null, selfOwner(), JSON.stringify(manifest || {})]
    );
    return true;
  } catch (err) {
    log.warn('check-runs', 'Could not record the run manifest (non-fatal)', {
      sessionId, runId, err: err.message,
    });
    return false;
  }
}

async function heartbeat(pool, runId) {
  if (!pool || !runId) return false;
  try {
    const { rowCount } = await pool.query(
      'UPDATE check_runs SET heartbeat_at = NOW() WHERE run_id = $1 AND owner = $2',
      [runId, selfOwner()]
    );
    return rowCount > 0;
  } catch (err) {
    log.warn('check-runs', 'Run heartbeat failed (non-fatal)', { runId, err: err.message });
    return false;
  }
}

// The row is deleted rather than marked finished: its only purpose is to be
// found by a harvester, and a settled run has nothing left to harvest. Its
// slot, if it held one, is handed on at once.
async function finish(pool, runId) {
  if (!pool || !runId) return false;
  try {
    const { rowCount } = await pool.query('DELETE FROM check_runs WHERE run_id = $1', [runId]);
    if (rowCount > 0) dispatch(pool).catch(() => {});
    return rowCount > 0;
  } catch (err) {
    log.warn('check-runs', 'Could not clear the run manifest (non-fatal)', { runId, err: err.message });
    return false;
  }
}

// Keep the row warm for as long as the run is going. Returns the function
// that stops it; the interval is unref'd so it never holds the process open.
function startHeartbeat(pool, runId, { intervalMs = HEARTBEAT_MS } = {}) {
  if (!pool || !runId) return () => {};
  const timer = setInterval(() => { heartbeat(pool, runId); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

// Every row whose owner has gone quiet. Two ways to qualify:
//
//   * the heartbeat is older than the orphan window — the owning process
//     died (or is wedged, which for a checks run is the same thing);
//   * the row is stamped with THIS process's owner string but no capture is
//     in flight here for the session — impossible for a live run, so it is a
//     leftover from before a restart that happened to keep the hostname
//     (a docker restart, a test). Adopted without waiting.
//
// `isInFlight(sessionId)` is visuals.hasInFlightCapture; a row whose session
// has a live capture in this process is never an orphan, whatever its
// heartbeat says — that run will settle it (or replace it) itself.
async function listOrphans(pool, { staleMs = ORPHAN_MS, isInFlight = () => false, limit = 50 } = {}) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT run_id, session_id, commit_sha, owner, manifest, state, started_at, heartbeat_at,
            (heartbeat_at < NOW() - ($1::int * INTERVAL '1 millisecond')) AS stale
       FROM check_runs
      ORDER BY started_at ASC
      LIMIT $2`,
    [Math.round(staleMs), limit]
  );
  const me = selfOwner();
  return rows.filter((row) => {
    if (isInFlight(Number(row.session_id))) return false;
    if (row.stale) return true;
    return row.owner === me;
  });
}

// Hand every row this process owns to the next harvester, on the way out.
// A rollout's old Pod heartbeats its runs, and the runs it was harvesting,
// until moments before the new leader's boot sweep, so listOrphans would not
// count them as orphans for another ORPHAN_MS, and in that gap the stale
// sweep started them over (7 Oct 2026). Stamping the heartbeat as long past
// makes them orphans now; renaming the owner means the heartbeat this
// process still sends until it exits matches no row. The runs' Jobs go on
// on the cluster, untouched. Returns how many rows were handed over.
async function release(pool) {
  if (!pool) return 0;
  try {
    const { rowCount } = await pool.query(
      `UPDATE check_runs SET owner = $2, heartbeat_at = 'epoch'
        WHERE owner = $1`,
      [selfOwner(), `${selfOwner()}:exited`]
    );
    return rowCount || 0;
  } catch (err) {
    log.warn('check-runs', 'Could not hand the run manifests over (non-fatal)', { err: err.message });
    return 0;
  }
}

// Take a row over. Compare-and-swap on the owner it was seen with, so two
// harvesters sweeping at once cannot both adopt the same run; the winner then
// heartbeats it like any live run, so if IT dies mid-harvest the next sweep
// finds the row stale again and adopts it in turn.
async function claim(pool, runId, seenOwner) {
  if (!pool || !runId) return false;
  const { rowCount } = await pool.query(
    `UPDATE check_runs SET owner = $2, heartbeat_at = NOW()
      WHERE run_id = $1 AND owner = $3`,
    [runId, selfOwner(), seenOwner]
  );
  return rowCount > 0;
}

// ── The queue (#4317, continued) ───────────────────────────────────────────
//
// One row per wanted run. `enqueue` puts a run in line, `dispatch` grants
// slots from the leader, `waitForSlot` blocks the launcher until its row is
// granted, and `requeue` puts a run the cluster turned away back in line.
// All best-effort and never throwing into the checks pipeline, like the
// module's header says — the exceptions are waitForSlot's abort and
// supersede throws, which ARE the pipeline.

// Put a run in line. In one statement: the session's other 'queued' rows go
// (a newer commit replaces the queued run rather than adding another — its
// waiter sees its row gone and stops quietly), and this row becomes the
// queued one, inheriting the oldest queued_at it replaced so a stream of
// commits does not send a proposal to the back of the line.
async function enqueue(pool, runId, sessionId) {
  if (!pool || !runId || !sessionId) return false;
  try {
    await pool.query(
      `WITH replaced AS (
         DELETE FROM check_runs
          WHERE session_id = $2 AND state = 'queued' AND run_id <> $1
          RETURNING queued_at
       )
       UPDATE check_runs cr
          SET state = 'queued',
              queued_at = COALESCE((SELECT MIN(queued_at) FROM replaced), NOW()),
              retry_at = NULL
        WHERE run_id = $1`,
      [runId, sessionId]
    );
    return true;
  } catch (err) {
    log.warn('check-runs', 'Could not queue the run (non-fatal)', { runId, sessionId, err: err.message });
    return false;
  }
}

// Grant free slots. Eligible queued rows (past retry_at) are ordered:
// proposals up for a vote (promoted / merging) and drafts past the age cap
// first, then FIFO by queued_at. Inside one transaction holding the
// advisory lock so two dispatchers cannot grant the same slot twice.
// Legacy rows (state NULL) count as running so a deploy mid-burst never
// over-dispatches. Returns the run ids granted.
async function dispatch(pool) {
  if (!pool) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [DISPATCH_LOCK_KEY]);
    const count = await client.query(
      `SELECT COUNT(*)::int AS n FROM check_runs
        WHERE state = 'running' OR state IS NULL`
    );
    const free = Math.max(0, MAX_CONCURRENT - (count.rows[0]?.n || 0));
    if (!free) {
      await client.query('COMMIT');
      return [];
    }
    const { rows } = await client.query(
      `WITH picked AS (
         SELECT cr.run_id
           FROM check_runs cr
           JOIN chat_sessions cs ON cs.id = cr.session_id
          WHERE cr.state = 'queued'
            AND (cr.retry_at IS NULL OR cr.retry_at <= NOW())
          ORDER BY CASE WHEN cs.status IN ('promoted', 'merging')
                              OR cr.queued_at < NOW() - ($1::int * INTERVAL '1 millisecond')
                        THEN 0 ELSE 1 END,
                   cr.queued_at ASC,
                   cr.run_id ASC
          LIMIT $2
          FOR UPDATE OF cr SKIP LOCKED
       )
       UPDATE check_runs cr
          SET state = 'running', slot_at = NOW()
         FROM picked
        WHERE cr.run_id = picked.run_id
       RETURNING cr.run_id`,
      [Math.round(AGE_CAP_MS), free]
    );
    await client.query('COMMIT');
    return rows.map((r) => r.run_id);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    log.warn('check-runs', 'Dispatch failed (non-fatal)', { err: err.message });
    return [];
  } finally {
    client.release();
  }
}

// Block the launcher until its run is granted a slot. Enqueue, dispatch,
// then poll the row. Resolves once state = 'running'. Throws:
//   * `signal.reason` on abort (a newer commit replaced this run in-process);
//   * a lifecycle cancellation when the row is GONE (a newer commit's
//     enqueue in another process deleted it — nothing to wait for).
// `onPosition({ position, since })` fires when the reported position changes
// and at least every POSITION_EVERY_MS, so the card's "3rd in line" stays
// honest and the stale sweep sees a live waiter.
const POSITION_EVERY_MS = 60_000;
async function waitForSlot(pool, runId, { sessionId, signal = null, onPosition = null } = {}) {
  if (!pool || !runId || !sessionId) return;
  await enqueue(pool, runId, sessionId);
  await dispatch(pool);
  let lastPosition = null;
  let lastReport = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason || new Error('Checks run aborted');
    let row = null;
    try {
      ({ rows: [row] = [] } = await pool.query(
        'SELECT state, queued_at FROM check_runs WHERE run_id = $1', [runId]
      ));
    } catch (err) {
      log.warn('check-runs', 'Queue poll failed (non-fatal)', { runId, err: err.message });
    }
    if (row?.state === 'running') return;
    if (!row) {
      const lifecycle = require('./preview-lifecycle');
      throw lifecycle.cancelled();
    }
    if (typeof onPosition === 'function' && row.state === 'queued') {
      const position = await queuePosition(pool, runId);
      const now = Date.now();
      if (position != null && (position !== lastPosition || now - lastReport >= POSITION_EVERY_MS)) {
        lastPosition = position;
        lastReport = now;
        try { onPosition({ position, since: row.queued_at }); } catch { /* observer only */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// Where a run stands in the line, or null when it is not queued.
async function queuePosition(pool, runId) {
  if (!pool || !runId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT pos FROM (
         SELECT cr.run_id, ROW_NUMBER() OVER (
                  ORDER BY CASE WHEN cs.status IN ('promoted', 'merging')
                                      OR cr.queued_at < NOW() - ($2::int * INTERVAL '1 millisecond')
                                THEN 0 ELSE 1 END,
                           cr.queued_at ASC, cr.run_id ASC
                )::int AS pos
           FROM check_runs cr
           JOIN chat_sessions cs ON cs.id = cr.session_id
          WHERE cr.state = 'queued'
       ) ranked WHERE run_id = $1`,
      [runId, Math.round(AGE_CAP_MS)]
    );
    return rows.length ? Number(rows[0].pos) : null;
  } catch (err) {
    log.warn('check-runs', 'Queue position read failed (non-fatal)', { runId, err: err.message });
    return null;
  }
}

// Every queued run in dispatch order, with its 1-based position: the cards'
// "3rd in line".
async function queueSnapshot(pool) {
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      `SELECT cr.run_id, cr.session_id, ROW_NUMBER() OVER (
                ORDER BY CASE WHEN cs.status IN ('promoted', 'merging')
                                    OR cr.queued_at < NOW() - ($1::int * INTERVAL '1 millisecond')
                              THEN 0 ELSE 1 END,
                         cr.queued_at ASC, cr.run_id ASC
              )::int AS position
         FROM check_runs cr
         JOIN chat_sessions cs ON cs.id = cr.session_id
        WHERE cr.state = 'queued'
        ORDER BY position`,
      [Math.round(AGE_CAP_MS)]
    );
    return rows.map((r) => ({
      runId: r.run_id, sessionId: Number(r.session_id), position: Number(r.position),
    }));
  } catch (err) {
    log.warn('check-runs', 'Queue snapshot failed (non-fatal)', { err: err.message });
    return [];
  }
}

// The admin card's numbers: how many slots are in use, how many runs wait,
// how long the oldest has waited.
async function queueStats(pool) {
  if (!pool) return null;
  try {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE state = 'running' OR state IS NULL)::int AS running,
              COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
              EXTRACT(EPOCH FROM (NOW() - MIN(queued_at) FILTER (WHERE state = 'queued')))::int AS oldest_wait_seconds
         FROM check_runs`
    );
    return {
      running: Number(row?.running) || 0,
      limit: MAX_CONCURRENT,
      queued: Number(row?.queued) || 0,
      oldestWaitSeconds: row?.oldest_wait_seconds != null ? Number(row.oldest_wait_seconds) : null,
    };
  } catch (err) {
    log.warn('check-runs', 'Queue stats failed (non-fatal)', { err: err.message });
    return null;
  }
}

// A run the cluster turned away goes back in line: it keeps its queued_at
// (its old place), is not dispatched again before retry_at, and its slot is
// freed — then handed on at once.
async function requeue(pool, runId) {
  if (!pool || !runId) return false;
  try {
    await pool.query(
      `UPDATE check_runs
          SET state = 'queued', slot_at = NULL, retry_at = NOW() + ($2::int * INTERVAL '1 millisecond')
        WHERE run_id = $1`,
      [runId, Math.round(RETRY_MS)]
    );
    await dispatch(pool);
    return true;
  } catch (err) {
    log.warn('check-runs', 'Could not requeue the run (non-fatal)', { runId, err: err.message });
    return false;
  }
}

// The leader re-dispatches on a timer so a run that finishes on a process
// that cannot call dispatch (or whose finish raced a free slot) is picked up
// within POLL_MS. Unref'd: never holds the process open.
function startDispatcher(pool) {
  if (!pool) return () => {};
  const timer = setInterval(() => { dispatch(pool).catch(() => {}); }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  HEARTBEAT_MS,
  ORPHAN_MS,
  MAX_CONCURRENT,
  AGE_CAP_MS,
  POLL_MS,
  RETRY_MS,
  selfOwner,
  record,
  heartbeat,
  finish,
  startHeartbeat,
  listOrphans,
  release,
  claim,
  enqueue,
  dispatch,
  waitForSlot,
  queuePosition,
  queueSnapshot,
  queueStats,
  requeue,
  startDispatcher,
};

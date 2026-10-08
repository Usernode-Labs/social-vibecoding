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
const { getPool } = require('../db/pool');

// How often a live run refreshes heartbeat_at, and how long a row may go
// without one before the harvester treats its owner as dead. The gap is
// deliberately wide (4×): a heartbeat is a single UPDATE and can be late
// under load, and adopting a run whose owner is alive would settle one
// verdict twice (harmless — storeChecks is idempotent on the commit — but
// wasteful).
const HEARTBEAT_MS = Math.max(1000, Number(process.env.CHECK_RUN_HEARTBEAT_MS) || 15_000);
const ORPHAN_MS = Math.max(HEARTBEAT_MS * 2, Number(process.env.CHECK_RUN_ORPHAN_MS) || 60_000);

// ── The checks queue (issue #4317) ──────────────────────────────────────
//
// The Kubernetes cluster can only run so many check runs at once — node
// CPU once the object quotas are raised — and a run created beyond that
// either has its Job refused at the namespace's quotas or sits Pending
// until its own activeDeadlineSeconds kills it, both of which used to land
// on the proposal as a verdict. Under the Kubernetes capture runtime the
// platform now holds the run in a queue of its own, on the row
// visuals.captureForSession already records, and only a run granted a slot
// creates Jobs.
//
//   enqueue       stamp the row 'queued' (superseding any other queued row
//                 of the same session), after which the run waits on its
//                 own row rather than creating Jobs.
//   awaitDispatch poll the row until a slot is granted ('dispatched'), the
//                 session stops wanting the run, or the wait is aborted.
//   requeue       hand a slot back after a retry-later refusal, with a
//                 growing delay so a full cluster is not re-probed in a
//                 tight loop.
//   dispatchOnce  the leader tick: grant free slots in priority-then-FIFO
//                 order by compare-and-swap, then recompute every queued
//                 run's position onto chat_sessions.check_queue_position.
//
// A slot counts as occupied until the run's row is deleted (the verdict
// landed) or its heartbeat lapses for twice the orphan window — briefly
// over-admitting rather than deadlocking the queue. Rows the harvester
// adopted count too: their Jobs are live on the cluster.
const DISPATCH_TICK_MS = Math.max(1000, Number(process.env.CHECKS_DISPATCH_TICK_MS) || 5000);
const MAX_CONCURRENT = Math.max(1, Number(process.env.CHECKS_MAX_CONCURRENT) || 4);
// A draft queued longer than this counts as priority too, so a burst of
// vote-bound proposals cannot starve drafts forever.
const PRIORITY_MAX_AGE_MS = Math.max(0, Number(process.env.CHECKS_QUEUE_PRIORITY_MAX_AGE_MS) || 10 * 60 * 1000);
// Refusal-restart backoff: 30 s doubling, capped at 5 minutes.
const REQUEUE_BACKOFF_BASE_MS = 30_000;
const REQUEUE_BACKOFF_CAP_MS = 5 * 60 * 1000;
// The cadence a waiting run polls its own row at — the Job poll's cadence.
const QUEUE_POLL_MS = 2000;

// Stamp the run 'queued' for its session. Called once per run, just after
// the provisional manifest is recorded; a re-drive of the same run (the
// harvester re-driving an orphan) re-stamps it without losing its place.
// Any other QUEUED row of the same session is stamped aside first: a newer
// commit replaces the queued run rather than joining it, and a replaced run
// is never dispatched. Best-effort, like the manifest: a run that cannot
// record its queue state still runs — it just cannot wait for a slot, so
// dispatchOnce never sees it and nothing throttles it.
async function enqueue(pool, { runId, sessionId, commitSha = null, priority = false } = {}) {
  if (!pool || !runId || !sessionId) return false;
  try {
    await pool.query(
      `UPDATE check_runs SET queue_state = 'superseded'
        WHERE session_id = $1 AND queue_state = 'queued' AND run_id <> $2`,
      [sessionId, runId]
    );
    const { rowCount } = await pool.query(
      `UPDATE check_runs
          SET queue_state = 'queued',
              queue_priority = $3::boolean,
              queued_at = COALESCE(queued_at, NOW()),
              owner = $4,
              heartbeat_at = NOW()
        WHERE run_id = $2 AND session_id = $1`,
      [sessionId, runId, !!priority, selfOwner()]
    );
    return rowCount > 0;
  } catch (err) {
    log.warn('check-runs', 'Could not queue the run (non-fatal)', {
      sessionId, runId, err: err.message,
    });
    return false;
  }
}

// The run's place in line, 1-based, as the tick's ordering reads it — the
// initial value the session is stamped with before the first tick runs.
// NULL when the row is gone or unreadable.
async function queuedPosition(pool, runId) {
  if (!pool || !runId) return null;
  const { rows } = await pool.query(
    `WITH ordered AS (
       SELECT run_id, ROW_NUMBER() OVER (
                ORDER BY (queue_priority
                          OR queued_at < NOW() - ($2::int * INTERVAL '1 millisecond')) DESC,
                         queued_at ASC) AS pos
         FROM check_runs WHERE queue_state = 'queued'
      )
      SELECT pos::int FROM ordered WHERE run_id = $1`,
    [runId, Math.round(PRIORITY_MAX_AGE_MS)]
  );
  return rows[0] ? Number(rows[0].pos) : null;
}

// Wait for the run's slot. Resolves true once the row reads 'dispatched';
// false when the run left the queue without running — stamped 'superseded'
// by a newer commit's run, or gone, or the session no longer pins this
// run's commit with a pending verdict (merged, archived, moved on) — so a
// queued run whose proposal moved under it never hangs. Throws through the
// operation signal, so a cancelled preview aborts the wait.
async function awaitDispatch(pool, runId, { signal = null } = {}) {
  for (;;) {
    signal?.throwIfAborted();
    let state = null;
    let wanted = true;
    try {
      const { rows } = await pool.query(
        `SELECT cr.queue_state,
                (cs.check_state = 'pending'
                 AND cs.checks_commit_sha IS NOT DISTINCT FROM cr.commit_sha) AS wanted
           FROM check_runs cr
           JOIN chat_sessions cs ON cs.id = cr.session_id
          WHERE cr.run_id = $1`,
        [runId]
      );
      state = rows[0]?.queue_state ?? null;
      wanted = rows[0]?.wanted !== false;
    } catch (err) {
      log.warn('check-runs', 'Queue poll failed (non-fatal)', { runId, err: err.message });
    }
    if (state === 'dispatched') return true;
    if (state !== 'queued' || !wanted) return false;
    await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MS));
  }
}

// Hand a slot back after a retry-later refusal: 'queued' again, one attempt
// on the clock, and queued_at pushed to at least NOW() + backoff (30 s
// doubling, capped at 5 min) so the granted-then-refused run re-enters at
// the back of its priority class after a real wait rather than in a tight
// loop. Its original turn is otherwise kept.
async function requeue(pool, runId) {
  if (!pool || !runId) return false;
  try {
    const { rows } = await pool.query(
      `UPDATE check_runs
          SET queue_state = 'queued',
              queue_attempts = queue_attempts + 1,
              queued_at = GREATEST(
                COALESCE(queued_at, NOW()),
                NOW() + make_interval(secs => LEAST(30 * power(2, queue_attempts), 300)::double precision))
        WHERE run_id = $1 AND queue_state IN ('dispatched', 'queued')
      RETURNING queue_attempts`,
      [runId]
    );
    return rows.length > 0;
  } catch (err) {
    log.warn('check-runs', 'Could not requeue the run (non-fatal)', { runId, err: err.message });
    return false;
  }
}

// Grant the cluster's free slots. The leader tick's body; idempotent, so a
// handover simply continues: a grant is a compare-and-swap on
// queue_state='queued', and two ticks racing can never both launch a run.
// `maxConcurrent` overrides CHECKS_MAX_CONCURRENT for the call (the tests
// use it to play a small cluster).
async function dispatchOnce(config, pool, { maxConcurrent = MAX_CONCURRENT } = {}) {
  const { rows: slotRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM check_runs
      WHERE queue_state = 'dispatched'
        AND heartbeat_at > NOW() - ($1::int * INTERVAL '1 millisecond')`,
    [2 * ORPHAN_MS]
  );
  const slots = maxConcurrent - (slotRows[0]?.n || 0);
  if (slots > 0) {
    // Priority first (a draft queued past the aging window counts too),
    // then FIFO by queue time; only runs the session still wants. A requeued
    // row whose backoff has yet to pass is skipped by queued_at <= NOW().
    const { rows } = await pool.query(
      `SELECT cr.run_id
         FROM check_runs cr
         JOIN chat_sessions cs ON cs.id = cr.session_id
        WHERE cr.queue_state = 'queued'
          AND cr.queued_at <= NOW()
          AND cs.check_state = 'pending'
          AND cs.status IN ('active', 'paused', 'promoted', 'merging')
          AND cs.checks_commit_sha IS NOT DISTINCT FROM cr.commit_sha
        ORDER BY (cr.queue_priority
                  OR cr.queued_at < NOW() - ($1::int * INTERVAL '1 millisecond')) DESC,
                 cr.queued_at ASC
        LIMIT $2`,
      [Math.round(PRIORITY_MAX_AGE_MS), slots]
    );
    for (const row of rows) {
      const granted = await pool.query(
        `UPDATE check_runs SET queue_state = 'dispatched', heartbeat_at = NOW()
          WHERE run_id = $1 AND queue_state = 'queued'`,
        [row.run_id]
      );
      if (granted.rowCount) {
        log.info('check-runs', 'Granted a cluster slot to a queued checks run', { runId: row.run_id });
      }
    }
  }
  // Mirror the line onto the sessions the card, the feed and the payloads
  // read: one UPDATE over the queued rows, then clear the positions of
  // sessions whose run left the queue.
  await pool.query(
    `WITH ordered AS (
       SELECT session_id, ROW_NUMBER() OVER (
                ORDER BY (queue_priority
                          OR queued_at < NOW() - ($1::int * INTERVAL '1 millisecond')) DESC,
                         queued_at ASC) AS pos
         FROM check_runs WHERE queue_state = 'queued'
      )
      UPDATE chat_sessions cs
         SET check_queue_position = o.pos
        FROM ordered o
       WHERE cs.id = o.session_id`,
    [Math.round(PRIORITY_MAX_AGE_MS)]
  );
  await pool.query(
    `UPDATE chat_sessions cs
        SET check_queue_position = NULL
       WHERE cs.check_queue_position IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM check_runs cr
                          WHERE cr.session_id = cs.id AND cr.queue_state = 'queued')`
  );
}

// How many runs are waiting and how long the oldest has waited — the admin
// status card's two figures. oldestSeconds floors at zero: a requeued row's
// pushed queued_at is still in the future.
async function queueStats(pool) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(queued_at)))))::int AS oldest
       FROM check_runs
      WHERE queue_state = 'queued' AND queued_at <= NOW()`
  );
  return { length: Number(rows[0]?.n) || 0, oldestSeconds: Number(rows[0]?.oldest) || 0 };
}

// The leader-side tick, started from server.becomeLeader beside the harvest
// tick. Kubernetes capture runtime only — docker-hosted capture has no
// cluster to queue for.
function start(config, { intervalMs = DISPATCH_TICK_MS } = {}) {
  if (!config || config.captureRuntime !== 'kubernetes') return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatchOnce(config, getPool(config))
      .catch((err) => {
        log.warn('check-runs', 'Checks dispatch tick failed (non-fatal)', { err: err.message });
      })
      .finally(() => { running = false; });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}


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
      `INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest, started_at, heartbeat_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
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
// found by a harvester, and a settled run has nothing left to harvest.
async function finish(pool, runId) {
  if (!pool || !runId) return false;
  try {
    const { rowCount } = await pool.query('DELETE FROM check_runs WHERE run_id = $1', [runId]);
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
    `SELECT run_id, session_id, commit_sha, owner, manifest, started_at, heartbeat_at,
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

module.exports = {
  HEARTBEAT_MS,
  ORPHAN_MS,
  DISPATCH_TICK_MS,
  MAX_CONCURRENT,
  PRIORITY_MAX_AGE_MS,
  REQUEUE_BACKOFF_BASE_MS,
  REQUEUE_BACKOFF_CAP_MS,
  selfOwner,
  record,
  heartbeat,
  finish,
  startHeartbeat,
  listOrphans,
  release,
  claim,
  enqueue,
  queuedPosition,
  awaitDispatch,
  requeue,
  dispatchOnce,
  queueStats,
  start,
};

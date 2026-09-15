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
  selfOwner,
  record,
  heartbeat,
  finish,
  startHeartbeat,
  listOrphans,
  claim,
};

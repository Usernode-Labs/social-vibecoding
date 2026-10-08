'use strict';

// How long a run on this app usually takes, from what its recent runs
// actually recorded. The change card's progress bar shows the answer as one
// line ("about 4 min") while a run is under way — the bar's segments are the
// progress signal, this is only the wait's size, so it is a per-app median
// over history rather than a countdown.
//
// No new tables or columns: a settled run already carries what it cost. The
// #2170 write (services/visuals.js) reduces checks_progress to the finished
// build block and `checksMs` when the verdict lands, and a verified shot run
// has started_at/completed_at. Everything here READS.

const RUN_SAMPLE_ROWS = 10;
const SHOT_SAMPLE_ROWS = 10;
// Same cadence as the other short-lived per-app reads (the invite-tree
// setting's cache): board repaints refetch /promoted on every WS event, and
// none of them should pay for a median twice within a repaint burst.
const TTL_MS = 10 * 1000;

// Rows the estimate needs, and rows whose run is in flight (the routes set
// `run_eta` on exactly these). The shots half mirrors the client's own
// in-flight set (app-view.js blockReasons / _shotsNotStarted): 'planned'
// counts only while it is fresh, and an interrupted run the recovery sweep
// is about to start again is under way, not failed.
const SHOTS_IN_FLIGHT = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const SHOTS_IDLE_MS = 5 * 60 * 1000;

function runInFlight(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.status === 'merged' || row.status === 'merging') return false;
  if (row.check_state === 'pending' && row.check_phase !== 'deferred') return true;
  const shots = row.shots;
  if (!shots || typeof shots !== 'object') return false;
  if (shots.state === 'failed') return shots.automaticRetryPending === true;
  if (!SHOTS_IN_FLIGHT.has(shots.state)) return false;
  if (shots.state === 'planned') {
    const at = Date.parse(shots.updatedAt || '');
    if (Number.isFinite(at) && Date.now() - at > SHOTS_IDLE_MS) return false;
  }
  return true;
}

function median(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function toMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The run cost, build through checks: the last RUN_SAMPLE_ROWS settled runs
// of this app, each as build totalMs (when the row kept it) + checksMs.
// Legacy rows with only checksMs still count — they are what the app's
// testing half really cost.
async function runCostSamples(pool, appId) {
  const { rows } = await pool.query(
    `SELECT checks_progress->>'checksMs' AS checks_ms,
            checks_progress #>> '{build,totalMs}' AS build_ms
       FROM chat_sessions
      WHERE app_id = $1
        AND check_state IN ('passing', 'failing')
        AND checks_progress ? 'checksMs'
        AND jsonb_typeof(checks_progress) = 'object'
      ORDER BY checks_checked_at DESC NULLS LAST, id DESC
      LIMIT $2`,
    [appId, RUN_SAMPLE_ROWS]
  );
  const out = [];
  for (const row of rows) {
    const checksMs = toMs(row.checks_ms);
    if (checksMs == null) continue;
    const buildMs = toMs(row.build_ms);
    out.push(checksMs + (buildMs || 0));
  }
  return out;
}

// The shots' cost: the last SHOT_SAMPLE_ROWS verified runs, as their own
// wall clock. Added to the run cost only when the app has them — a proposal
// with shots off would otherwise be quoted a wait it never pays.
async function shotCostSamples(pool, appId) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (sr.completed_at - sr.started_at)) * 1000 AS took_ms
       FROM shot_runs sr
       JOIN chat_sessions cs ON cs.id = sr.session_id
      WHERE cs.app_id = $1
        AND sr.state = 'verified'
        AND sr.completed_at IS NOT NULL AND sr.started_at IS NOT NULL
      ORDER BY sr.completed_at DESC
      LIMIT $2`,
    [appId, SHOT_SAMPLE_ROWS]
  );
  return rows.map((r) => toMs(r.took_ms)).filter((v) => v != null);
}

const cache = new Map(); // app id -> { at, value }

async function estimate(pool, appId) {
  const id = Number(appId);
  if (!Number.isFinite(id)) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const runCosts = await runCostSamples(pool, id);
  if (!runCosts.length) {
    // Nothing settled yet: an honest null, not a guess.
    cache.set(id, { at: Date.now(), value: null });
    return null;
  }
  const shotsCosts = await shotCostSamples(pool, id);
  const runMs = median(runCosts);
  const shotsMs = median(shotsCosts);
  const value = {
    ms: runMs + (shotsMs || 0),
    samples: runCosts.length,
  };
  cache.set(id, { at: Date.now(), value });
  return value;
}

function clearCacheForTests() {
  cache.clear();
}

module.exports = { estimate, runInFlight, median, clearCacheForTests, SHOTS_IDLE_MS };

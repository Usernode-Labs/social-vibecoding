'use strict';

// Medians of an app's recent run durations, for the change page's run bar
// estimate ("About 4 minutes left"). Durations are already stored: each
// finished checks run keeps its build wall clock (checks_progress.build's
// totalMs) and its checking wall clock (checksMs) in checks_progress, and
// each verified shots run keeps started_at/completed_at. The MEDIAN of the
// last ten, so one unusually slow run does not throw the estimate off.

// Fewer finished runs than this, and there is nothing to estimate from:
// the bar shows without a time until the app has run a few changes.
const MIN_RUNS = 3;

// pg returns bigint/numeric as strings; every caller wants milliseconds.
function toMs(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(toMs)
    .filter((v) => v != null && v > 0)
    .sort((a, b) => a - b);
  if (nums.length < MIN_RUNS) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

async function getEstimate(pool, appId) {
  const checks = await pool.query(
    `SELECT (checks_progress #>> '{build,totalMs}')::bigint AS build_ms,
            (checks_progress ->> 'checksMs')::bigint AS checks_ms
       FROM chat_sessions
      WHERE app_id = $1 AND check_state IN ('passing','failing')
        AND checks_progress ? 'checksMs'
      ORDER BY checks_checked_at DESC NULLS LAST
      LIMIT 10`,
    [appId]
  );
  const shots = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (sr.completed_at - sr.started_at)) * 1000 AS ms
       FROM shot_runs sr JOIN chat_sessions cs ON cs.id = sr.session_id
      WHERE cs.app_id = $1 AND sr.state = 'verified'
        AND sr.started_at IS NOT NULL AND sr.completed_at IS NOT NULL
      ORDER BY sr.completed_at DESC
      LIMIT 10`,
    [appId]
  );
  const checksRows = checks.rows || [];
  return {
    runs: checksRows.length,
    buildMs: median(checksRows.map((r) => r.build_ms)),
    checksMs: median(checksRows.map((r) => r.checks_ms)),
    shotsRuns: (shots.rows || []).length,
    shotsMs: median((shots.rows || []).map((r) => r.ms)),
  };
}

module.exports = { getEstimate, median, MIN_RUNS };

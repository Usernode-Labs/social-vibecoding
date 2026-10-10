'use strict';

// How long testing a change usually takes on one app (#4452).
//
// A change's page draws its testing as ONE bar: the preview build, then the
// declared checks and the unit suite, split by how long each part usually
// takes here, with the time left. "Usually" is the median of the app's
// recent finished runs. Each run already keeps what it cost once its verdict
// lands: storeChecks reduces `chat_sessions.checks_progress` to `{ build,
// checksMs }` (services/visuals.js, #2170), the finished build with its
// steps' times and the checks' wall clock. So the estimate is a read, with
// no new column: the newest finished runs that kept both halves.
//
// The live position is the client's (public/js/app-view.js
// `_changeTestingView`): the build's steps, the declared checks' ran /
// expected and the unit suite's ran / expected, all already streamed into
// `checks_progress` while a run is in flight.

// How many recent runs the median is taken over, and how few make one: a
// single run is an anecdote, and three is the least that has a middle.
const RECENT_RUNS = 15;
const MIN_RUNS = 3;
// A few seconds' answer is shared by every change page open on the app.
const CACHE_MS = 60 * 1000;

const cache = new Map();

function median(values) {
  const list = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}

// What one finished run's build cost, from its kept build block: the steps'
// own times (the fifth, preparing the checks, included: it is time before
// the first check runs), or the block's total when the steps carry none.
function buildMsOf(progress) {
  const build = progress && progress.build;
  if (!build || typeof build !== 'object' || build.step !== 'done') return null;
  const steps = Array.isArray(build.steps) ? build.steps : [];
  const summed = steps.reduce((n, s) => n + (s && Number.isFinite(s.ms) && s.ms > 0 ? s.ms : 0), 0);
  if (summed > 0) return summed;
  return Number.isFinite(build.totalMs) && build.totalMs > 0 ? build.totalMs : null;
}

// The estimate from a list of kept `checks_progress` snapshots, newest
// first. Null until MIN_RUNS of them carry both halves.
function estimateFrom(snapshots) {
  const runs = (Array.isArray(snapshots) ? snapshots : [])
    .map((p) => ({ build: buildMsOf(p), checks: p && Number(p.checksMs) }))
    .filter((r) => r.build > 0 && Number.isFinite(r.checks) && r.checks > 0)
    .slice(0, RECENT_RUNS);
  if (runs.length < MIN_RUNS) return null;
  return {
    buildMs: median(runs.map((r) => r.build)),
    checksMs: median(runs.map((r) => r.checks)),
    runs: runs.length,
  };
}

// The app's estimate, or null when it has too few finished runs. Best-effort:
// a failed read is no estimate, never a failed page.
async function forApp(pool, appId) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.value;
  let value = null;
  try {
    const { rows } = await pool.query(
      `SELECT checks_progress
         FROM chat_sessions
        WHERE app_id = $1
          AND checks_progress ? 'checksMs'
          AND checks_progress #>> '{build,step}' = 'done'
        ORDER BY checks_checked_at DESC NULLS LAST
        LIMIT $2`,
      [id, RECENT_RUNS]
    );
    value = estimateFrom(rows.map((r) => r.checks_progress));
  } catch (_) {
    value = null;
  }
  cache.set(id, { value, until: Date.now() + CACHE_MS });
  return value;
}

// The staging demo's estimate (?demo=1): about 3 minutes to build the
// preview and 9 to check it, the numbers the design was drawn with.
const DEMO_ESTIMATE = Object.freeze({ buildMs: 180000, checksMs: 540000, runs: 12 });

module.exports = { forApp, estimateFrom, median, buildMsOf, DEMO_ESTIMATE, RECENT_RUNS, MIN_RUNS };

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
// The fallback across the platform is asked at most this often, and only over
// finished runs from the last month.
const PLATFORM_CACHE_MS = 10 * 60 * 1000;

const cache = new Map();
let platformCache = { value: null, until: 0 };

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

// The app's estimate, or null when neither it nor the platform has enough
// finished runs. A project with too few runs of its own borrows the median
// across recent runs everywhere, marked `rough`, and gets the checks queue's
// slot count so a queued run can say how long its wait should be.
// Best-effort: a failed read is no estimate, never a failed page.
async function forApp(pool, appId) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.value;
  let own = null;
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
    own = estimateFrom(rows.map((r) => r.checks_progress));
  } catch (_) {
    own = null;
  }
  let value = null;
  if (own) {
    value = { ...own, rough: false, slots: queueSlots() };
  } else {
    const platform = await forPlatform(pool);
    if (platform) value = { ...platform, rough: true, slots: queueSlots() };
  }
  cache.set(id, { value, until: Date.now() + CACHE_MS });
  return value;
}

// How many proposal runs Homeroom tests at once, read from the checks queue
// (at least one, so the wait estimate never divides by zero). Lazy: the queue
// is a larger module and this estimate is read on page loads.
function queueSlots() {
  try {
    const cap = Number(require('./checks-queue').maxConcurrentRuns());
    return Number.isFinite(cap) && cap >= 1 ? cap : 1;
  } catch (_) {
    return 1;
  }
}

// The median across every project's recent finished runs, for a project with
// too few of its own. Cached for ten minutes in one slot: this read scans the
// whole table, and the answer moves slowly. Best-effort: null on failure.
async function forPlatform(pool) {
  if (platformCache.until > Date.now()) return platformCache.value;
  let value = null;
  try {
    const { rows } = await pool.query(
      `SELECT checks_progress
         FROM chat_sessions
        WHERE checks_progress ? 'checksMs'
          AND checks_progress #>> '{build,step}' = 'done'
          AND checks_checked_at > NOW() - INTERVAL '30 days'
        ORDER BY checks_checked_at DESC NULLS LAST
        LIMIT $1`,
      [RECENT_RUNS]
    );
    value = estimateFrom(rows.map((r) => r.checks_progress));
  } catch (_) {
    value = null;
  }
  platformCache = { value, until: Date.now() + PLATFORM_CACHE_MS };
  return value;
}

// Tests read the fallback with their own fake pools, so each case starts with
// no shared answer.
function resetCaches() {
  cache.clear();
  platformCache = { value: null, until: 0 };
}

// The staging demo's estimate (?demo=1): about 3 minutes to build the
// preview and 9 to check it, the numbers the design was drawn with.
const DEMO_ESTIMATE = Object.freeze({ buildMs: 180000, checksMs: 540000, runs: 12, rough: false, slots: 4 });

module.exports = {
  forApp, forPlatform, estimateFrom, median, buildMsOf, resetCaches,
  DEMO_ESTIMATE, RECENT_RUNS, MIN_RUNS,
};

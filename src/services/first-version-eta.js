'use strict';

// How long a first version still has to go (newcomer run six, 14 Oct 2026).
//
// A first version took about 23 minutes from Make it to live in run six, so
// people put the phone down while it built. The App tab said how long it
// had run ("Building it · 2 min so far") and never how long was left. This
// works out the time left from the platform's own records of the first
// versions that went live lately, so the App tab can say "Building it ·
// about 15 min left" and, under the step under way, "about 12 min left".
//
// ── What it measures ────────────────────────────────────────────────────
//
// The App tab's step list (homeroom-bot-progress.js firstVersionSteps):
// Plan written, Screens drawn, Building, Checking the screens, Testing,
// Live. Each step is timed between the same records the list counts its
// own "since" from, so a step's estimate and the clock the screen counts
// down on start at the same moment:
//
//   screens  decided (its plan went ahead: its maker's answer at Make it,
//            else its build session's start) to the first look drawn, else
//            the build's plan posted
//   build    from there to its review starting, else to its proposal
//   check    its review to its proposal; 0 when no review ran (the step is
//            left out of the list then, and it took no time)
//   test     its proposal to its merge; left out when the merge came more
//            than WAIT_CAP_MS after its checks last ran, which is a wait
//            for somebody's vote, not for the checks
//   live     its merge to its app answering on that build (live_at)
//
// Plan written is not estimated: it waits on its maker, not on the build.
//
// ── Which first versions ────────────────────────────────────────────────
//
// The ones that went live in the last WINDOW_DAYS, newest first, at most
// MAX_SAMPLES. When the build's bot configuration (homeroom_bot_runs
// .bot_config_version_id; the current first-version configuration before
// it has a run) has MIN_SAME_CONFIG of them, only those; else all of them.
// Each step is the MEDIAN of its durations, and a step with fewer than
// MIN_SAMPLES durations means no estimate at all: nothing is said rather
// than a guess.
//
// ── What it answers ─────────────────────────────────────────────────────
//
// For the step under way, from when it began (`since`, the step list's):
//
//   { step, stepEtaAt, etaAt, stepRemainingMs, remainingMs, samples, sameConfig }
//
// `stepEtaAt` is when the step usually ends; `etaAt` when the first version
// usually goes live, the step's end plus every later step's median. The
// browser counts down to them (features/app-frame/first-version-eta.ts) and,
// once the step under way has run past its own, says it is taking a little
// longer than usual rather than counting below zero.
//
// ── Cost ────────────────────────────────────────────────────────────────
//
// GET /api/apps/:slug answers it, and the App tab asks that every ten
// seconds while a first version is built. The finished first versions are
// read once per CACHE_MS for the whole process (one query over a few dozen
// rows, by indexes), and each answer adds one indexed read of its own run's
// configuration.

const log = require('./logger');

const WINDOW_DAYS = 30;
const MAX_SAMPLES = 60;
const MIN_SAMPLES = 3;
const MIN_SAME_CONFIG = 5;
const CACHE_MS = 10 * 60 * 1000;
// A failed read is not asked again on every poll.
const FAILED_CACHE_MS = 60 * 1000;
// A merge this long after its checks last ran waited on a person.
const WAIT_CAP_MS = 15 * 60 * 1000;
// A step this long is a stall or a wait, not a duration to expect.
const STEP_CAP_MS = 6 * 60 * 60 * 1000;

// The steps estimated, in the step list's order (homeroom-bot-progress.js
// FIRST_VERSION_STEP_KEYS without 'plan').
const STEPS = Object.freeze(['screens', 'build', 'check', 'test', 'live']);

// Every first version that went live lately, with its build's records: the
// first live run whose proposal merged and went live (a later fix run on
// the same proposal is not the build).
const SAMPLES_SQL = `SELECT r.bot_config_version_id AS config_id,
       COALESCE(f.answered_at, bs.created_at) AS decided_at,
       (SELECT MIN(s.created_at) FROM first_version_screens s
         WHERE s.bot_run_id = r.id AND s.kind = 'first_look') AS first_look_at,
       (SELECT MAX(p.created_at) FROM homeroom_bot_posts p
         WHERE p.app_id = r.app_id AND p.issue_number = r.issue_number
           AND p.run_id = r.id AND p.kind = 'spec') AS spec_at,
       r.review->>'startedAt' AS review_at,
       COALESCE(cs.promoted_at, cs.created_at) AS proposal_at,
       cs.checks_checked_at AS checks_at,
       cs.merged_at,
       cs.live_at
  FROM homeroom_bot_first_versions f
  JOIN LATERAL (
    SELECT run.id, run.app_id, run.issue_number, run.bot_config_version_id, run.build_session_id,
           run.review, run.proposal_session_id
      FROM homeroom_bot_runs run
      JOIN chat_sessions merged ON merged.id = run.proposal_session_id
     WHERE run.app_id = f.app_id AND run.issue_number = f.issue_number
       AND run.mode = 'live' AND run.verdict = 'ready'
       AND merged.status = 'merged' AND merged.live_at IS NOT NULL
     ORDER BY run.id
     LIMIT 1
  ) r ON TRUE
  JOIN chat_sessions cs ON cs.id = r.proposal_session_id
  LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
 WHERE f.bot_builds AND f.status = 'filed'
   AND cs.live_at > NOW() - make_interval(days => $1::int)
 ORDER BY cs.live_at DESC
 LIMIT $2::int`;

// The configuration a first version is built with before it has a run.
const CURRENT_CONFIG_SQL = `SELECT id FROM bot_config_versions
 WHERE scope = 'first_version' AND role = 'current'
 ORDER BY id DESC LIMIT 1`;

// The configuration of a project's first version's newest run.
const RUN_CONFIG_SQL = `SELECT r.bot_config_version_id AS config_id
  FROM homeroom_bot_first_versions f
  JOIN homeroom_bot_runs r ON r.app_id = f.app_id AND r.issue_number = f.issue_number
 WHERE f.app_id = $1::int
 ORDER BY r.id DESC
 LIMIT 1`;

function ms(value) {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function between(from, to) {
  if (from == null || to == null || to < from) return null;
  const d = to - from;
  return d <= STEP_CAP_MS ? d : null;
}

function configOf(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Pure: one first version that went live, as its steps' durations in ms
 * (null where a step cannot be timed), with its build's configuration.
 */
function sampleOf(row) {
  const decided = ms(row.decided_at);
  const firstLook = ms(row.first_look_at);
  const spec = ms(row.spec_at);
  const review = ms(row.review_at);
  const proposal = ms(row.proposal_at);
  const checks = ms(row.checks_at);
  const merged = ms(row.merged_at);
  const live = ms(row.live_at);
  const screensEnd = firstLook ?? spec;
  const buildEnd = review ?? proposal;
  const waited = merged != null && checks != null && checks >= (proposal ?? -Infinity) && merged - checks > WAIT_CAP_MS;
  return {
    configId: configOf(row.config_id),
    steps: {
      screens: between(decided, screensEnd),
      build: between(screensEnd, buildEnd),
      check: review == null ? (proposal != null ? 0 : null) : between(review, proposal),
      test: waited ? null : between(proposal, merged),
      live: between(merged, live),
    },
  };
}

/** Pure: the median of some numbers, or null for none. */
function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Pure: the first versions to estimate from: those built with `configId`
 * when there are MIN_SAME_CONFIG of them, else all. `{ samples, sameConfig }`.
 */
function poolFor(samples, configId) {
  const all = Array.isArray(samples) ? samples.filter(Boolean) : [];
  const id = configOf(configId);
  const same = id ? all.filter((s) => s.configId === id) : [];
  return same.length >= MIN_SAME_CONFIG ? { samples: same, sameConfig: true } : { samples: all, sameConfig: false };
}

/** Pure: each step's median duration over `samples`, null for a step with fewer than MIN_SAMPLES. */
function stepMedians(samples) {
  const out = {};
  for (const key of STEPS) {
    const values = samples.map((s) => s.steps && s.steps[key]).filter((v) => Number.isFinite(v));
    out[key] = values.length >= MIN_SAMPLES ? median(values) : null;
  }
  return out;
}

/**
 * Pure: the estimate for a first version whose steps are `steps` (the step
 * list, firstVersionSteps), built with `configId`, at `now` (ms), from
 * `samples` (sampleOf). Null when the step under way is not one this
 * estimates, has no start, or any step from it on has too little data.
 */
function estimate(samples, { configId = null, steps = null, now = Date.now() } = {}) {
  const at = Array.isArray(steps) ? steps.find((s) => s && s.state === 'now') : null;
  if (!at || !STEPS.includes(at.key)) return null;
  const since = ms(at.since);
  if (since == null || !Number.isFinite(now)) return null;
  const pool = poolFor(samples, configId);
  if (pool.samples.length < MIN_SAMPLES) return null;
  const medians = stepMedians(pool.samples);
  const from = STEPS.indexOf(at.key);
  let rest = 0;
  for (const key of STEPS.slice(from)) {
    if (medians[key] == null) return null;
    if (key !== at.key) rest += medians[key];
  }
  const stepEnd = since + medians[at.key];
  const end = stepEnd + rest;
  return {
    step: at.key,
    stepEtaAt: new Date(stepEnd).toISOString(),
    etaAt: new Date(end).toISOString(),
    stepRemainingMs: Math.max(0, stepEnd - now),
    remainingMs: Math.max(0, end - now),
    samples: pool.samples.length,
    sameConfig: pool.sameConfig,
  };
}

// The finished first versions, read at most once per CACHE_MS per pool.
const cache = new WeakMap();

async function readSamples(pool) {
  const [{ rows }, current] = await Promise.all([
    pool.query(SAMPLES_SQL, [WINDOW_DAYS, MAX_SAMPLES]),
    pool.query(CURRENT_CONFIG_SQL),
  ]);
  return { samples: rows.map(sampleOf), currentConfigId: configOf(current.rows[0]?.id) };
}

/** The recent first versions' samples and the current configuration, cached. Never throws: null on failure. */
function samplesFor(pool, now = Date.now()) {
  if (!pool || typeof pool.query !== 'function') return Promise.resolve(null);
  const hit = cache.get(pool);
  if (hit && now < hit.until) return hit.promise;
  const entry = { until: now + CACHE_MS, promise: null };
  entry.promise = readSamples(pool).catch((err) => {
    entry.until = now + FAILED_CACHE_MS;
    log.warn('first-version-eta', 'Could not read the recent first versions', { err: err && err.message });
    return null;
  });
  cache.set(pool, entry);
  return entry.promise;
}

/** Forget what was read (tests). */
function forget(pool) {
  if (pool) cache.delete(pool);
}

/**
 * The estimate for project `appId`'s first version, whose step list is
 * `steps`, or null: no step under way to estimate, too little data, or a
 * read that failed. Never throws.
 */
async function estimateFor(pool, appId, steps, { now = Date.now() } = {}) {
  try {
    const at = Array.isArray(steps) ? steps.find((s) => s && s.state === 'now') : null;
    if (!at || !STEPS.includes(at.key) || ms(at.since) == null) return null;
    const read = await samplesFor(pool, now);
    if (!read || read.samples.length < MIN_SAMPLES) return null;
    const { rows } = await pool.query(RUN_CONFIG_SQL, [Number(appId)]);
    const configId = configOf(rows[0]?.config_id) || read.currentConfigId;
    return estimate(read.samples, { configId, steps, now });
  } catch (err) {
    log.warn('first-version-eta', 'Could not estimate a first version', { appId, err: err && err.message });
    return null;
  }
}

module.exports = {
  STEPS,
  WINDOW_DAYS,
  MAX_SAMPLES,
  MIN_SAMPLES,
  MIN_SAME_CONFIG,
  CACHE_MS,
  WAIT_CAP_MS,
  SAMPLES_SQL,
  CURRENT_CONFIG_SQL,
  RUN_CONFIG_SQL,
  sampleOf,
  median,
  poolFor,
  stepMedians,
  estimate,
  samplesFor,
  estimateFor,
  forget,
};

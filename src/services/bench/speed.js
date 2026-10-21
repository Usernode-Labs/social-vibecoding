'use strict';

// What a first version's BUILD took and what its REVIEW found, per App bench
// trial and per arm (services/bench/studio.js watchRun and trialDetail, the
// connector's get_bench_studio_run and get_bench_trial). A change meant to
// make the GLM build faster is judged by the first, and must not make the
// Opus reviewer's findings worse, which is the second. Computed when read,
// never stored: a second copy of the turn ledger is one more thing to keep
// right.
//
// The build is the trial's build turn and its nudge when one ran, the turns
// its cost breakdown names (parsed.costParts.build.turnIds, from
// homeroom-bot-live.js buildAndPropose, since 8 Oct 2026), read from the turn
// ledger (agent_turns, every attempt) in ONE query for a whole run. A
// trial's spec turn and its build turn are both labelled `homeroom_bench`
// (runner.js TELEMETRY), so the component cannot tell them apart; the ids
// can. The plan step's spec turn is read the same way (planSpeedOf: its ids
// are parsed.costParts.spec.turnIds), so a run says how long each plan took
// beside its build. A trial with no build turn on record (a reference, one
// from before the ids were kept, one a restart finished before 13 Oct 2026)
// has no buildSpeed rather than zeros, and a number its turns did not
// record is null: the coding clock (first edit, first boot, the time split)
// from 7 Oct 2026 (worker.js noteCodingRequestClock), compactions from Claude
// Code turns alone. Nulls are left out of an arm's medians.

const log = require('../logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A provider as the worker records it (worker.js SAFE_PROVIDER_NAME), a
// model id, and a harness name.
const PROVIDER_RE = /^[a-zA-Z0-9 ._:/()-]{1,80}$/;
const MODEL_RE = /^[\w./:@+-]{1,160}$/;
const HARNESS_RE = /^[a-z_]{1,20}$/;
// A turn keeps at most eight hosts (agent-turn.js ROUTED_PROVIDERS_MAX).
const ROUTED_PROVIDERS_MAX = 8;

// The ledger's metrics a build's speed is read from (llm-telemetry.js
// normalizeDiagnostics): the query hands back these keys and no others.
const METRIC_KEYS = Object.freeze([
  'provider_turn_count', 'model_request_ms', 'browser_tool_ms', 'shell_tool_ms', 'edit_tool_ms', 'read_tool_ms',
  'other_tool_ms', 'first_file_change_ms', 'first_app_boot_ms', 'first_browser_call_ms', 'last_browser_call_ms',
  'file_change_count', 'distinct_file_change_count', 'context_compaction_count',
  // A configuration's lean_turns tweak (worker.js noteCodingProviderToolOutput,
  // claude-openrouter-request.js's toolBytes).
  'tool_output_pruned_count', 'tool_output_pruned_chars', 'first_request_tool_bytes',
]);

// The numbers an arm takes the median of, and the trials it leaves out: one
// that never ran, or that an admin stopped.
const BUILD_FIELDS = Object.freeze([
  'wallMs', 'modelCalls', 'inputTokens', 'outputTokens', 'inputTokensPerCall', 'firstFileChangeMs', 'firstAppBootMs',
  'browserShare', 'modelRequestMs', 'browserToolMs', 'shellToolMs', 'editToolMs', 'readToolMs', 'otherToolMs',
  'fileChanges', 'distinctFileChanges', 'compactions', 'toolOutputPruned', 'toolOutputPrunedChars', 'toolBytes',
  'shortlistFallbacks',
]);
const REVIEW_FIELDS = Object.freeze(['round1Blockers', 'round1Majors', 'rounds', 'reviewMs', 'doneMs']);
// The plan step's (planSpeedOf): its turn has no browser and no app to boot.
const PLAN_FIELDS = Object.freeze([
  'wallMs', 'modelCalls', 'inputTokens', 'outputTokens', 'inputTokensPerCall', 'modelRequestMs',
  'shellToolMs', 'editToolMs', 'readToolMs', 'otherToolMs', 'fileChanges', 'compactions', 'shortlistFallbacks',
]);
const NOT_RUN = new Set(['pending', 'running', 'awaiting', 'not_applicable', 'skipped_cap', 'cancelled']);

const TURNS_SQL = `SELECT logical_turn_id::text AS turn_id, attempt_number, started_at, completed_at,
            input_tokens, cached_input_tokens, output_tokens, requested_model, routed_model, routed_provider,
            metadata->>'harness' AS harness,
            CASE WHEN jsonb_typeof(metadata->'routed_providers') = 'array' THEN metadata->'routed_providers' END AS routed_providers,
            metadata->>'shortlist_fallbacks' AS shortlist_fallbacks,
            (SELECT jsonb_object_agg(e.key, e.value)
               FROM jsonb_each(CASE WHEN jsonb_typeof(metadata->'telemetry_metrics') = 'object'
                                    THEN metadata->'telemetry_metrics' END) AS e
              WHERE e.key = ANY($2::text[])) AS metrics
       FROM agent_turns
      WHERE logical_turn_id = ANY($1::uuid[])
      ORDER BY started_at, attempt_number`;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round3 = (v) => Math.round(v * 1000) / 1000;
const pick = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

/** The ledger ids of a trial's turns of one stage of its cost breakdown (`build`, `spec`), lower-case. Pure. */
function stageTurnIds(parsed, stage) {
  const ids = parsed?.costParts?.[stage]?.turnIds;
  return (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase());
}

/** The ledger ids of a trial's build turns (its nudge's included), lower-case. Pure. */
function buildTurnIds(parsed) {
  return stageTurnIds(parsed, 'build');
}

/** The ledger ids of a trial's spec turn, the plan step's (its cost breakdown's spec part), lower-case. Pure. */
function planTurnIds(parsed) {
  return stageTurnIds(parsed, 'spec');
}

/**
 * Every attempt of the build turns of `trialRows` (bench_trials rows with
 * `parsed`), in one query, for buildSpeedOf. An empty list when none names a
 * turn; null when the ledger could not be read, so a watch still answers
 * (each trial then carries no buildSpeed). Never throws.
 */
async function buildTurnsFor(pool, trialRows) {
  // The plan's turn too (planSpeedOf), in the same query.
  const ids = [...new Set((Array.isArray(trialRows) ? trialRows : []).flatMap((r) => [...buildTurnIds(r?.parsed), ...planTurnIds(r?.parsed)]))];
  if (!ids.length) return [];
  if (!pool) return null;
  try {
    const { rows } = await pool.query(TURNS_SQL, [ids, [...METRIC_KEYS]]);
    return rows || [];
  } catch (err) {
    log.warn('bench', 'Could not read the build turns for the builds\' speed', { err: err.message });
    return null;
  }
}

/**
 * One trial's build as its turns recorded it (buildTurnsFor's rows, any
 * trial's; the trial's own are picked by its ids), or null with none:
 *
 *   startedAt, wallMs   the first attempt's start, and from it to the last
 *                       one's end (null while one is still running); the
 *                       nudge and the moments between are inside it
 *   turns, attempts     2 turns when a nudge followed the build turn
 *   modelCalls          the model requests (provider_turn_count), summed
 *   input/cachedInput/outputTokens, inputTokensPerCall
 *                       the ledger's tokens (input is every prompt token,
 *                       cache reads a part of it) and their mean per call:
 *                       a call's own size is not kept
 *   firstFileChangeMs, firstAppBootMs, browserSpanMs
 *                       ms from the build's start: each attempt's own clock
 *                       (ms since its agent started) moved by when it started
 *   browserShare        browserSpanMs (first to last browser call) over wallMs
 *   modelRequestMs, browserToolMs, shellToolMs, editToolMs, readToolMs, otherToolMs
 *                       where the time went (worker.js attributeCodingGap)
 *   fileChanges, distinctFileChanges, compactions
 *                       summed over the attempts (a file changed in the build
 *                       and in its nudge is distinct in each)
 *   toolOutputPruned, toolOutputPrunedChars, toolBytes
 *                       what a lean_turns build's requests cut (summed, null
 *                       without the tweak), and the tool definitions' weight
 *                       on its first request
 *   routedProvider, routedModel, requestedModel, harness
 *                       the first attempt's that recorded each
 *   routedProviders, shortlistFallbacks
 *                       every host the attempts' requests went to, first seen
 *                       first (agent-turn.js routedProvidersOf; an attempt
 *                       from before run seven gives its routed_provider), and
 *                       how many of those requests the model's host shortlist
 *                       refused and sent again to every host, summed (null
 *                       when none recorded it): a shortlist that never holds
 *                       has as many fallbacks as calls, as 1017's pin to
 *                       DeepSeek's host did in run 206
 *
 * Pure.
 */
function buildSpeedOf(rows, trial) {
  return turnSpeedOf(rows, buildTurnIds(trial?.parsed));
}

/**
 * The plan step (the spec turn) as its turn recorded it, the same numbers as
 * buildSpeedOf's for its own turn: how long the plan took, how many model
 * calls, how many tokens, and where its time went (writing its drawn screens
 * is an edit, reading the starter a read). Null without its turn on record
 * (a kept plan from before 13 Oct 2026, a trial with no spec turn). Pure.
 */
function planSpeedOf(rows, trial) {
  return turnSpeedOf(rows, planTurnIds(trial?.parsed));
}

/** buildSpeedOf's numbers for the turns `turnIds` names. Pure. */
function turnSpeedOf(rows, turnIds) {
  const ids = new Set(turnIds || []);
  if (!ids.size) return null;
  const ms = (v) => (v ? new Date(v).getTime() : NaN);
  const mine = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && ids.has(String(r.turn_id || '').toLowerCase()))
    .map((r) => ({ r, startMs: ms(r.started_at), endMs: ms(r.completed_at), m: r.metrics && typeof r.metrics === 'object' ? r.metrics : {} }))
    .filter((a) => Number.isFinite(a.startMs))
    .sort((a, b) => a.startMs - b.startMs || (num(a.r.attempt_number) || 0) - (num(b.r.attempt_number) || 0));
  if (!mine.length) return null;
  const startMs = mine[0].startMs;
  const wallMs = mine.every((a) => Number.isFinite(a.endMs)) ? Math.max(0, Math.max(...mine.map((a) => a.endMs)) - startMs) : null;
  const sum = (key) => {
    const v = mine.map((a) => num(a.m[key])).filter((x) => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) : null;
  };
  const at = (key, choose) => {
    const v = mine.map((a) => (num(a.m[key]) == null ? null : a.startMs - startMs + num(a.m[key]))).filter((x) => x != null);
    return v.length ? choose(...v) : null;
  };
  const first = (col, re) => mine.map((a) => pick(a.r[col], re)).find(Boolean) || null;
  const tokens = (col) => mine.reduce((s, a) => s + (num(a.r[col]) || 0), 0);
  // The ledger's columns default to 0: a build whose turns recorded no usage has none, not zero.
  const priced = tokens('input_tokens') + tokens('output_tokens') > 0;
  const calls = sum('provider_turn_count');
  const firstBrowser = at('first_browser_call_ms', Math.min);
  const lastBrowser = at('last_browser_call_ms', Math.max);
  const browserSpanMs = firstBrowser != null && lastBrowser != null ? Math.max(0, lastBrowser - firstBrowser) : null;
  const hosts = [...new Set(mine.flatMap((a) => (Array.isArray(a.r.routed_providers) ? a.r.routed_providers : [a.r.routed_provider])
    .map((name) => pick(name, PROVIDER_RE)).filter(Boolean)))].slice(0, ROUTED_PROVIDERS_MAX);
  const fallbacks = mine.map((a) => num(a.r.shortlist_fallbacks)).filter((x) => x != null);
  return {
    startedAt: new Date(startMs).toISOString(),
    turns: new Set(mine.map((a) => String(a.r.turn_id).toLowerCase())).size,
    attempts: mine.length,
    wallMs,
    modelCalls: calls,
    inputTokens: priced ? tokens('input_tokens') : null,
    cachedInputTokens: priced ? tokens('cached_input_tokens') : null,
    outputTokens: priced ? tokens('output_tokens') : null,
    inputTokensPerCall: priced && calls > 0 ? Math.round(tokens('input_tokens') / calls) : null,
    firstFileChangeMs: at('first_file_change_ms', Math.min),
    firstAppBootMs: at('first_app_boot_ms', Math.min),
    browserSpanMs,
    browserShare: browserSpanMs != null && wallMs > 0 ? round3(browserSpanMs / wallMs) : null,
    modelRequestMs: sum('model_request_ms'),
    browserToolMs: sum('browser_tool_ms'),
    shellToolMs: sum('shell_tool_ms'),
    editToolMs: sum('edit_tool_ms'),
    readToolMs: sum('read_tool_ms'),
    otherToolMs: sum('other_tool_ms'),
    fileChanges: sum('file_change_count'),
    distinctFileChanges: sum('distinct_file_change_count'),
    compactions: sum('context_compaction_count'),
    // What lean_turns cut from the requests, summed as images are (null
    // without the tweak), and what the tool definitions weighed on the
    // build's first request.
    toolOutputPruned: sum('tool_output_pruned_count'),
    toolOutputPrunedChars: sum('tool_output_pruned_chars'),
    toolBytes: mine.map((a) => num(a.m.first_request_tool_bytes)).find((x) => x != null) ?? null,
    routedProvider: first('routed_provider', PROVIDER_RE),
    routedProviders: hosts.length ? hosts : null,
    shortlistFallbacks: fallbacks.length ? fallbacks.reduce((s, x) => s + x, 0) : null,
    routedModel: first('routed_model', MODEL_RE),
    requestedModel: first('requested_model', MODEL_RE),
    harness: first('harness', HARNESS_RE),
  };
}

/**
 * Whether the first build passed the app's own declared checks: round 0's
 * counts (bot-review.js checkCounts, kept from 13 Oct 2026), or, for a review
 * from before, its latest capture while that is still round 0's. { total,
 * ran, failed, allPassed }: allPassed is null when the app declares none or
 * some did not run in time. Null when neither is on record. Pure.
 */
function firstChecksOf(review) {
  const kept = review?.round0?.declaredChecks;
  const counts = kept && typeof kept === 'object' ? kept
    : (review?.latest && Number(review.latest.index) === 0 ? require('../bot-review').checkCounts(review.latest.capture) : null);
  if (!counts) return null;
  const total = num(counts.total) || 0;
  const ran = num(counts.ran) || 0;
  const failed = num(counts.failed) || 0;
  let allPassed = null;
  if (failed > 0) allPassed = false;
  else if (total > 0 && ran >= total) allPassed = true;
  return { total, ran, failed, allPassed };
}

/**
 * A first version's review as a number or two (bot-review.js runReviewLoop's
 * state, as the trial keeps it), or null without one:
 *
 *   round1Verdict, round1Blockers, round1Majors
 *                       round 1's answer and its issues by severity (a failing
 *                       declared check is raised there as a blocker); null
 *                       when round 1's reviewer gave none
 *   stop, rounds        why it stopped and the rounds the reviewer answered
 *   declaredChecks      round 0's (firstChecksOf)
 *   reviewMs, doneMs    the review's wall time, and from `buildStartedAt`
 *                       (buildSpeedOf's startedAt) to its end; a restart's
 *                       downtime is inside both
 *
 * Pure.
 */
function reviewOutcomeOf(review, { buildStartedAt = null } = {}) {
  if (!review || typeof review !== 'object') return null;
  const rounds = (Array.isArray(review.rounds) ? review.rounds : []).filter((r) => r && typeof r === 'object');
  const first = rounds.find((r) => Number(r.round) === 1) || rounds[0] || null;
  const answered = !!first && (first.verdict === 'ship' || first.verdict === 'fix');
  const issues = answered && Array.isArray(first.issues) ? first.issues : [];
  const count = (severity) => (answered ? issues.filter((i) => i && i.severity === severity).length : null);
  const startMs = review.startedAt ? Date.parse(review.startedAt) : NaN;
  const endMs = review.state === 'done' && review.finishedAt ? Date.parse(review.finishedAt) : NaN;
  const buildMs = buildStartedAt ? Date.parse(buildStartedAt) : NaN;
  return {
    round1Verdict: answered ? first.verdict : null,
    round1Blockers: count('blocker'),
    round1Majors: count('major'),
    stop: typeof review.stop === 'string' ? review.stop : null,
    rounds: num(review.roundsUsed) ?? rounds.filter((r) => r.verdict).length,
    declaredChecks: firstChecksOf(review),
    reviewMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
    doneMs: Number.isFinite(buildMs) && Number.isFinite(endMs) ? Math.max(0, endMs - buildMs) : null,
  };
}

/** The median of the finite values, to three places; null with none. Pure. */
function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return round3(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

function mediansOf(list, fields) {
  return Object.fromEntries(fields.map((f) => [f, median(list.map((x) => x[f]))]));
}

/** How many of each value, the values that are null left out. Pure. */
function countsOf(values) {
  const out = {};
  for (const v of values) if (v != null && v !== '') out[v] = (out[v] || 0) + 1;
  return out;
}

/**
 * Per arm (trialOut's armLabel), over its trials that ran to an end: n, and
 * for the builds with turns on record (build.n) the median of each number
 * buildSpeedOf gives with the hosts they ran on (how many builds used each,
 * every host a build's requests went to), and for the reviewed ones
 * (review.n) the median of each of reviewOutcomeOf's with the round-1
 * verdicts, the stops and how often the first build passed its declared
 * checks. Each median is over the trials that recorded that number. Arms in
 * the order their first trial comes. Pure over trialOut's rows.
 */
function armSpeed(trials) {
  const arms = new Map();
  for (const t of Array.isArray(trials) ? trials : []) {
    if (!t || NOT_RUN.has(t.status) || !t.finishedAt) continue;
    const key = String(t.armLabel || '');
    if (!arms.has(key)) arms.set(key, []);
    arms.get(key).push(t);
  }
  return [...arms.entries()].map(([arm, list]) => {
    const builds = list.map((t) => t.buildSpeed).filter(Boolean);
    const plans = list.map((t) => t.planSpeed).filter(Boolean);
    const reviews = list.map((t) => t.reviewOutcome).filter(Boolean);
    const checks = (r) => {
      const passed = r.declaredChecks?.allPassed;
      if (passed == null) return null;
      return passed ? 'passed' : 'failed';
    };
    const hostsOf = (speeds) => countsOf(speeds.flatMap((b) => (Array.isArray(b.routedProviders) ? b.routedProviders : [b.routedProvider])));
    return {
      arm,
      n: list.length,
      plan: { n: plans.length, median: mediansOf(plans, PLAN_FIELDS), hosts: hostsOf(plans) },
      build: { n: builds.length, median: mediansOf(builds, BUILD_FIELDS), hosts: hostsOf(builds) },
      review: {
        n: reviews.length,
        median: mediansOf(reviews, REVIEW_FIELDS),
        round1Verdicts: countsOf(reviews.map((r) => r.round1Verdict)),
        stops: countsOf(reviews.map((r) => r.stop)),
        declaredChecksFirstTime: countsOf(reviews.map(checks)),
      },
    };
  });
}

module.exports = {
  METRIC_KEYS,
  BUILD_FIELDS,
  REVIEW_FIELDS,
  PLAN_FIELDS,
  buildTurnIds,
  planTurnIds,
  buildTurnsFor,
  buildSpeedOf,
  planSpeedOf,
  firstChecksOf,
  reviewOutcomeOf,
  median,
  armSpeed,
};

'use strict';

// A test project's run report: everything recorded about one app's first
// version, for the newcomer tests run on production. A test account makes a
// project, the Homeroom bot builds its first version, and afterwards the run
// is analysed from what the platform wrote down along the way:
//
//   app            the app and its first-version row (the plan written at
//                  Make it, its status and timing, the answers its maker
//                  chose, and the early first look drawn from that plan)
//   runs           the bot's runs on it (verdict, times, sessions, build,
//                  costs, spec sizes, review rounds and why the review stopped)
//   reviewRounds   each review round's verdict and issues
//   sessions       its chat sessions' timeline
//   turns          the agent turns on those sessions (component, model, the
//                  host it was routed to, effort, time, tokens, cost)
//   turnMetrics    every telemetry metric each turn recorded
//   invocations    its llm_invocation events (the plan, the sketch, the
//                  reviewer and the other helper calls)
//   screens        its first-version screens, without their images
//   stages         its first_version_stage events: when the plan was
//                  written, the go-ahead, the pickup (with how long it
//                  waited), the spec, the first look, the build, each review
//                  round, the checks, the merge and live
//   moments        its maker's first_session_moment events: what the made
//                  screen and the tour showed and what was tapped, each with
//                  the browser's time and the server's
//   incidents      its platform_incident events (restarts, resumes, a
//                  review carried on)
//
// It replaces a hand-written query an admin ran on a replica, which had to
// be run BEFORE the test account was retired: taking the app down deletes
// its first version, runs, sessions, turns and screens with it (ON DELETE
// CASCADE), and the account's deletion blanks its llm_invocation events. So
// retiring keeps a copy first (keep(), from services/test-accounts.js
// retire, into test_run_reports), and the connector's get_run_report reads
// the live report or that copy.
//
// What it carries is metadata, as the query did: lengths, times, counts,
// models and costs. Never a secret, a prompt, a spec's body, a message or an
// image's bytes. The free text it does carry (review issues, errors, the
// plan's answers, the app's name, an incident's why) is cut short here and
// wrapped as untrusted data by the tool that returns it. Every list is
// capped, and the whole report is held under MAX_REPORT_BYTES by cutting the
// largest list in half until it fits; `truncated` names every list that was
// cut, with how many rows it had.

const log = require('./logger');
const { withTransaction } = require('./cli-auth');

const VERSION = 1;
// The whole report, as JSON. A first version's usually takes a few tens of
// kilobytes; the cap is for a run that went round and round.
const MAX_REPORT_BYTES = 256 * 1024;
// The most rows each list is read with, earliest first.
const LIMITS = Object.freeze({
  runs: 50,
  sessions: 100,
  turns: 300,
  invocations: 300,
  screens: 30,
  incidents: 100,
  stages: 200,
  moments: 400,
  rounds: 12,
  issuesPerRound: 20,
  metricsPerTurn: 80,
  answers: 6,
});
// The most characters of each kind of text.
const TEXT = Object.freeze({
  name: 120,
  error: 300,
  answer: 200,
  screen: 80,
  problem: 300,
  why: 300,
  metric: 400,
});
// The lists, in the order the report lists them.
const SECTIONS = Object.freeze([
  'runs', 'reviewRounds', 'stages', 'sessions', 'turns', 'turnMetrics', 'invocations', 'screens', 'moments', 'incidents',
]);

// Identifiers the platform or a provider wrote: kept only in their own
// shape, so nothing else rides in a field the tool does not wrap.
const CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const MODEL_RE = /^[\w./:@+-]{1,160}$/;
const BRANCH_RE = /^[\w./-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const PROVIDER_RE = /^[\w .-]{1,80}$/;
const ISSUE_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function bool(v) {
  return v == null ? null : v === true;
}

/** `value` as text of at most `max` characters, marked when cut; null when empty. */
function clip(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

function code(v, re = CODE_RE) {
  if (v == null) return null;
  const text = String(v);
  return re.test(text) ? text : null;
}

// One telemetry value as it was stored: a number or a flag as it is, anything
// else as text (a tool sequence is a list of names), cut short.
function metricValue(v) {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return clip(typeof v === 'string' ? v : JSON.stringify(v), TEXT.metric);
}

function metricsOf(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return { metrics: {}, count: 0 };
  const keys = Object.keys(metrics).filter((k) => CODE_RE.test(k)).sort();
  const out = {};
  for (const key of keys.slice(0, LIMITS.metricsPerTurn)) out[key] = metricValue(metrics[key]);
  return { metrics: out, count: keys.length };
}

// ── Shaping: one row each, pure ─────────────────────────────────────────

function appOut(row) {
  return {
    id: num(row.id),
    slug: String(row.slug),
    name: clip(row.name, TEXT.name),
    status: code(row.status),
    createdAt: iso(row.created_at),
    createdBy: row.created_by == null ? null : { id: num(row.created_by), username: row.created_by_username || null },
  };
}

function firstVersionOut(row) {
  if (!row.has_first_version) return null;
  return {
    createdAt: iso(row.fv_created_at),
    status: code(row.fv_status),
    filedAt: iso(row.filed_at),
    issueNumber: num(row.issue_number),
    botBuilds: bool(row.bot_builds),
    attempts: num(row.fv_attempts),
    error: clip(row.fv_error, TEXT.error),
    briefChars: num(row.brief_chars),
    earlyPlanStatus: code(row.early_plan_status),
    earlyPlanAt: iso(row.early_plan_at),
    planSecs: num(row.plan_secs),
    earlyPlanError: clip(row.early_plan_error, TEXT.error),
    earlyPlanReply: planReplyOut(row.early_plan_reply),
    planQuestions: num(row.plan_questions),
    answeredAt: iso(row.answered_at),
    // In question order: the answer its maker chose, or null for the
    // suggested one.
    answers: Array.isArray(row.answers)
      ? row.answers.slice(0, LIMITS.answers).map((a) => (a == null ? null : clip(a, TEXT.answer)))
      : null,
    // Newcomer run six: the early first look (first-version-early-look.js),
    // drawn from the plan at Make it: how far it got, seconds from Make it to
    // its drawing and to its picture, and its size. Never the screen itself.
    earlyLook: row.early_look_status ? {
      status: code(row.early_look_status),
      model: code(row.early_look_model, MODEL_RE),
      error: clip(row.early_look_error, TEXT.error),
      drawnSecs: num(row.look_drawn_secs),
      savedSecs: num(row.look_saved_secs),
      screenChars: num(row.early_look_chars),
      bytes: num(row.early_look_bytes),
    } : null,
  };
}

function runOut(row) {
  return {
    id: num(row.id),
    issueNumber: num(row.issue_number),
    mode: code(row.mode),
    verdict: code(row.verdict),
    readReason: code(row.read_reason),
    model: code(row.model, MODEL_RE),
    createdAt: iso(row.created_at),
    awaitingGoAt: iso(row.awaiting_go_at),
    goAheadAt: iso(row.go_ahead_at),
    liveBuildWaitingAt: iso(row.live_build_waiting_at),
    buildQueuedAt: iso(row.build_queued_at),
    buildAt: iso(row.build_at),
    sessionId: num(row.session_id),
    buildSessionId: num(row.build_session_id),
    proposalSessionId: num(row.proposal_session_id),
    buildOk: bool(row.build_ok),
    buildAttempts: num(row.build_attempts),
    buildCommits: num(row.build_commits),
    buildError: clip(row.build_error, TEXT.error),
    error: clip(row.error, TEXT.error),
    budgetStop: code(row.budget_stop, /^[a-z][a-z ]{0,39}$/),
    costUsd: num(row.cost_usd),
    buildCostUsd: num(row.build_cost_usd),
    durationMs: num(row.duration_ms),
    specMdChars: num(row.spec_md_chars),
    specHtmlChars: num(row.spec_html_chars),
    reviewRounds: num(row.review_rounds),
    reviewStop: code(row.review_stop),
    review: row.review_state == null && row.review_cost_usd == null ? null : {
      state: code(row.review_state),
      stopDetail: clip(row.review_stop_detail, TEXT.error),
      costUsd: num(row.review_cost_usd),
      resumes: num(row.review_resumes),
    },
    botConfig: row.bot_config_version_id == null ? null : {
      id: num(row.bot_config_version_id),
      key: code(row.bot_config_key),
      version: num(row.bot_config_version),
    },
  };
}

// A run's review rounds (bot-review.js runReviewLoop's `rounds`), each with
// its verdict, the reviewer call, the fix turn and the issues it raised.
function roundsOf(runId, rounds) {
  if (!Array.isArray(rounds)) return [];
  return rounds.slice(0, LIMITS.rounds).map((r) => {
    const round = r && typeof r === 'object' ? r : {};
    const issues = Array.isArray(round.issues) ? round.issues : [];
    const fix = round.fix && typeof round.fix === 'object' ? round.fix : null;
    return {
      runId,
      round: num(round.round),
      verdict: code(round.verdict),
      reviewedBy: code(round.reviewedBy),
      booted: bool(round.booted),
      reviewerMs: num(round.reviewerMs),
      reviewerCostUsd: num(round.reviewerCostUsd),
      reviewerError: clip(round.reviewerError, TEXT.error),
      fix: fix ? {
        ok: fix.ok === true,
        commits: num(fix.commits),
        costUsd: num(fix.costUsd),
        ms: num(fix.ms),
        error: clip(fix.error, TEXT.error),
        stopped: fix.stopped === true,
      } : null,
      issueCount: issues.length,
      issues: issues.slice(0, LIMITS.issuesPerRound).map((i) => {
        const issue = i && typeof i === 'object' ? i : {};
        return {
          id: code(issue.id, ISSUE_ID_RE),
          severity: code(issue.severity),
          screen: clip(issue.screen, TEXT.screen),
          problem: clip(issue.problem, TEXT.problem),
        };
      }),
    };
  });
}

function sessionOut(row) {
  return {
    id: num(row.id),
    status: code(row.status),
    branchName: code(row.branch_name, BRANCH_RE),
    prNumber: num(row.pr_number),
    createdAt: iso(row.created_at),
    promotedAt: iso(row.promoted_at),
    mergedAt: iso(row.merged_at),
    liveAt: iso(row.live_at),
    archivedAt: iso(row.archived_at),
    checkState: code(row.check_state),
    checksCommitSha: code(row.checks_commit_sha, SHA_RE),
  };
}

function turnOut(row) {
  return {
    id: String(row.id),
    sessionId: num(row.session_id),
    component: code(row.component),
    requestedModel: code(row.requested_model, MODEL_RE),
    routedModel: code(row.routed_model, MODEL_RE),
    routedProvider: code(row.routed_provider, MODEL_RE),
    reasoningEffort: code(row.reasoning_effort),
    status: code(row.status),
    attempt: num(row.attempt_number),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    secs: num(row.secs),
    inputTokens: num(row.input_tokens),
    cachedInputTokens: num(row.cached_input_tokens),
    outputTokens: num(row.output_tokens),
    reasoningOutputTokens: num(row.reasoning_output_tokens),
    costUsd: num(row.actual_cost_usd),
    errorCode: code(row.error_code),
  };
}

function turnMetricsOut(row) {
  const { metrics, count } = metricsOf(row.metrics);
  return {
    turnId: String(row.id),
    sessionId: num(row.session_id),
    component: code(row.component),
    count,
    metrics,
  };
}

function invocationOut(row) {
  return {
    at: iso(row.created_at),
    component: code(row.component),
    attempt: num(row.attempt_number),
    requestedModel: code(row.requested_model, MODEL_RE),
    servedModel: code(row.served_model, MODEL_RE),
    provider: code(row.provider),
    routedProvider: code(row.routed_provider, PROVIDER_RE),
    durationMs: num(row.duration_ms),
    outcome: code(row.outcome),
    stopReason: code(row.stop_reason),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: num(row.cost_usd),
  };
}

function screenOut(row) {
  return {
    runId: num(row.bot_run_id),
    kind: code(row.kind),
    position: num(row.position),
    contentType: code(row.content_type, /^[a-z]+\/[a-z0-9.+-]{1,40}$/),
    width: num(row.width),
    height: num(row.height),
    bytes: num(row.bytes),
    createdAt: iso(row.created_at),
  };
}

// The shape of a plan at Make it that was refused (first-version-plan.js
// replyShape): written as lengths, types and codes, never a word of it.
function planReplyOut(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    chars: num(raw.chars),
    json: code(raw.json),
    why: code(raw.why),
    keyCount: num(raw.keyCount),
    keys: Array.isArray(raw.keys) ? raw.keys.slice(0, 20).map((k) => ({
      key: code(k && k.key),
      type: code(k && k.type),
      length: num(k && k.length),
      items: num(k && k.items),
    })) : [],
    finishReason: code(raw.finishReason),
    toolCallCount: num(raw.toolCallCount),
    textChars: num(raw.textChars),
    routedProvider: code(raw.routedProvider, PROVIDER_RE),
  };
}

// A stage's own detail, as first-version-timeline.js cleanDetail kept it:
// numbers, booleans and short codes under plain keys.
const DETAIL_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
function detailOut(metadata, skip) {
  const out = {};
  if (!metadata || typeof metadata !== 'object') return out;
  for (const [key, value] of Object.entries(metadata)) {
    if (skip.includes(key) || !DETAIL_KEY_RE.test(key)) continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && CODE_RE.test(value)) out[key] = value;
  }
  return out;
}

function stageOut(row) {
  const m = row.metadata || {};
  return {
    at: iso(row.created_at),
    stage: code(m.stage),
    runId: num(m.runId),
    issueNumber: num(m.issueNumber),
    sessionId: num(row.session_id),
    ...detailOut(m, ['stage', 'runId', 'issueNumber']),
  };
}

function momentOut(row) {
  const m = row.metadata || {};
  return {
    at: iso(row.created_at),
    clientAt: iso(m.clientAt),
    kind: code(m.kind),
    userId: num(row.user_id),
    ...detailOut(m, ['kind', 'clientAt', 'receivedAt']),
  };
}

function incidentOut(row) {
  return {
    at: iso(row.created_at),
    kind: code(row.kind),
    mode: code(row.mode),
    outcome: code(row.outcome),
    why: clip(row.why, TEXT.why),
    runId: num(row.run_id),
    issueNumber: num(row.issue_number),
    sessionId: num(row.session_id),
  };
}

/**
 * Hold `report` under `max` bytes of JSON: while it is over, the list that
 * takes the most room keeps its first half, and `truncated` records it with
 * the number of rows it had. Mutates and returns `report`; reads nothing.
 */
function fitReport(report, max = MAX_REPORT_BYTES) {
  const size = (v) => Buffer.byteLength(JSON.stringify(v));
  let total = size(report);
  while (total > max) {
    let worst = null;
    let worstSize = 0;
    for (const key of SECTIONS) {
      if (!Array.isArray(report[key]) || !report[key].length) continue;
      const s = size(report[key]);
      if (s > worstSize) { worst = key; worstSize = s; }
    }
    if (!worst) break;
    const rows = report[worst];
    const kept = Math.floor(rows.length / 2);
    const before = report.truncated[worst];
    report.truncated[worst] = { shown: kept, total: before ? before.total : rows.length };
    report[worst] = rows.slice(0, kept);
    total = size(report);
  }
  return report;
}

/**
 * The report from rows as the queries below return them: { app, runs,
 * sessions, turns, invocations, screens, stages, moments, incidents } (`app` the one row of
 * APP_SQL, the rest arrays; each list's rows carry `total`, its row count
 * before the LIMIT). Pure.
 */
function shapeReport(rows, { now = new Date() } = {}) {
  const truncated = {};
  const capped = (key, list, limit) => {
    const total = list.length ? num(list[0].total) || list.length : 0;
    if (total > list.length || list.length > limit) truncated[key] = { shown: Math.min(list.length, limit), total };
    return list.slice(0, limit);
  };
  const runRows = capped('runs', rows.runs || [], LIMITS.runs);
  const turnRows = capped('turns', rows.turns || [], LIMITS.turns);
  const reviewRounds = [];
  for (const run of runRows) {
    const rounds = Array.isArray(run.review_rounds_json) ? run.review_rounds_json : [];
    if (rounds.length > LIMITS.rounds) {
      const t = truncated.reviewRounds || { shown: 0, total: 0 };
      truncated.reviewRounds = { shown: t.shown + LIMITS.rounds, total: t.total + rounds.length };
    }
    reviewRounds.push(...roundsOf(num(run.id), rounds));
  }
  const report = {
    version: VERSION,
    generatedAt: iso(now),
    app: appOut(rows.app),
    firstVersion: firstVersionOut(rows.app),
    runs: runRows.map(runOut),
    reviewRounds,
    stages: capped('stages', rows.stages || [], LIMITS.stages).map(stageOut),
    sessions: capped('sessions', rows.sessions || [], LIMITS.sessions).map(sessionOut),
    turns: turnRows.map(turnOut),
    turnMetrics: turnRows.map(turnMetricsOut).filter((t) => t.count > 0),
    invocations: capped('invocations', rows.invocations || [], LIMITS.invocations).map(invocationOut),
    screens: capped('screens', rows.screens || [], LIMITS.screens).map(screenOut),
    moments: capped('moments', rows.moments || [], LIMITS.moments).map(momentOut),
    incidents: capped('incidents', rows.incidents || [], LIMITS.incidents).map(incidentOut),
    truncated,
  };
  return fitReport(report);
}

// ── Reading it ──────────────────────────────────────────────────────────

// The app by id or by slug, with its first-version row. Lengths only of
// the brief, which is what its maker typed.
const APP_SQL = `
  SELECT a.id, a.slug, a.name, a.status, a.created_at, a.created_by, u.username AS created_by_username,
         fv.app_id IS NOT NULL AS has_first_version,
         fv.created_at AS fv_created_at, fv.status AS fv_status, fv.filed_at, fv.issue_number,
         fv.bot_builds, fv.attempts AS fv_attempts, fv.error AS fv_error, length(fv.brief) AS brief_chars,
         fv.early_plan_status, fv.early_plan_at,
         ROUND(EXTRACT(EPOCH FROM fv.early_plan_at - fv.created_at)::numeric, 1) AS plan_secs,
         fv.early_plan_error, fv.early_plan_reply,
         CASE WHEN jsonb_typeof(fv.early_plan->'questions') = 'array'
              THEN jsonb_array_length(fv.early_plan->'questions') ELSE 0 END AS plan_questions,
         fv.answered_at, fv.answers,
         el.status AS early_look_status, el.model AS early_look_model, el.error AS early_look_error,
         ROUND(EXTRACT(EPOCH FROM el.drawn_at - fv.created_at)::numeric, 1) AS look_drawn_secs,
         ROUND(EXTRACT(EPOCH FROM el.saved_at - fv.created_at)::numeric, 1) AS look_saved_secs,
         length(el.screen) AS early_look_chars, el.bytes AS early_look_bytes
    FROM apps a
    LEFT JOIN users u ON u.id = a.created_by
    LEFT JOIN homeroom_bot_first_versions fv ON fv.app_id = a.id
    LEFT JOIN first_version_early_looks el ON el.app_id = a.id
   WHERE a.id = COALESCE($1::int, (SELECT x.id FROM apps x WHERE x.slug = $2::text))`;

// Lengths only of the spec; of the review, its rounds and a few numbers,
// never its captures.
const RUNS_SQL = `
  SELECT r.id, r.issue_number, r.mode, r.verdict, r.read_reason, r.model, r.created_at,
         r.awaiting_go_at, r.go_ahead_at, r.live_build_waiting_at, r.build_queued_at, r.build_at,
         r.session_id, r.build_session_id, r.proposal_session_id, r.build_ok, r.build_attempts, r.build_commits,
         r.build_error, r.error, r.budget_stop, r.cost_usd, r.build_cost_usd, r.duration_ms,
         length(r.build_spec_md) AS spec_md_chars, length(r.build_spec_html) AS spec_html_chars,
         r.review_rounds, r.review_stop, r.bot_config_version_id, v.key AS bot_config_key, v.version AS bot_config_version,
         r.review->>'state' AS review_state, r.review->>'stopDetail' AS review_stop_detail,
         r.review->>'costUsd' AS review_cost_usd, r.review->>'resumes' AS review_resumes,
         CASE WHEN jsonb_typeof(r.review->'rounds') = 'array' THEN r.review->'rounds' END AS review_rounds_json,
         COUNT(*) OVER () AS total
    FROM homeroom_bot_runs r
    LEFT JOIN bot_config_versions v ON v.id = r.bot_config_version_id
   WHERE r.app_id = $1
   ORDER BY r.id
   LIMIT $2`;

const SESSIONS_SQL = `
  SELECT cs.id, cs.status, cs.branch_name, cs.pr_number, cs.created_at, cs.promoted_at, cs.merged_at,
         cs.live_at, cs.archived_at, cs.check_state, cs.checks_commit_sha,
         COUNT(*) OVER () AS total
    FROM chat_sessions cs
   WHERE cs.app_id = $1
   ORDER BY cs.id
   LIMIT $2`;

const TURNS_SQL = `
  SELECT t.id, t.session_id, t.metadata->>'telemetry_component' AS component,
         t.requested_model, t.routed_model, t.routed_provider, t.reasoning_effort, t.status, t.attempt_number,
         t.started_at, t.completed_at,
         ROUND(EXTRACT(EPOCH FROM t.completed_at - t.started_at)::numeric, 1) AS secs,
         t.input_tokens, t.cached_input_tokens, t.output_tokens, t.reasoning_output_tokens,
         t.actual_cost_usd, t.error_code,
         CASE WHEN jsonb_typeof(t.metadata->'telemetry_metrics') = 'object'
              THEN t.metadata->'telemetry_metrics' END AS metrics,
         COUNT(*) OVER () AS total
    FROM agent_turns t
    JOIN chat_sessions cs ON cs.id = t.session_id
   WHERE cs.app_id = $1
   ORDER BY t.started_at, t.id
   LIMIT $2`;

const INVOCATIONS_SQL = `
  SELECT e.created_at, e.metadata->>'component' AS component, e.metadata->>'attempt_number' AS attempt_number,
         e.metadata->>'requested_model' AS requested_model, e.metadata->>'served_model' AS served_model,
         e.metadata->>'provider' AS provider, e.metadata->>'routed_provider' AS routed_provider,
         e.metadata->>'duration_ms' AS duration_ms,
         e.metadata->>'outcome' AS outcome, e.metadata->>'stop_reason' AS stop_reason,
         e.metadata->>'input_tokens' AS input_tokens, e.metadata->>'output_tokens' AS output_tokens,
         e.metadata->>'cost_usd' AS cost_usd,
         COUNT(*) OVER () AS total
    FROM events e
   WHERE e.app_id = $1 AND e.event_type = 'llm_invocation'
   ORDER BY e.created_at, e.id
   LIMIT $2`;

// Never the image itself.
const SCREENS_SQL = `
  SELECT s.bot_run_id, s.kind, s.position, s.content_type, s.width, s.height, s.bytes, s.created_at,
         COUNT(*) OVER () AS total
    FROM first_version_screens s
    JOIN homeroom_bot_runs r ON r.id = s.bot_run_id
   WHERE r.app_id = $1
   ORDER BY s.created_at, s.id
   LIMIT $2`;

const INCIDENTS_SQL = `
  SELECT e.created_at, e.session_id, e.metadata->>'kind' AS kind, e.metadata->>'mode' AS mode,
         e.metadata->>'outcome' AS outcome, e.metadata->>'why' AS why,
         e.metadata->>'runId' AS run_id, e.metadata->>'issueNumber' AS issue_number,
         COUNT(*) OVER () AS total
    FROM events e
   WHERE e.app_id = $1 AND e.event_type = 'platform_incident'
   ORDER BY e.created_at, e.id
   LIMIT $2`;

const STAGES_SQL = `
  SELECT e.created_at, e.session_id, e.metadata,
         COUNT(*) OVER () AS total
    FROM events e
   WHERE e.app_id = $1 AND e.event_type = 'first_version_stage'
   ORDER BY e.created_at, e.id
   LIMIT $2`;

const MOMENTS_SQL = `
  SELECT e.created_at, e.user_id, e.metadata,
         COUNT(*) OVER () AS total
    FROM events e
   WHERE e.app_id = $1 AND e.event_type = 'first_session_moment'
   ORDER BY e.created_at, e.id
   LIMIT $2`;

/**
 * The report for the app `appId` or `slug`, as it stands now. `db` is a pool
 * or a client. Null when there is no such app.
 */
async function build(db, { appId = null, slug = null } = {}) {
  const id = Number.isSafeInteger(Number(appId)) && Number(appId) > 0 ? Number(appId) : null;
  const name = typeof slug === 'string' && slug ? slug : null;
  if (!id && !name) return null;
  const { rows: [app] } = await db.query(APP_SQL, [id, name]);
  if (!app) return null;
  // One after another: `db` may be one client, inside keep()'s transaction.
  const { rows: runs } = await db.query(RUNS_SQL, [app.id, LIMITS.runs]);
  const { rows: sessions } = await db.query(SESSIONS_SQL, [app.id, LIMITS.sessions]);
  const { rows: turns } = await db.query(TURNS_SQL, [app.id, LIMITS.turns]);
  const { rows: invocations } = await db.query(INVOCATIONS_SQL, [app.id, LIMITS.invocations]);
  const { rows: screens } = await db.query(SCREENS_SQL, [app.id, LIMITS.screens]);
  const { rows: incidents } = await db.query(INCIDENTS_SQL, [app.id, LIMITS.incidents]);
  const { rows: stages } = await db.query(STAGES_SQL, [app.id, LIMITS.stages]);
  const { rows: moments } = await db.query(MOMENTS_SQL, [app.id, LIMITS.moments]);
  return shapeReport({ app, runs, sessions, turns, invocations, screens, stages, moments, incidents });
}

// ── Keeping it ──────────────────────────────────────────────────────────

/**
 * Keep the report of `app` (an apps row) before it is taken down, for the
 * test account `testUser` ({ id, username }) that made it. One row per app:
 * a retire run again after a teardown failed replaces it with the fresher
 * one. Never throws, and never waits long on a slow read: a report that
 * cannot be kept is logged and the retire goes on. Resolves true when kept.
 */
async function keep(pool, { app, testUser = null } = {}) {
  if (!app || !Number.isSafeInteger(Number(app.id))) return false;
  try {
    return await withTransaction(pool, async (client) => {
      // A statement that runs past this is cut off, so a slow read never
      // holds the retire up for long.
      await client.query("SET LOCAL statement_timeout = '15s'");
      const report = await build(client, { appId: Number(app.id) });
      if (!report) return false;
      await client.query(
        `INSERT INTO test_run_reports (app_id_was, slug, app_name, test_user_id, test_username, report)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (app_id_was) DO UPDATE
           SET slug = EXCLUDED.slug, app_name = EXCLUDED.app_name,
               test_user_id = EXCLUDED.test_user_id, test_username = EXCLUDED.test_username,
               report = EXCLUDED.report, created_at = NOW()`,
        [
          Number(app.id), String(app.slug), clip(app.name, TEXT.name),
          testUser && Number.isSafeInteger(Number(testUser.id)) ? Number(testUser.id) : null,
          testUser && testUser.username ? String(testUser.username) : null,
          JSON.stringify(report),
        ]
      );
      return true;
    });
  } catch (err) {
    log.warn('run-report', 'Could not keep a test project\'s run report; the retire goes on', {
      appId: Number(app.id), slug: app.slug, err: err.message,
    });
    return false;
  }
}

function keptOut(row) {
  return {
    id: num(row.id),
    appId: num(row.app_id_was),
    slug: String(row.slug),
    appName: row.app_name || null,
    savedAt: iso(row.created_at),
  };
}

/**
 * The newest report kept for `slug`, or the one with `id`:
 * { id, appId, slug, appName, savedAt, testUser: { id, username }, report },
 * or null.
 */
async function kept(db, { slug = null, id = null } = {}) {
  const { rows: [row] } = id != null
    ? await db.query(
      `SELECT id, app_id_was, slug, app_name, test_user_id, test_username, created_at, report
         FROM test_run_reports
        WHERE id = $1`,
      [Number(id)]
    )
    : await db.query(
      `SELECT id, app_id_was, slug, app_name, test_user_id, test_username, created_at, report
         FROM test_run_reports
        WHERE slug = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [String(slug)]
    );
  if (!row) return null;
  return {
    ...keptOut(row),
    testUser: { id: num(row.test_user_id), username: row.test_username || null },
    report: row.report,
  };
}

/**
 * The reports kept for the test account `username` (as it was when it was
 * retired, or as it is now), newest first: [{ id, appId, slug, appName,
 * savedAt }].
 */
async function keptFor(db, username, { limit = 50 } = {}) {
  const name = String(username || '').toLowerCase();
  if (!name) return [];
  const { rows } = await db.query(
    `SELECT id, app_id_was, slug, app_name, created_at
       FROM test_run_reports
      WHERE LOWER(test_username) = $1
         OR test_user_id IN (SELECT u.id FROM users u WHERE LOWER(u.username) = $1)
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [name, limit]
  );
  return rows.map(keptOut);
}

module.exports = {
  VERSION,
  MAX_REPORT_BYTES,
  LIMITS,
  TEXT,
  SECTIONS,
  clip,
  fitReport,
  shapeReport,
  roundsOf,
  build,
  keep,
  kept,
  keptFor,
};

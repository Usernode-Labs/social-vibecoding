'use strict';

// Before & after shots runs as one CSV, for the analysis no per-proposal
// screen can do: which failure codes dominate, which phase a timeout dies
// in, what a run costs, how often a retry rescues a run — across every
// proposal, not only the merged ones the admin gallery lists.
//
// One row per run, retries and stale runs included: a run that was retried
// or overtaken by a newer head is itself a data point. The route in
// routes/admin.js owns the gate and the streaming; this module owns the
// query, the filters and the column mapping, the same split as the Homeroom
// bot's verdict ledger export (services/homeroom-bot.js EXPORT_COLUMNS).
//
// WHAT IS LEFT OUT, deliberately:
//   * `agentFinalResponse(s)` — the shots agent's final answer may carry
//     app-derived text. The orchestrator already strips it from the general
//     log and shows it only to the proposal owner and app managers; a bulk
//     download is not the place to widen that.
//   * `heartbeat`, `author_plan`, `replay_plan`, `semantic_verdict` — live
//     bookkeeping or retired pipeline fields with nothing to analyse.
//   * The image bytes. The CSV names how many artifacts a run still retains;
//     the per-run diagnostics path in each row leads to the rest.
//
// RETENTION bounds what any export can hold (services/shots-gc.js): failed,
// stale, cancelled, not-required and overridden runs are pruned after 30
// days unless they are still their proposal's current run, and a failed
// run's images after 24 hours. `artifacts_retained` is therefore what is
// left NOW; `artifact_bytes_stored` is what the run stored at the time.

const RUN_STATES = Object.freeze([
  'planned', 'provisioning', 'exploring', 'replaying', 'reviewing',
  'verified', 'failed', 'stale', 'cancelled', 'not_required', 'overridden',
]);

// `in_progress` is not a state: it selects every run still under way, the
// group a person means when asking "what is running right now".
const IN_PROGRESS_STATES = Object.freeze(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const STATE_FILTERS = Object.freeze([...RUN_STATES, 'in_progress']);

const EXPORT_COLUMNS = Object.freeze([
  'run_id', 'created_at', 'started_at', 'completed_at', 'updated_at', 'duration_ms',
  'app_slug', 'app_name', 'session_id', 'session_title', 'session_status', 'session_source',
  'pr_number', 'pr_url', 'proposal_path',
  'trigger', 'repair_attempt', 'current_run', 'state',
  'failure_code', 'failure_reason', 'failure_phase', 'failure_message',
  'failure_tool', 'failure_tool_code', 'failure_tool_message', 'terminal_failure_class',
  'failure_detail_json',
  'impact', 'stories_declared', 'stories_ready', 'stories_skipped', 'story_results_json',
  'plan_source', 'agent_attempts', 'agent_backends', 'agent_models', 'agent_budget_ms',
  'agent_dispatches_json',
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'cost_cents',
  'total_ms', 'timings_json',
  'agent_counts_json', 'agent_tool_counts_json', 'agent_browser_call_counts_json',
  'agent_last_events_json', 'agent_pending_json', 'control_json',
  'artifact_bytes_stored', 'artifacts_retained', 'artifact_bytes_retained',
  'base_sha', 'head_sha', 'plan_hash',
  'fixture_fingerprint', 'base_image_digest', 'head_image_digest',
  'overridden_by', 'overridden_at', 'override_reason',
  'intent_json', 'diagnostics_path',
  // Last, so an analysis that reads the earlier columns by position is not
  // shifted: `shutdown` when a Homeroom restart interrupted the run (the
  // shutdown handler's tag, which the automatic retry counts against its
  // larger budget). Blank on an interrupted run means nothing explained the
  // interruption, or that it predates the tag.
  'interrupted_by',
]);

// The agent's own event ring holds up to 128 entries; the tail is what
// docs/proposal-visuals/shots-agent-diagnostics.md says to read first.
const LAST_EVENTS = 10;

const APP_SLUG_RE = /^[a-z0-9-]{1,120}$/;

/**
 * Validate the query string. Returns `{ ok: true, filters }` or
 * `{ ok: false, error }` — an unusable filter is refused rather than
 * dropped, because dropping it would hand back a bigger file than was asked
 * for and nothing in a CSV says which filters applied.
 */
function parseFilters(q = {}) {
  const filters = { app: null, state: null, since: null };
  if (q.app != null && q.app !== '') {
    if (typeof q.app !== 'string' || !APP_SLUG_RE.test(q.app)) {
      return { ok: false, error: 'app must be an app slug' };
    }
    filters.app = q.app;
  }
  if (q.state != null && q.state !== '') {
    if (typeof q.state !== 'string' || !STATE_FILTERS.includes(q.state)) {
      return { ok: false, error: `state must be one of: ${STATE_FILTERS.join(', ')}` };
    }
    filters.state = q.state;
  }
  if (q.since != null && q.since !== '') {
    const raw = String(q.since);
    const at = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(raw) ? new Date(raw) : null;
    if (!at || Number.isNaN(at.getTime())) {
      return { ok: false, error: 'since must be a date (YYYY-MM-DD) or an ISO timestamp' };
    }
    filters.since = at.toISOString();
  }
  return { ok: true, filters };
}

function statesFor(state) {
  if (!state) return null;
  return state === 'in_progress' ? [...IN_PROGRESS_STATES] : [state];
}

/** The part of the download's filename that says what is in it. */
function exportScope({ app = null, state = null, since = null } = {}) {
  return [
    app || 'all-apps',
    state || 'all-states',
    ...(since ? [`since-${since.slice(0, 10)}`] : []),
  ].join('-');
}

// Newest first, keyset-paged on (created_at, id). The cursor carries
// created_at as Postgres TEXT, not a JS Date: a Date keeps milliseconds and
// the column keeps microseconds, so a Date cursor could skip or repeat the
// rows that share a millisecond. `id` is random hex; it only breaks ties.
//
// No global index on created_at: the table is pruned to about a month of
// runs, so a sort over it is cheap, and adding an index to a hot write path
// for an occasional admin download is the wrong trade.
const RUNS_SQL = `
  SELECT r.id, r.session_id, r.base_sha, r.head_sha, r.plan_hash, r.intent,
         r.trace_summary, r.hard_verdict, r.state, r.trigger,
         r.failure_code, r.failure_reason, r.fixture_fingerprint,
         r.base_image_digest, r.head_image_digest, r.repair_attempt,
         r.override_reason, r.overridden_at,
         r.started_at, r.completed_at, r.created_at, r.updated_at,
         r.created_at::text AS created_cursor,
         ou.username AS overridden_by,
         s.status AS session_status, s.source AS session_source,
         s.pr_number, s.pr_url,
         COALESCE(s.session_title, s.pr_title) AS session_title,
         (s.shots_run_id IS NOT DISTINCT FROM r.id) AS current_run,
         a.slug AS app_slug, a.name AS app_name,
         art.n AS artifacts_retained, art.bytes AS artifact_bytes_retained
    FROM shot_runs r
    JOIN chat_sessions s ON s.id = r.session_id
    JOIN apps a ON a.id = s.app_id
    LEFT JOIN users ou ON ou.id = r.override_user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n, COALESCE(SUM(sa.bytes), 0)::bigint AS bytes
        FROM shot_artifacts sa
       WHERE sa.run_id = r.id
    ) art ON TRUE
   WHERE ($1::text IS NULL OR a.slug = $1)
     AND ($2::text[] IS NULL OR r.state = ANY($2::text[]))
     AND ($3::timestamptz IS NULL OR r.created_at >= $3::timestamptz)
     AND ($4::timestamptz IS NULL OR (r.created_at, r.id) < ($4::timestamptz, $5::text))
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT $6`;

// How many rows one export query takes. Bounded so any number of runs
// streams in constant memory; not a cap on how many rows the file holds.
const EXPORT_CHUNK = 200;

/**
 * Every run matching the filters, newest first, a chunk at a time. The
 * caller writes each chunk out and never holds the whole set.
 */
async function* iterateRunsForExport(pool, {
  app = null, state = null, since = null, chunk = EXPORT_CHUNK,
} = {}) {
  const size = Math.min(Math.max(Number(chunk) || EXPORT_CHUNK, 1), 1000);
  const states = statesFor(state);
  let cursor = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(RUNS_SQL, [
      app || null, states, since || null,
      cursor ? cursor.createdAt : null, cursor ? cursor.id : null, size,
    ]);
    if (!rows.length) return;
    yield rows;
    if (rows.length < size) return;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_cursor, id: last.id };
  }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const json = (v) => {
  if (v == null) return null;
  if (Array.isArray(v) && !v.length) return null;
  if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return null;
  return JSON.stringify(v);
};
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const ms = (v) => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/** One run as an object keyed by EXPORT_COLUMNS. */
function exportRecord(row) {
  const trace = obj(row.trace_summary);
  const failure = obj(trace.failure);
  const activity = obj(trace.agentActivity);
  const usage = obj(trace.tokenUsage);
  const timings = obj(trace.timingsMs);
  const dispatches = arr(trace.agentDispatches);
  const intent = obj(row.intent);
  const declared = arr(intent.stories);
  const verdict = obj(row.hard_verdict);
  const results = arr(verdict.stories).map((story) => {
    const s = obj(story);
    return {
      id: s.id ?? null,
      status: s.status ?? null,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.note ? { note: s.note } : {}),
    };
  });
  const started = ms(row.started_at);
  const completed = ms(row.completed_at);
  const pending = {};
  for (const [key, field] of [
    ['tools', 'pendingTools'], ['browserCalls', 'pendingBrowserCalls'],
    ['documentRequests', 'pendingDocumentRequests'], ['providerRequests', 'pendingProviderRequests'],
  ]) {
    if (arr(activity[field]).length) pending[key] = activity[field];
  }
  const slug = row.app_slug || null;
  return {
    run_id: row.id,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    duration_ms: started != null && completed != null ? Math.max(0, completed - started) : null,
    app_slug: slug,
    app_name: row.app_name,
    session_id: row.session_id,
    session_title: row.session_title,
    session_status: row.session_status,
    session_source: row.session_source,
    pr_number: row.pr_number,
    pr_url: row.pr_url,
    proposal_path: slug && row.session_id ? `/#app/${slug}/dev/proposals/${row.session_id}` : null,
    trigger: row.trigger,
    repair_attempt: row.repair_attempt,
    current_run: row.current_run == null ? null : !!row.current_run,
    state: row.state,
    failure_code: row.failure_code,
    failure_reason: row.failure_reason,
    failure_phase: failure.phase ?? null,
    failure_message: failure.message ?? null,
    failure_tool: failure.tool ?? null,
    failure_tool_code: failure.toolCode ?? null,
    failure_tool_message: failure.toolMessage ?? null,
    terminal_failure_class: trace.terminalFailureClass ?? null,
    failure_detail_json: json(failure.detail),
    impact: intent.impact ?? null,
    stories_declared: declared.length,
    stories_ready: results.length ? results.filter((s) => s.status === 'ready').length : null,
    stories_skipped: results.length ? results.filter((s) => s.status !== 'ready').length : null,
    story_results_json: json(results),
    plan_source: trace.planSource ?? null,
    agent_attempts: num(trace.agentAttempts),
    agent_backends: dispatches.map((d) => obj(d).backend || obj(d).requestedBackend || '').filter(Boolean).join('|') || null,
    agent_models: [...new Set(dispatches.map((d) => obj(d).requestedModel || '').filter(Boolean))].join('|') || null,
    agent_budget_ms: num(activity.budgetMs),
    agent_dispatches_json: json(dispatches),
    input_tokens: num(usage.inputTokens),
    cached_input_tokens: num(usage.cachedInputTokens),
    cache_write_input_tokens: num(usage.cacheWriteInputTokens),
    output_tokens: num(usage.outputTokens),
    reasoning_output_tokens: num(usage.reasoningOutputTokens),
    cost_cents: num(usage.costCents),
    total_ms: num(timings.total),
    timings_json: json(timings),
    agent_counts_json: json(activity.counts),
    agent_tool_counts_json: json(activity.toolCounts),
    agent_browser_call_counts_json: json(activity.browserCallCounts),
    agent_last_events_json: json(arr(activity.events).slice(-LAST_EVENTS)),
    agent_pending_json: json(pending),
    control_json: json(trace.control),
    artifact_bytes_stored: num(trace.artifactBytes),
    artifacts_retained: num(row.artifacts_retained),
    artifact_bytes_retained: num(row.artifact_bytes_retained),
    base_sha: row.base_sha,
    head_sha: row.head_sha,
    plan_hash: row.plan_hash,
    fixture_fingerprint: row.fixture_fingerprint,
    base_image_digest: row.base_image_digest,
    head_image_digest: row.head_image_digest,
    overridden_by: row.overridden_by,
    overridden_at: row.overridden_at,
    override_reason: row.override_reason,
    intent_json: json(row.intent),
    interrupted_by: typeof trace.interruptedBy === 'string' && /^[a-z_]{1,32}$/.test(trace.interruptedBy)
      ? trace.interruptedBy : null,
    diagnostics_path: slug && row.session_id
      ? `/api/apps/${slug}/proposals/${row.session_id}/shots/diagnostics?runId=${row.id}`
      : null,
  };
}

/** One run as the values of EXPORT_COLUMNS, in that order. */
function exportRow(row) {
  const record = exportRecord(row);
  return EXPORT_COLUMNS.map((key) => {
    const v = record[key];
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

module.exports = {
  RUN_STATES,
  STATE_FILTERS,
  EXPORT_COLUMNS,
  EXPORT_CHUNK,
  parseFilters,
  exportScope,
  iterateRunsForExport,
  exportRecord,
  exportRow,
};

'use strict';

// Provider-neutral, content-free LLM invocation telemetry.
//
// Anthropic Mayor/helper calls and Claude/local coding-agent runs did not
// previously have a durable per-invocation record, so they are appended to
// the existing private `events` ledger. OpenRouter attempts already have an
// authoritative row in `agent_turns`; aggregateReport() normalizes those rows
// at read time rather than copying them into a second ledger.

const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('./logger');

const EVENT_TYPE = 'llm_invocation';
const MAX_REPORT_DAYS = 90;

const PROVIDERS = new Set(['anthropic', 'openrouter', 'local', 'unknown']);
const BACKENDS = new Set(['mayor', 'coding_agent', 'helper']);
const COMPONENTS = new Set([
  'mayor_phase_1',
  'mayor_data_iteration',
  'mayor_phase_2',
  'headless_decision',
  'headless_wrapup',
  'quick_replies',
  'session_title',
  'pr_metadata',
  'progress_estimate',
  'coding_agent_scout',
  'coding_agent_build',
  'coding_agent_headless',
  'other_helper',
]);
const BILLING_PATHS = new Set([
  'platform', 'anthropic_byok', 'openrouter_byok', 'local_subscription', 'unknown',
]);
const COST_SOURCES = new Set([
  'provider_reported', 'platform_estimate', 'catalog_estimate', 'unavailable',
]);
const OUTCOMES = new Set(['success', 'error', 'cancelled', 'refusal', 'unknown']);

let configuredPoolSource = null;
// Stay inert until application initialization. Unit tests that import llm.js
// without booting the server therefore never attempt an accidental DB write.
let enabled = false;
let testSink = null;
let lastWarningAt = 0;
let suppressedWarnings = 0;

function init(config = {}) {
  configuredPoolSource = config;
  enabled = config.llmTelemetryEnabled !== false;
}

function finiteNonnegative(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function tokenCount(value) {
  const n = finiteNonnegative(value);
  return n == null ? null : Math.round(n);
}

function safeId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function safeString(value, max = 255) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function safeReason(value) {
  const text = safeString(value, 64);
  return text && /^[a-zA-Z0-9_.:-]+$/.test(text) ? text : null;
}

function safeOpaqueId(value, max = 180) {
  const text = safeString(value, max);
  return text && /^[a-zA-Z0-9_.:-]+$/.test(text) ? text : null;
}

function safeModel(value) {
  const text = safeString(value, 255);
  // Provider model identifiers are slugs, not free text. Keeping this field
  // syntactically constrained prevents an accidental caller from putting
  // prompt/output content into an otherwise allowlisted string slot.
  return text && /^[a-zA-Z0-9_./:-]+$/.test(text) ? text : null;
}

function enumValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeEvent(event = {}) {
  const costSource = enumValue(event.costSource, COST_SOURCES, 'unavailable');
  const costUsd = costSource === 'unavailable' ? null : finiteNonnegative(event.costUsd);
  const timestamp = event.timestamp instanceof Date
    ? event.timestamp
    : new Date(event.timestamp || Date.now());
  const validTimestamp = Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
  const attempt = tokenCount(event.attemptNumber);

  // This is an explicit allowlist. No caller-provided object is spread into
  // metadata, which structurally prevents prompts, outputs, errors, paths or
  // credentials from entering the telemetry ledger.
  return {
    invocation_key: safeOpaqueId(event.invocationKey) || crypto.randomUUID(),
    timestamp: validTimestamp.toISOString(),
    provider: enumValue(event.provider, PROVIDERS, 'unknown'),
    backend: enumValue(event.backend, BACKENDS, 'helper'),
    component: enumValue(event.component, COMPONENTS, 'other_helper'),
    requested_model: safeModel(event.requestedModel),
    served_model: safeModel(event.servedModel),
    billing_path: enumValue(event.billingPath, BILLING_PATHS, 'unknown'),
    input_tokens: tokenCount(event.inputTokens),
    cache_read_input_tokens: tokenCount(event.cacheReadInputTokens),
    cache_write_input_tokens: tokenCount(event.cacheWriteInputTokens),
    output_tokens: tokenCount(event.outputTokens),
    reasoning_output_tokens: tokenCount(event.reasoningOutputTokens),
    cost_usd: costUsd,
    cost_source: costUsd == null ? 'unavailable' : costSource,
    duration_ms: finiteNonnegative(event.durationMs),
    outcome: enumValue(event.outcome, OUTCOMES, 'unknown'),
    stop_reason: safeReason(event.stopReason),
    attempt_number: attempt && attempt > 0 ? attempt : null,
    correlation_id: safeOpaqueId(event.correlationId),
  };
}

function resolvePool(poolOrConfig) {
  if (poolOrConfig && typeof poolOrConfig.query === 'function') return poolOrConfig;
  return getPool(poolOrConfig || configuredPoolSource);
}

function warnOnce(error) {
  try {
    const now = Date.now();
    if (now - lastWarningAt < 60_000) {
      suppressedWarnings += 1;
      return;
    }
    log.warn('llm-telemetry', 'Invocation telemetry write failed (turn unaffected)', {
      code: safeReason(error && error.code) || 'write_failed',
      suppressed: suppressedWarnings,
    });
    lastWarningAt = now;
    suppressedWarnings = 0;
  } catch {
    // Even malformed error objects or a logging failure stay observational.
  }
}

// Fire-and-forget by contract. The returned promise always resolves, and the
// sink is invoked synchronously so deterministic unit tests can inspect the
// normalized event without timing races.
function record(poolOrConfig, event = {}) {
  if (!enabled) return Promise.resolve(false);
  try {
    const normalized = normalizeEvent(event);
    const appId = safeId(event.appId);
    const sessionId = safeId(event.sessionId);
    const result = testSink
      ? testSink({ appId, sessionId, ...normalized })
      : resolvePool(poolOrConfig).query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
         VALUES (
           NULL,
           COALESCE($1::INTEGER, (SELECT app_id FROM chat_sessions WHERE id = $2)),
           $2,
           $3,
           $4::jsonb
         )
         ON CONFLICT DO NOTHING`,
        [appId, sessionId, EVENT_TYPE, JSON.stringify(normalized)],
      );
    return Promise.resolve(result).then(() => true).catch((error) => {
      warnOnce(error);
      return false;
    });
  } catch (error) {
    warnOnce(error);
    return Promise.resolve(false);
  }
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function count(value) {
  return Number(value || 0);
}

// Admin-only callers enforce authorization at the route layer. This method
// returns aggregates only; neither CTE projects user_id nor any content field.
async function aggregateReport(poolOrConfig, { days = 14 } = {}) {
  const boundedDays = Number(days);
  if (!Number.isInteger(boundedDays) || boundedDays < 1 || boundedDays > MAX_REPORT_DAYS) {
    const err = new Error(`days must be an integer between 1 and ${MAX_REPORT_DAYS}`);
    err.code = 'invalid_timeframe';
    throw err;
  }
  const pool = resolvePool(poolOrConfig);
  const { rows } = await pool.query(
    `WITH normalized AS (
       SELECT COALESCE(
                CASE WHEN e.metadata->>'timestamp' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                     THEN (e.metadata->>'timestamp')::timestamptz END,
                e.created_at
              ) AS occurred_at,
              e.app_id AS app_id,
              e.session_id AS session_id,
              e.metadata->>'provider' AS provider,
              e.metadata->>'backend' AS backend,
              e.metadata->>'component' AS component,
              NULLIF(e.metadata->>'requested_model', '') AS requested_model,
              NULLIF(e.metadata->>'served_model', '') AS served_model,
              e.metadata->>'billing_path' AS billing_path,
              CASE WHEN e.metadata->>'input_tokens' ~ '^\\d+$'
                   THEN (e.metadata->>'input_tokens')::bigint END AS input_tokens,
              CASE WHEN e.metadata->>'cache_read_input_tokens' ~ '^\\d+$'
                   THEN (e.metadata->>'cache_read_input_tokens')::bigint END AS cache_read_input_tokens,
              CASE WHEN e.metadata->>'cache_write_input_tokens' ~ '^\\d+$'
                   THEN (e.metadata->>'cache_write_input_tokens')::bigint END AS cache_write_input_tokens,
              CASE WHEN e.metadata->>'output_tokens' ~ '^\\d+$'
                   THEN (e.metadata->>'output_tokens')::bigint END AS output_tokens,
              CASE WHEN e.metadata->>'reasoning_output_tokens' ~ '^\\d+$'
                   THEN (e.metadata->>'reasoning_output_tokens')::bigint END AS reasoning_output_tokens,
              CASE WHEN jsonb_typeof(e.metadata->'cost_usd') = 'number'
                   THEN (e.metadata->>'cost_usd')::numeric END AS cost_usd,
              COALESCE(e.metadata->>'cost_source', 'unavailable') AS cost_source,
              CASE WHEN jsonb_typeof(e.metadata->'duration_ms') = 'number'
                   THEN (e.metadata->>'duration_ms')::double precision END AS duration_ms,
              COALESCE(e.metadata->>'outcome', 'unknown') AS outcome
         FROM events e
        WHERE e.event_type = $1
          AND e.created_at >= NOW() - ($2::text || ' days')::interval

       UNION ALL

       SELECT a.started_at AS occurred_at,
              s.app_id AS app_id,
              a.session_id AS session_id,
              'openrouter' AS provider,
              'coding_agent' AS backend,
              a.metadata->>'telemetry_component' AS component,
              a.requested_model,
              COALESCE(a.routed_model, a.requested_model) AS served_model,
              'openrouter_byok' AS billing_path,
              CASE WHEN a.provider_input_tokens_total IS NULL THEN NULL ELSE a.input_tokens END,
              CASE WHEN a.provider_cached_input_tokens_total IS NULL THEN NULL ELSE a.cached_input_tokens END,
              CASE WHEN a.provider_cache_write_input_tokens_total IS NULL THEN NULL ELSE a.cache_write_input_tokens END,
              CASE WHEN a.provider_output_tokens_total IS NULL THEN NULL ELSE a.output_tokens END,
              CASE WHEN a.provider_reasoning_output_tokens_total IS NULL THEN NULL ELSE a.reasoning_output_tokens END,
              a.estimated_cost_usd AS cost_usd,
              CASE WHEN a.estimated_cost_usd IS NULL THEN 'unavailable' ELSE 'catalog_estimate' END AS cost_source,
              EXTRACT(EPOCH FROM (a.completed_at - a.started_at)) * 1000 AS duration_ms,
              CASE a.status
                WHEN 'completed' THEN 'success'
                WHEN 'failed' THEN 'error'
                WHEN 'cancelled' THEN 'cancelled'
                ELSE 'unknown'
              END AS outcome
         FROM agent_turns a
         JOIN chat_sessions s ON s.id = a.session_id
        WHERE a.provider = 'openrouter'
          AND a.status IN ('completed', 'failed', 'cancelled')
          AND a.started_at >= NOW() - ($2::text || ' days')::interval
          -- Attached only when a post-baseline physical dispatch is known.
          -- This excludes both older rows and durable intents cancelled
          -- during spin-up before the OpenRouter process was launched.
          AND a.metadata ? 'telemetry_component'
     ), grouped AS (
       SELECT provider, backend, component, requested_model, served_model, billing_path,
              COUNT(*) AS invocation_count,
              COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
              COUNT(*) FILTER (WHERE outcome = 'error') AS error_count,
              COUNT(*) FILTER (WHERE outcome = 'cancelled') AS cancelled_count,
              COUNT(*) FILTER (WHERE outcome = 'refusal') AS refusal_count,
              CASE WHEN COUNT(input_tokens) = 0 THEN NULL ELSE SUM(input_tokens) END AS input_tokens,
              CASE WHEN COUNT(cache_read_input_tokens) = 0 THEN NULL ELSE SUM(cache_read_input_tokens) END AS cache_read_input_tokens,
              CASE WHEN COUNT(cache_write_input_tokens) = 0 THEN NULL ELSE SUM(cache_write_input_tokens) END AS cache_write_input_tokens,
              CASE WHEN COUNT(output_tokens) = 0 THEN NULL ELSE SUM(output_tokens) END AS output_tokens,
              CASE WHEN COUNT(reasoning_output_tokens) = 0 THEN NULL ELSE SUM(reasoning_output_tokens) END AS reasoning_output_tokens,
              CASE WHEN COUNT(cost_usd) = 0 THEN NULL ELSE SUM(cost_usd) END AS total_known_cost_usd,
              COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unavailable_cost_count,
              CASE WHEN COUNT(cache_read_input_tokens) = 0 THEN NULL
                   ELSE COUNT(*) FILTER (WHERE cache_read_input_tokens > 0)::double precision
                        / COUNT(cache_read_input_tokens) END AS cache_hit_rate,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
                FILTER (WHERE duration_ms IS NOT NULL) AS median_duration_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)
                FILTER (WHERE cost_usd IS NOT NULL) AS median_cost_usd,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY cost_usd)
                FILTER (WHERE cost_usd IS NOT NULL) AS p95_cost_usd,
              COUNT(*) FILTER (WHERE cost_source = 'provider_reported') AS provider_reported_cost_count,
              COUNT(*) FILTER (WHERE cost_source = 'platform_estimate') AS platform_estimate_cost_count,
              COUNT(*) FILTER (WHERE cost_source = 'catalog_estimate') AS catalog_estimate_cost_count
         FROM normalized
        WHERE occurred_at >= NOW() - ($2::text || ' days')::interval
        GROUP BY provider, backend, component, requested_model, served_model, billing_path
     )
     SELECT * FROM grouped
      ORDER BY provider, backend, component, requested_model NULLS LAST, served_model NULLS LAST, billing_path`,
    [EVENT_TYPE, String(boundedDays)],
  );

  const generatedAt = new Date();
  return {
    timeframe: {
      days: boundedDays,
      from: new Date(generatedAt.getTime() - boundedDays * 86_400_000).toISOString(),
      to: generatedAt.toISOString(),
    },
    definitions: {
      cacheHitRate: 'invocations with cache-read tokens > 0 divided by invocations where cache-read usage is available',
      knownCost: 'provider-reported or explicitly labelled platform/catalog estimate; see costSourceCounts',
      openrouterCost: 'catalog estimate from the pinned model-pricing snapshot; never provider-exact',
    },
    groups: rows.map((row) => ({
      provider: row.provider,
      backend: row.backend,
      component: row.component,
      requestedModel: row.requested_model,
      servedModel: row.served_model,
      billingPath: row.billing_path,
      invocationCount: count(row.invocation_count),
      successCount: count(row.success_count),
      errorCount: count(row.error_count),
      cancelledCount: count(row.cancelled_count),
      refusalCount: count(row.refusal_count),
      tokens: {
        input: nullableNumber(row.input_tokens),
        cacheReadInput: nullableNumber(row.cache_read_input_tokens),
        cacheWriteInput: nullableNumber(row.cache_write_input_tokens),
        output: nullableNumber(row.output_tokens),
        reasoningOutput: nullableNumber(row.reasoning_output_tokens),
      },
      totalKnownCostUsd: nullableNumber(row.total_known_cost_usd),
      unavailableCostCount: count(row.unavailable_cost_count),
      cacheHitRate: nullableNumber(row.cache_hit_rate),
      durationMs: {
        median: nullableNumber(row.median_duration_ms),
        p95: nullableNumber(row.p95_duration_ms),
      },
      knownCostUsd: {
        median: nullableNumber(row.median_cost_usd),
        p95: nullableNumber(row.p95_cost_usd),
      },
      costSourceCounts: {
        providerReported: count(row.provider_reported_cost_count),
        platformEstimate: count(row.platform_estimate_cost_count),
        catalogEstimate: count(row.catalog_estimate_cost_count),
        unavailable: count(row.unavailable_cost_count),
      },
    })),
  };
}

function _setEnabledForTests(value) {
  const previous = enabled;
  enabled = !!value;
  return previous;
}

function _setSinkForTests(sink) {
  const previous = testSink;
  testSink = sink;
  return previous;
}

// Callers that must persist recovery context can use the same strict
// component vocabulary and collection switch as event writes. A disabled
// collector returns null so no new telemetry-only metadata is attached to
// otherwise-required billing/recovery rows.
function collectionComponent(value, fallback = null) {
  if (!enabled) return null;
  if (COMPONENTS.has(value)) return value;
  return COMPONENTS.has(fallback) ? fallback : null;
}

module.exports = {
  EVENT_TYPE,
  MAX_REPORT_DAYS,
  init,
  record,
  aggregateReport,
  normalizeEvent,
  collectionComponent,
  _setEnabledForTests,
  _setSinkForTests,
};

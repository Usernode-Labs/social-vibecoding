'use strict';

const crypto = require('crypto');
const openrouterClient = require('../openrouter-client');
const profileService = require('./profile');
const globalChatOpenRouter = require('./openrouter');

const ADVISORY_LOCK_NAMESPACE = 2377;
const OUTCOMES = new Set(['success', 'error', 'cancelled', 'refusal', 'unknown']);
const ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

class GlobalChatBudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GlobalChatBudgetError';
    this.code = code;
    this.details = details;
  }
}

function decimal(value, { nullable = false } = {}) {
  if (value == null) {
    if (nullable) return null;
    throw new GlobalChatBudgetError('cost_unavailable', 'Cost estimate is unavailable');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new GlobalChatBudgetError('invalid_cost', 'Cost must be nonnegative');
    }
    return profileService.money(value.toFixed(8));
  }
  return profileService.money(value, { nullable });
}

function units(value) {
  const normalized = decimal(value);
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
}

function fromUnits(value) {
  const whole = value / 100000000n;
  const fraction = String(value % 100000000n).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function ceilMoney(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return fromUnits(BigInt(Math.ceil(value * 100000000)));
}

function requestBytes({ messages = [], tools = [] } = {}) {
  try {
    return Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8');
  } catch {
    throw new GlobalChatBudgetError('invalid_request', 'Model request is not serializable');
  }
}

function estimateInvocationCost({
  model,
  messages,
  tools,
  maxOutputTokens = globalChatOpenRouter.DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const inputPrice = Number(model?.inputPricePerMillion);
  const outputPrice = Number(model?.outputPricePerMillion);
  if (!Number.isFinite(inputPrice) || inputPrice < 0
      || !Number.isFinite(outputPrice) || outputPrice < 0) {
    return {
      costUsd: null,
      estimatedInputTokens: null,
      maxOutputTokens,
    };
  }
  // UTF-8 bytes are a conservative tokenizer-independent upper bound for
  // ordinary text/tool JSON. Completion cost reserves the configured maximum,
  // so concurrent turns cannot both pass a small cap and overspend it.
  const estimatedInputTokens = requestBytes({ messages, tools });
  const rawCost = ((estimatedInputTokens * inputPrice)
    + (maxOutputTokens * outputPrice)) / 1_000_000;
  return {
    costUsd: ceilMoney(rawCost),
    estimatedInputTokens,
    maxOutputTokens,
  };
}

function costFromUsage(model, usage = {}) {
  const inputPrice = Number(model?.inputPricePerMillion);
  const outputPrice = Number(model?.outputPricePerMillion);
  if (!Number.isFinite(inputPrice) || inputPrice < 0
      || !Number.isFinite(outputPrice) || outputPrice < 0) return null;
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    return null;
  }
  return ceilMoney(((input * inputPrice) + (output * outputPrice)) / 1_000_000);
}

function assertOverallAllowance(overallRemainingUsd, estimatedCostUsd) {
  if (overallRemainingUsd == null) return;
  const remaining = decimal(overallRemainingUsd);
  if (estimatedCostUsd == null) {
    if (units(remaining) === 0n) {
      throw new GlobalChatBudgetError(
        'overall_allowance_exhausted',
        'The shared OpenRouter allowance is exhausted.',
        { remainingUsd: remaining },
      );
    }
    return;
  }
  if (units(estimatedCostUsd) > units(remaining)) {
    throw new GlobalChatBudgetError(
      'overall_allowance_exhausted',
      'The shared OpenRouter allowance is too low for another Global Chat turn.',
      { remainingUsd: remaining, requiredUsd: estimatedCostUsd },
    );
  }
}

async function reserveInvocation(pool, {
  userId,
  threadId = null,
  messageId = null,
  requestedModel,
  reasoningEffort,
  attemptNumber = 1,
  spendCapUsd = null,
  estimatedCostUsd,
  estimatedInputTokens = null,
  maxOutputTokens = null,
  overallRemainingUsd = null,
  now = new Date(),
}) {
  const estimate = decimal(estimatedCostUsd, { nullable: true });
  assertOverallAllowance(overallRemainingUsd, estimate);
  const client = await pool.connect();
  const id = crypto.randomUUID();
  const { start, reset } = profileService.utcMonthBounds(now);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      ADVISORY_LOCK_NAMESPACE,
      Number(userId),
    ]);
    const profileResult = await client.query(
      `SELECT spend_cap_usd::text AS spend_cap_usd
         FROM global_chat_profiles
        WHERE user_id = $1
        FOR UPDATE`,
      [userId],
    );
    const effectiveCap = profileResult.rows[0]
      ? decimal(profileResult.rows[0].spend_cap_usd, { nullable: true })
      : decimal(spendCapUsd, { nullable: true });
    const spentResult = await client.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS spent_usd
         FROM global_chat_usage
        WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [userId, start, reset],
    );
    const spent = decimal(spentResult.rows[0]?.spent_usd || '0');
    if (effectiveCap != null && estimate == null) {
      throw new GlobalChatBudgetError(
        'cost_unavailable',
        'This model has no usable price data, so the Global Chat cap cannot be enforced.',
      );
    }
    if (effectiveCap != null && units(spent) + units(estimate) > units(effectiveCap)) {
      throw new GlobalChatBudgetError(
        'global_chat_cap_exceeded',
        'This turn would exceed the Global Chat monthly cap.',
        {
          spentUsd: spent,
          capUsd: effectiveCap,
          requiredUsd: estimate,
          resetAt: reset.toISOString(),
        },
      );
    }

    await client.query(
      `INSERT INTO global_chat_usage
        (id, user_id, thread_id, message_id, requested_model,
         reasoning_effort, cost_usd, cost_source, outcome, attempt_number,
         metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unknown', $9, $10::jsonb, $11)`,
      [
        id,
        userId,
        threadId,
        messageId,
        profileService.modelId(requestedModel),
        profileService.reasoningEffort(reasoningEffort),
        estimate,
        estimate == null ? 'unavailable' : 'catalog_estimate',
        attemptNumber,
        JSON.stringify({ estimated_input_tokens: estimatedInputTokens, max_output_tokens: maxOutputTokens }),
        now,
      ],
    );
    await client.query('COMMIT');
    return {
      id,
      userId,
      estimatedCostUsd: estimate,
      spentBeforeUsd: spent,
      capUsd: effectiveCap,
      resetAt: reset.toISOString(),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function count(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
}

function optionalCount(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
}

async function settleInvocation(pool, reservation, {
  servedModel = null,
  routedProvider = null,
  usage = {},
  costUsd = null,
  costSource = 'unavailable',
  outcome = 'unknown',
  toolCalls = 0,
  durationMs = null,
  errorCode = null,
  generationId = null,
  providerTimings = null,
}) {
  if (!reservation?.id) throw new Error('global-chat accounting: reservation required');
  if (!OUTCOMES.has(outcome)) throw new Error('global-chat accounting: invalid outcome');
  const finalCost = decimal(costUsd, { nullable: true });
  const finalSource = finalCost == null ? 'unavailable' : costSource;
  if (!['provider_reported', 'catalog_estimate', 'unavailable'].includes(finalSource)) {
    throw new Error('global-chat accounting: invalid cost source');
  }
  const safeError = errorCode && ERROR_CODE_RE.test(errorCode) ? errorCode : null;
  const duration = durationMs == null ? null : Math.max(0, Math.round(Number(durationMs) || 0));
  const providerDuration = optionalCount(providerTimings?.durationMs);
  const firstOutput = optionalCount(providerTimings?.firstByteMs);
  const dispatchSetup = optionalCount(providerTimings?.dispatchSetupMs);
  const metadata = {
    ...(routedProvider ? { routed_provider: String(routedProvider).slice(0, 128) } : {}),
    ...(generationId && /^[A-Za-z0-9._:-]{1,180}$/.test(generationId)
      ? { generation_id: generationId }
      : {}),
    ...(providerDuration == null ? {} : { provider_duration_ms: providerDuration }),
    ...(firstOutput == null ? {} : { time_to_first_output_ms: firstOutput }),
    ...(dispatchSetup == null ? {} : { dispatch_setup_duration_ms: dispatchSetup }),
  };
  const { rows } = await pool.query(
    `UPDATE global_chat_usage
        SET served_model = $3,
            input_tokens = $4,
            cached_input_tokens = $5,
            output_tokens = $6,
            reasoning_tokens = $7,
            cost_usd = COALESCE($8, cost_usd),
            cost_source = CASE WHEN $8 IS NULL THEN cost_source ELSE $9 END,
            outcome = $10,
            tool_calls = $11,
            error_code = $12,
            duration_ms = $13,
            metadata = metadata || $14::jsonb
      WHERE id = $1 AND user_id = $2
      RETURNING id, cost_usd::text AS cost_usd, cost_source, outcome`,
    [
      reservation.id,
      reservation.userId,
      servedModel ? profileService.modelId(servedModel, 'served model') : null,
      count(usage.inputTokens),
      count(usage.cachedInputTokens),
      count(usage.outputTokens),
      count(usage.reasoningTokens),
      finalCost,
      finalSource,
      outcome,
      count(toolCalls),
      safeError,
      duration,
      JSON.stringify(metadata),
    ],
  );
  return rows[0] || null;
}

async function releaseReservation(pool, reservation) {
  if (!reservation?.id) return false;
  const result = await pool.query(
    `DELETE FROM global_chat_usage
      WHERE id = $1 AND user_id = $2 AND outcome = 'unknown'`,
    [reservation.id, reservation.userId],
  );
  return result.rowCount === 1;
}

async function recordTurnOutcome(pool, {
  userId,
  threadId,
  messageId,
  outcome,
  errorCode = null,
  durationMs,
  invocationCount,
  resultCount,
}) {
  if (!['success', 'error', 'cancelled'].includes(outcome)) {
    throw new Error('global-chat accounting: invalid turn outcome');
  }
  const safeError = errorCode && ERROR_CODE_RE.test(errorCode) ? errorCode : null;
  const metadata = {
    turn_outcome: outcome,
    turn_duration_ms: count(durationMs),
    turn_invocation_count: count(invocationCount),
    turn_result_count: count(resultCount),
    ...(safeError ? { turn_error_code: safeError } : {}),
  };
  const result = await pool.query(
    `WITH latest AS (
       SELECT id
         FROM global_chat_usage
        WHERE user_id = $1 AND thread_id = $2 AND message_id = $3
        ORDER BY created_at DESC
        LIMIT 1
     )
     UPDATE global_chat_usage g
        SET metadata = g.metadata || $4::jsonb
       FROM latest
      WHERE g.id = latest.id`,
    [userId, threadId, messageId, JSON.stringify(metadata)],
  );
  return result.rowCount === 1;
}

async function invokeAccounted({
  pool,
  config,
  apiKey,
  userId,
  threadId,
  messageId = null,
  model,
  reasoningEffort,
  spendCapUsd = null,
  attemptNumber = 1,
  messages,
  tools,
  sessionId,
  maxOutputTokens = globalChatOpenRouter.DEFAULT_MAX_OUTPUT_TOKENS,
  temperature = 0.1,
  parallelToolCalls = true,
  toolChoice = 'auto',
  timeoutMs = globalChatOpenRouter.DEFAULT_TIMEOUT_MS,
  signal,
  onContent,
  providerAllowance,
  validateKey = openrouterClient.validateKey,
  streamChat = globalChatOpenRouter.streamChat,
  now = new Date(),
}) {
  const started = Date.now();
  // The route validates the key and allowance once while building the turn
  // runtime. Reusing that snapshot avoids another provider round-trip for
  // every planning/tool iteration. Direct callers retain the safe fallback.
  const allowance = providerAllowance === undefined
    ? await validateKey(apiKey, {
      baseUrl: config.openrouterApiBase,
      origin: config.openrouterOrigin,
    })
    : providerAllowance;
  const estimate = estimateInvocationCost({
    model,
    messages,
    tools,
    maxOutputTokens,
  });
  const reserved = await reserveInvocation(pool, {
    userId,
    threadId,
    messageId,
    requestedModel: model.id,
    reasoningEffort,
    attemptNumber,
    spendCapUsd,
    estimatedCostUsd: estimate.costUsd,
    estimatedInputTokens: estimate.estimatedInputTokens,
    maxOutputTokens,
    overallRemainingUsd: allowance.limitRemaining,
    now,
  });
  const reservation = reserved;
  const dispatchSetupMs = Math.max(0, Date.now() - started);
  try {
    const result = await streamChat({
      apiKey,
      baseUrl: config.openrouterApiBase,
      origin: config.openrouterOrigin,
      model: model.id,
      reasoning: reasoningEffort,
      messages,
      tools,
      sessionId,
      maxOutputTokens,
      temperature,
      parallelToolCalls,
      toolChoice,
      timeoutMs,
      signal,
      onContent,
    });
    const providerCost = result.usage.costUsd == null
      ? null
      : decimal(result.usage.costUsd);
    const catalogCost = providerCost == null ? costFromUsage(model, result.usage) : null;
    await settleInvocation(pool, reservation, {
      servedModel: result.servedModel,
      routedProvider: result.provider,
      usage: result.usage,
      costUsd: providerCost ?? catalogCost,
      costSource: providerCost == null ? 'catalog_estimate' : 'provider_reported',
      outcome: 'success',
      toolCalls: result.toolCalls.length,
      durationMs: Date.now() - started,
      generationId: result.generationId,
      providerTimings: { ...result.timings, dispatchSetupMs },
    });
    return { ...result, reservationId: reservation.id };
  } catch (err) {
    if (err?.dispatched === false) {
      await releaseReservation(pool, reservation).catch(() => {});
    } else {
      await settleInvocation(pool, reservation, {
        outcome: err?.code === 'cancelled' ? 'cancelled' : 'error',
        durationMs: Date.now() - started,
        errorCode: ERROR_CODE_RE.test(err?.code || '') ? err.code : 'provider_error',
        routedProvider: err?.provider,
        generationId: err?.generationId,
        providerTimings: { ...err?.timings, dispatchSetupMs },
      }).catch(() => {});
    }
    throw err;
  }
}

module.exports = {
  GlobalChatBudgetError,
  estimateInvocationCost,
  costFromUsage,
  assertOverallAllowance,
  reserveInvocation,
  settleInvocation,
  releaseReservation,
  recordTurnOutcome,
  invokeAccounted,
};

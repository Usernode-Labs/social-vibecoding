'use strict';

// One ledger for the company-funded security service, across every run and
// both model roles. This module never reads/provisions an inference key and
// never touches the general per-user key policy.
const runs = require('./runs');
const settings = require('./settings');
const { SECURITY_BOT_BUDGET_LOCK } = require('../advisory-locks');

const PRICE_SCALE = 12;
const MONEY_SCALE = 4; // Match the existing NUMERIC(10,4) columns; round UP.
const MAX_QUOTE_SECONDS = 300;
const PRICE_KEYS = new Set(['prompt', 'completion', 'request', 'internal_reasoning',
  'input_cache_read', 'input_cache_write']);
const OUTCOMES = new Set(['ok', 'error', 'cancelled']);
const ERROR_CODES = new Set(['provider_error', 'provider_timeout', 'cancelled',
  'usage_unavailable', 'not_dispatched', 'pricing_bound_exceeded']);

class BudgetError extends Error {
  constructor(code) {
    super(`Security bot accounting: ${code}`);
    this.name = 'SecurityBotBudgetError';
    this.code = code;
  }
}

function fail(code) { throw new BudgetError(code); }

// Exact decimal arithmetic, including exponent-form provider numbers. Neither
// floating point addition nor PostgreSQL's nearest rounding admits a call.
function atoms(value, scale = MONEY_SCALE) {
  if (!['number', 'string'].includes(typeof value)) fail('pricing_unbounded');
  const match = /^(\d{1,10})(?:\.(\d{1,18}))?(?:e([+-]?\d{1,2}))?$/i.exec(String(value));
  if (!match) fail('pricing_unbounded');
  const coefficient = BigInt(match[1] + (match[2] || ''));
  const power = scale + Number(match[3] || 0) - (match[2] || '').length;
  if (power >= 0) return coefficient * 10n ** BigInt(power);
  const divisor = 10n ** BigInt(-power);
  return (coefficient + divisor - 1n) / divisor;
}

function money(value) {
  if (value < 0n || value > 9_999_999_999n) fail('cost_out_of_range');
  return `${value / 10_000n}.${String(value % 10_000n).padStart(4, '0')}`;
}

function count(value, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('invalid_token_bound');
  return value;
}

/**
 * The trusted gateway supplies a fresh provider quote, NOT the catalogue's
 * cheapest model price: { model, provider, validUntil, upperBound: true,
 * pricing: { prompt, completion, request, ... } }. Prices are USD per token
 * or request, as in OpenRouter's provider endpoint API. upperBound asserts
 * that routing is pinned, token ceilings are enforced, and every applicable
 * tier/override/fee has been included. Raw conditional/multimodal prices are
 * deliberately refused. No request content or provider payload is stored.
 *
 * outputTokens INCLUDES reasoning. Use the highest completion/reasoning
 * rate for the whole bound; cache writes/reads cannot lower the input bound.
 */
function estimateInvocation({ quote, promptTokens, outputTokens }) {
  if (quote?.upperBound !== true || !quote?.pricing || Array.isArray(quote.pricing)) fail('pricing_unbounded');
  runs.identifier(quote.model);
  runs.identifier(quote.provider);
  const validUntil = new Date(quote.validUntil);
  if (!quote.validUntil || !Number.isFinite(validUntil.getTime())) fail('pricing_unbounded');
  const prices = {};
  for (const [key, value] of Object.entries(quote.pricing)) {
    const amount = atoms(value, PRICE_SCALE);
    if (!PRICE_KEYS.has(key) && amount !== 0n) fail('pricing_unbounded');
    if (PRICE_KEYS.has(key)) prices[key] = amount;
  }
  if (['prompt', 'completion', 'request'].some((key) => prices[key] === undefined)) fail('pricing_unbounded');
  const input = count(promptTokens);
  const output = count(outputTokens, 16384);
  if (!input || !output) fail('invalid_token_bound');
  const maximum = (values) => values.reduce((a, b) => a > b ? a : b);
  // A cache-creation fee can be additive at a provider, so allow it on top
  // of the highest input/read rate rather than assuming a discount.
  const inputRate = maximum([prices.prompt, prices.input_cache_read || 0n]) + (prices.input_cache_write || 0n);
  const outputRate = maximum([prices.completion, prices.internal_reasoning || 0n]);
  const total = BigInt(input) * inputRate + BigInt(output) * outputRate + prices.request;
  const divisor = 10n ** BigInt(PRICE_SCALE - MONEY_SCALE);
  // Keep a minimum one ledger unit even for a quoted free invocation: an
  // explicit finite bound is still required, and rounding is conservative.
  const bound = (total + divisor - 1n) / divisor || 1n;
  return {
    reservedUsd: money(bound), promptTokens: input, outputTokens: output,
    model: quote.model, provider: quote.provider, validUntil: validUntil.toISOString(),
    pricing: Object.fromEntries(Object.entries(prices).map(([key, value]) => [key, String(value)])),
  };
}

async function budgetLock(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [SECURITY_BOT_BUDGET_LOCK]);
}

async function dayAndWeek(client) {
  return (await client.query(
    `SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day,
       date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS week`,
  )).rows[0];
}

async function totals(client, day, week) {
  const { rows: [row] } = await client.query(
    `SELECT
       COALESCE(SUM(spent_usd + reserved_usd) FILTER (WHERE day = $1::date), 0)::text AS daily_usd,
       (COALESCE(SUM(spent_usd) FILTER (WHERE day >= $2::date), 0)
         + COALESCE(SUM(reserved_usd), 0))::text AS weekly_usd
     FROM security_bot_daily_budgets`, [day, week],
  );
  return row;
}

// Read-only: safe to show while disabled, and never creates a ledger row.
async function getBudget(pool) {
  const clock = await dayAndWeek(pool);
  return { ...clock, ...await totals(pool, clock.day, clock.week) };
}

async function reserveInvocation(pool, lease, {
  idempotencyKey, logicalCallKey, role, attempt = 1, quote,
  promptTokens, outputTokens, credentialRevision,
}) {
  runs.identifier(idempotencyKey);
  runs.identifier(logicalCallKey);
  // An opaque revision/hash reference, never the key itself.
  if (typeof credentialRevision !== 'string' || !/^[a-f0-9]{16,64}$/.test(credentialRevision)) fail('invalid_credential_revision');
  if (!['attacker', 'defender'].includes(role)) fail('invalid_role');
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) fail('retry_exhausted');
  const estimate = estimateInvocation({ quote, promptTokens, outputTokens });
  return runs.transaction(pool, async (client) => {
    await budgetLock(client);
    const run = await runs.lockLease(client, lease);
    const s = await settings.read(client);
    if (!s.enabled) fail('service_disabled');
    if (outputTokens > run.limits_snapshot.max_output_tokens) fail('output_limit_exceeded');
    const { rows: existing } = await client.query(
      `SELECT * FROM security_bot_model_calls WHERE idempotency_key = $1
         OR (run_id = $2 AND role = $3 AND logical_call_key = $4 AND attempt = $5)`,
      [idempotencyKey, run.id, role, logicalCallKey, attempt],
    );
    if (existing.length) {
      const call = existing[0];
      if (existing.length !== 1 || call.idempotency_key !== idempotencyKey || call.run_id !== run.id
          || call.role !== role || call.logical_call_key !== logicalCallKey || call.attempt !== attempt
          || call.model !== estimate.model || call.provider !== estimate.provider
          || call.max_prompt_tokens !== promptTokens || call.max_output_tokens !== outputTokens
          || call.credential_revision !== credentialRevision) fail('idempotency_conflict');
      // An existing reservation is NEVER permission to dispatch again, even
      // after a restart or with a new lease. Reconcile it instead.
      return { admitted: false, reason: 'already_reserved', call };
    }
    const { rows: [fresh] } = await client.query(
      `SELECT $1::timestamptz > clock_timestamp()
         AND $1::timestamptz <= clock_timestamp() + $2 * interval '1 second' AS valid`,
      [estimate.validUntil, MAX_QUOTE_SECONDS],
    );
    if (!fresh.valid) fail('pricing_expired');
    if (attempt > 1) {
      const prior = (await client.query(
        `SELECT * FROM security_bot_model_calls WHERE run_id = $1 AND role = $2
           AND logical_call_key = $3 AND attempt = $4`, [run.id, role, logicalCallKey, attempt - 1],
      )).rows[0];
      if (!prior || !prior.dispatched_at || prior.outcome === 'ok' || prior.outcome === 'skipped-budget') fail('invalid_retry');
    }
    const clock = await dayAndWeek(client);
    // An admitted call overran a previously asserted upper bound, or a
    // legacy call cannot be assigned to a day: fail closed pending review.
    const { rows: uncertain } = await client.query(
      `SELECT id FROM security_bot_model_calls WHERE cost_usd > reserved_usd OR error_code = 'pricing_bound_exceeded'
         OR (budget_day IS NULL AND reserved_usd > 0 AND cost_usd IS NULL) LIMIT 1`,
    );
    if (uncertain.length) fail('accounting_uncertain');
    const spent = await totals(client, clock.day, clock.week);
    const bound = atoms(estimate.reservedUsd);
    const dailyCap = atoms(Math.min(s.daily_budget_usd, run.limits_snapshot.daily_budget_usd));
    const weeklyCap = atoms(Math.min(s.weekly_budget_usd, run.limits_snapshot.weekly_budget_usd));
    const { rows: [tokens] } = await client.query(
      `SELECT COALESCE(SUM(COALESCE(prompt_tokens, max_prompt_tokens, 0)
         + COALESCE(output_tokens, max_output_tokens, 0)), 0)::text AS total
       FROM security_bot_model_calls WHERE run_id = $1 AND outcome <> 'skipped-budget'`, [run.id],
    );
    let reason = null;
    if (atoms(spent.daily_usd) + bound > dailyCap) reason = 'daily_budget_exhausted';
    else if (atoms(spent.weekly_usd) + bound > weeklyCap) reason = 'weekly_budget_exhausted';
    else if (Number(tokens.total) + promptTokens + outputTokens > runs.EXTRA_LIMITS.max_total_tokens) reason = 'tokens_exhausted';
    else if ((role === 'attacker' ? run.attacker_calls : run.defender_calls)
      >= (role === 'attacker' ? run.limits_snapshot.max_attacker_calls : runs.EXTRA_LIMITS.max_defender_calls)) reason = 'calls_exhausted';
    const { rows: [call] } = await client.query(
      `INSERT INTO security_bot_model_calls
         (run_id, role, attempt, reserved_usd, outcome, idempotency_key,
          budget_day, lease_generation, logical_call_key, model, provider,
          credential_revision, max_prompt_tokens, max_output_tokens, pricing_snapshot,
          pricing_valid_until, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
       RETURNING *`,
      [run.id, role, attempt, reason ? '0.0000' : estimate.reservedUsd,
        reason ? 'skipped-budget' : 'unreconciled', idempotencyKey,
        clock.day, lease.generation, logicalCallKey, estimate.model, estimate.provider,
        credentialRevision, promptTokens, outputTokens,
        JSON.stringify({ scale: PRICE_SCALE, rates: estimate.pricing }), estimate.validUntil, reason],
    );
    if (reason) return { admitted: false, reason, call };
    await client.query(
      `INSERT INTO security_bot_daily_budgets (day, reserved_usd) VALUES ($1, $2)
       ON CONFLICT (day) DO UPDATE SET reserved_usd = security_bot_daily_budgets.reserved_usd + EXCLUDED.reserved_usd,
         updated_at = clock_timestamp()`, [clock.day, estimate.reservedUsd],
    );
    await client.query(
      `UPDATE security_bot_runs SET
         attacker_calls = attacker_calls + CASE WHEN $3 = 'attacker' THEN 1 ELSE 0 END,
         defender_calls = defender_calls + CASE WHEN $3 = 'defender' THEN 1 ELSE 0 END
       WHERE id = $1 AND lease_generation = $2`, [run.id, lease.generation, role],
    );
    await runs.lockLease(client, lease);
    return { admitted: true, call };
  });
}

async function lockCall(client, runId, callId) {
  const { rows } = await client.query(
    'SELECT * FROM security_bot_model_calls WHERE id = $1 AND run_id = $2 FOR UPDATE', [callId, runId],
  );
  if (!rows.length) fail('call_not_found');
  return rows[0];
}

// Commit the dispatch marker BEFORE handing control to a transport. A crash
// between those steps is ambiguous and remains reserved; never replay it.
async function markDispatched(pool, lease, callId) {
  return runs.transaction(pool, async (client) => {
    await budgetLock(client);
    const run = await runs.lockLease(client, lease);
    const s = await settings.read(client);
    if (!s.enabled) fail('service_disabled');
    const clock = await dayAndWeek(client);
    const committed = await totals(client, clock.day, clock.week);
    if (atoms(committed.daily_usd) > atoms(Math.min(s.daily_budget_usd, run.limits_snapshot.daily_budget_usd))
        || atoms(committed.weekly_usd) > atoms(Math.min(s.weekly_budget_usd, run.limits_snapshot.weekly_budget_usd))) fail('budget_changed');
    const { rows: uncertain } = await client.query(
      "SELECT id FROM security_bot_model_calls WHERE error_code = 'pricing_bound_exceeded' LIMIT 1",
    );
    if (uncertain.length) fail('accounting_uncertain');
    const { rows } = await client.query(
      `UPDATE security_bot_model_calls SET dispatched_at = clock_timestamp()
       WHERE id = $1 AND run_id = $2 AND lease_generation = $3
         AND outcome = 'unreconciled' AND cost_usd IS NULL AND dispatched_at IS NULL
         AND budget_day = (clock_timestamp() AT TIME ZONE 'UTC')::date
         AND pricing_valid_until > clock_timestamp() RETURNING *`,
      [callId, lease.runId, lease.generation],
    );
    if (!rows.length) fail('dispatch_not_admitted');
    await runs.lockLease(client, lease);
    return rows[0];
  });
}

function usageCounts(usage) {
  if (usage == null) return { prompt: null, output: null, reasoning: null };
  // Completion usage includes reasoning; do not add it a second time.
  const prompt = count(usage.promptTokens, 100_000_000);
  const output = count(usage.outputTokens, 100_000_000);
  const reasoning = usage.reasoningTokens == null ? null : count(usage.reasoningTokens, output);
  return { prompt, output, reasoning };
}

async function settle(client, lease, call, { costUsd, outcome = 'ok', usage, generationId, errorCode }) {
  if (!OUTCOMES.has(outcome)) fail('invalid_outcome');
  if (generationId !== undefined) runs.identifier(generationId);
  if (errorCode !== undefined && !ERROR_CODES.has(errorCode)) fail('invalid_error_code');
  if (call.outcome === 'skipped-budget') fail('call_not_admitted');
  if (call.generation_id && generationId && call.generation_id !== generationId) fail('generation_conflict');
  if (costUsd == null) {
    if (call.cost_usd != null) return call;
    // Unknown usage is NOT a zero-dollar error/cancellation. No hold moves.
    return (await client.query(
      `UPDATE security_bot_model_calls SET outcome = 'unreconciled',
         generation_id = COALESCE($3, generation_id), error_code = $4
       WHERE id = $1 AND run_id = $2 AND cost_usd IS NULL RETURNING *`,
      [call.id, lease.runId, generationId || null, errorCode || 'usage_unavailable'],
    )).rows[0];
  }
  const cost = atoms(costUsd);
  const normalized = money(cost);
  const counts = usageCounts(usage);
  if (call.cost_usd != null) {
    if (atoms(call.cost_usd) !== cost || call.outcome !== outcome) fail('settlement_conflict');
    return call;
  }
  if (!call.dispatched_at && (cost !== 0n || outcome !== 'cancelled')) fail('dispatch_not_recorded');
  const exceeded = cost > atoms(call.reserved_usd)
    || (counts.prompt != null && counts.prompt > call.max_prompt_tokens)
    || (counts.output != null && counts.output > call.max_output_tokens);
  const { rows: [settled] } = await client.query(
    `UPDATE security_bot_model_calls SET cost_usd = $3, cost_source = 'provider_reported',
       outcome = $4, settled_at = clock_timestamp(), generation_id = COALESCE($5, generation_id),
       prompt_tokens = $6, output_tokens = $7, reasoning_tokens = $8, error_code = $9
     WHERE id = $1 AND run_id = $2 AND cost_usd IS NULL RETURNING *`,
    [call.id, lease.runId, normalized, outcome, generationId || null,
      counts.prompt, counts.output, counts.reasoning, exceeded ? 'pricing_bound_exceeded' : errorCode || null],
  );
  const { rowCount } = await client.query(
    `UPDATE security_bot_daily_budgets SET reserved_usd = reserved_usd - $2,
       spent_usd = spent_usd + $3, released_usd = released_usd + GREATEST(0, $2::numeric - $3::numeric),
       updated_at = clock_timestamp() WHERE day = $1 AND reserved_usd >= $2`,
    [call.budget_day, call.reserved_usd, normalized],
  );
  if (!rowCount) fail('ledger_inconsistent');
  await client.query(
    `UPDATE security_bot_runs SET spend_usd = spend_usd + $3
     WHERE id = $1 AND lease_generation = $2`, [lease.runId, lease.generation, normalized],
  );
  return settled;
}

async function settleInvocation(pool, lease, callId, result) {
  return runs.transaction(pool, async (client) => {
    await budgetLock(client);
    await runs.lockLease(client, lease);
    const call = await lockCall(client, lease.runId, callId);
    if (call.lease_generation !== lease.generation) fail('call_attempt_fenced');
    const settled = await settle(client, lease, call, result);
    await runs.lockLease(client, lease);
    return settled;
  });
}

// Trusted reconciliation, under the CURRENT campaign generation. This can
// reconcile a fenced attempt after cancellation/restart, but the old worker
// cannot. Provider-reported costs settle against the ORIGINAL reservation day.
// A never-dispatched reservation can be released with a proven zero charge.
async function reconcileInvocation(pool, lease, callId, result) {
  return runs.transaction(pool, async (client) => {
    await budgetLock(client);
    await runs.lockLease(client, lease, { allowStopped: true });
    const settled = await settle(client, lease, await lockCall(client, lease.runId, callId), result);
    await runs.lockLease(client, lease, { allowStopped: true });
    return settled;
  });
}

/**
 * Exactly ONE physical transport call per admission. Automatic provider
 * retries/fallbacks must be off; a retry calls this again with attempt+1 and
 * its own idempotency key, so even ambiguous prior costs remain charged.
 * The transport owns credential decryption and receives no stored secret.
 */
async function invokeAccounted(pool, lease, request, dispatch, { signal } = {}) {
  if (typeof dispatch !== 'function') fail('transport_required');
  const admission = await reserveInvocation(pool, lease, request);
  if (!admission.admitted) return admission;
  if (signal?.aborted) {
    await settleInvocation(pool, lease, admission.call.id, { costUsd: '0', outcome: 'cancelled' });
    return { admitted: false, reason: 'cancelled', call: admission.call };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  // Close the gap if the caller aborted between the first check and adding
  // the listener, before any transport is invoked.
  if (signal?.aborted) controller.abort();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await runs.assertCanDispatch(pool, lease); }
    catch { controller.abort(); }
    finally { checking = false; }
  }, 250);
  timer.unref();
  try {
    await markDispatched(pool, lease, admission.call.id);
    await runs.assertCanDispatch(pool, lease);
    if (controller.signal.aborted) fail('cancelled');
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(new BudgetError('cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let response;
    try {
      response = await Promise.race([dispatch({ call: admission.call, signal: controller.signal }), aborted]);
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
    const call = await settleInvocation(pool, lease, admission.call.id, {
      costUsd: response.costUsd, usage: response.usage, generationId: response.generationId,
    });
    return { admitted: true, call, result: response.result };
  } catch (err) {
    // A transport error/timeout/abort is ambiguous. Preserve the full hold.
    // If the lease was fenced, the current controller will reconcile it.
    await settleInvocation(pool, lease, admission.call.id, {
      costUsd: null, errorCode: controller.signal.aborted ? 'cancelled' : 'provider_error',
    }).catch(() => {});
    throw err;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = {
  BudgetError, MAX_QUOTE_SECONDS, estimateInvocation, getBudget,
  reserveInvocation, markDispatched, settleInvocation, reconcileInvocation, invokeAccounted,
};

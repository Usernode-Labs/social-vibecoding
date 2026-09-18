'use strict';

const agentModels = require('../agent-models');
const {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
} = require('./prompt');

const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_SET = new Set(REASONING_EFFORTS);
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MONEY_RE = /^(0|[1-9]\d{0,9})(?:\.(\d{1,8}))?$/;

class GlobalChatProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GlobalChatProfileError';
    this.code = code;
  }
}

function modelId(value, field = 'model') {
  if (typeof value !== 'string') {
    throw new GlobalChatProfileError('invalid_model', `${field} must be a model id`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || !MODEL_ID_RE.test(normalized)) {
    throw new GlobalChatProfileError('invalid_model', `${field} must be a valid model id`);
  }
  return normalized;
}

function reasoningEffort(value) {
  if (!REASONING_SET.has(value)) {
    throw new GlobalChatProfileError('invalid_reasoning', 'Invalid reasoning effort');
  }
  return value;
}

function money(value, { nullable = true } = {}) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw new GlobalChatProfileError('invalid_spend_cap', 'Spend cap is required');
  }
  const normalized = String(value).trim();
  const match = MONEY_RE.exec(normalized);
  if (!match) {
    throw new GlobalChatProfileError(
      'invalid_spend_cap',
      'Spend cap must be a nonnegative USD amount with at most 8 decimals',
    );
  }
  const whole = normalized.split('.')[0].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] || '').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function defaults(config = {}) {
  return Object.freeze({
    backend: 'openrouter',
    model: modelId(config.openrouterDefaultGlobalChatModel || DEFAULT_MODEL, 'default model'),
    reasoningEffort: reasoningEffort(
      config.openrouterDefaultGlobalChatReasoning || DEFAULT_REASONING_EFFORT,
    ),
    spendCapUsd: null,
  });
}

function publicProfile(row, config = {}) {
  const fallback = defaults(config);
  if (!row) return { ...fallback, saved: false };
  return {
    backend: 'openrouter',
    model: modelId(row.model_id || fallback.model),
    reasoningEffort: reasoningEffort(row.reasoning_effort || fallback.reasoningEffort),
    spendCapUsd: money(row.spend_cap_usd),
    saved: true,
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : (row.updated_at || null),
  };
}

async function readProfile(pool, userId, config = {}) {
  const { rows } = await pool.query(
    `SELECT model_id, reasoning_effort, spend_cap_usd, updated_at
       FROM global_chat_profiles
      WHERE user_id = $1`,
    [userId],
  );
  return publicProfile(rows[0], config);
}

async function writeProfile(pool, userId, profile, config = {}) {
  const fallback = defaults(config);
  const normalized = {
    model: modelId(profile.model ?? fallback.model),
    reasoningEffort: reasoningEffort(profile.reasoningEffort ?? fallback.reasoningEffort),
    spendCapUsd: money(profile.spendCapUsd),
  };
  const { rows } = await pool.query(
    `INSERT INTO global_chat_profiles
       (user_id, model_id, reasoning_effort, spend_cap_usd)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       model_id = EXCLUDED.model_id,
       reasoning_effort = EXCLUDED.reasoning_effort,
       spend_cap_usd = EXCLUDED.spend_cap_usd,
       updated_at = NOW()
     RETURNING model_id, reasoning_effort, spend_cap_usd, updated_at`,
    [userId, normalized.model, normalized.reasoningEffort, normalized.spendCapUsd],
  );
  return publicProfile(rows[0] || {
    model_id: normalized.model,
    reasoning_effort: normalized.reasoningEffort,
    spend_cap_usd: normalized.spendCapUsd,
    updated_at: null,
  }, config);
}

function utcMonthBounds(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.valueOf())) {
    throw new GlobalChatProfileError('invalid_date', 'Invalid usage date');
  }
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const reset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, reset };
}

function moneyToUnits(value) {
  const normalized = money(value, { nullable: false });
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
}

function unitsToMoney(units) {
  const safe = units < 0n ? 0n : units;
  const whole = safe / 100000000n;
  const fraction = String(safe % 100000000n).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function remainingSpend(cap, spent) {
  if (cap == null) return null;
  return unitsToMoney(moneyToUnits(cap) - moneyToUnits(spent || '0'));
}

async function readMonthlyUsage(pool, userId, { now = new Date(), spendCapUsd = null } = {}) {
  const { start, reset } = utcMonthBounds(now);
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(cost_usd), 0)::text AS spent_usd,
       COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
       COALESCE(SUM(reasoning_tokens), 0)::text AS reasoning_tokens,
       COUNT(*)::text AS turns,
       COUNT(*) FILTER (WHERE outcome = 'success')::text AS successful_turns
     FROM global_chat_usage
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
    [userId, start, reset],
  );
  const row = rows[0] || {};
  const spentUsd = money(row.spent_usd || '0', { nullable: false });
  const capUsd = money(spendCapUsd);
  return {
    period: 'utc_calendar_month',
    periodStart: start.toISOString(),
    resetAt: reset.toISOString(),
    spentUsd,
    capUsd,
    remainingUsd: remainingSpend(capUsd, spentUsd),
    capReached: capUsd == null ? false : moneyToUnits(spentUsd) >= moneyToUnits(capUsd),
    turns: String(row.turns || '0'),
    successfulTurns: String(row.successful_turns || '0'),
    inputTokens: String(row.input_tokens || '0'),
    outputTokens: String(row.output_tokens || '0'),
    reasoningTokens: String(row.reasoning_tokens || '0'),
  };
}

function supportsEffort(model, effort) {
  if (!model || model.supportsReasoningEffort !== true) return false;
  return !Array.isArray(model.reasoningEfforts)
    || model.reasoningEfforts.length === 0
    || model.reasoningEfforts.includes(effort);
}

function compatibleModels(catalog, effort) {
  const checkedEffort = reasoningEffort(effort);
  return (catalog?.models || []).filter(
    (model) => agentModels.meetsGlobalChatMinimums(model) && supportsEffort(model, checkedEffort),
  );
}

function globalChatCatalog(catalog, config = {}, effort = null) {
  const configured = defaults(config);
  const selectedEffort = reasoningEffort(effort || configured.reasoningEffort);
  const models = compatibleModels(catalog, selectedEffort);
  const fallbackIds = Array.isArray(config.openrouterGlobalChatFallbackModels)
    ? config.openrouterGlobalChatFallbackModels
    : [];
  const recommended = models.find((item) => item.id === configured.model)
    || fallbackIds.map((id) => models.find((item) => item.id === id)).find(Boolean)
    || models[0]
    || null;
  return {
    backend: 'openrouter',
    credentialRevision: catalog?.credentialRevision ?? null,
    refreshedAt: catalog?.refreshedAt || null,
    requiredCapabilities: {
      tools: true,
      structuredOutputs: true,
      reasoningEffort: selectedEffort,
    },
    recommendedModelId: recommended?.id || null,
    totalModels: models.length,
    models: models.map((item) => ({
      ...item,
      isGlobalChatRecommended: item.id === recommended?.id,
    })),
  };
}

module.exports = {
  REASONING_EFFORTS,
  GlobalChatProfileError,
  modelId,
  reasoningEffort,
  money,
  defaults,
  publicProfile,
  readProfile,
  writeProfile,
  utcMonthBounds,
  remainingSpend,
  readMonthlyUsage,
  supportsEffort,
  compatibleModels,
  globalChatCatalog,
};

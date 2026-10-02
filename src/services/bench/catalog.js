'use strict';

// #3654: the models a Homeroom bot benchmark can put through its tasks.
//
// The list is a starting point, not an allowlist. Every model runs through
// the same OpenRouter path the bot's own turns use (agent-turn
// resolveCodexRuntimeContext), which takes any id OpenRouter serves; nothing
// here widens what a member may pick in the dev chat, which reads its own
// catalog. An admin may add any OpenRouter id to a run.
//
// Prices and context windows are NOT written down here. They come from the
// OpenRouter catalog the platform already stores (openrouter_model_catalog,
// refreshed by services/agent-models.js), and a trial's real cost comes from
// what it spent, recorded per turn. The figures in the request that started
// this were unverified snippets, so the screen says "price unknown" rather
// than repeat one. The only figure kept here is a context window a model is
// known to have, as a fallback when the catalog is silent, and the stages a
// model is limited to by the people who asked for it.
//
// A task a model cannot take is NOT APPLICABLE, not failed: its stage is not
// one the model is entered for, or its prompt would not fit the model's
// context window with room left to work (contextFits).

const log = require('../logger');

const CANDIDATES = Object.freeze([
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', role: 'baseline' },
  { id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo V2.6 Pro' },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
  { id: 'qwen/qwen3.8-flash', label: 'Qwen3.8 Flash' },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  // 262K context: entered for builds only, where the repository is read in
  // pieces; a triage turn's reading runs long.
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', contextTokens: 262_144, stages: ['build', 'spec'] },
  // The quality ceiling: what the stages look like on a frontier model.
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', role: 'ceiling' },
]);
const BASELINE = 'z-ai/glm-5.3-flash';

// What a stage reads beyond its prompt before it answers: files, test output,
// tool results. A task fits a model when its prompt plus this allowance is
// inside the context window.
const WORKING_TOKENS = Object.freeze({
  triage: 96_000, dm: 96_000, spec: 128_000, build: 160_000, followup: 128_000, checks_fix: 128_000,
});
// A rough upper estimate of what one trial reads and writes, for a model
// with a price and no history yet (p90-ish of the bot's own runs on its
// baseline: triage p90 was $0.26 and a build's $2.00 on a Flash model).
const TOKEN_BUDGET = Object.freeze({
  triage: { input: 1_500_000, output: 20_000 },
  dm: { input: 3_000_000, output: 40_000 },
  spec: { input: 1_500_000, output: 30_000 },
  build: { input: 6_000_000, output: 120_000 },
  followup: { input: 1_500_000, output: 30_000 },
  checks_fix: { input: 2_000_000, output: 40_000 },
});
// And with neither a price nor a history: dollars per trial.
const FALLBACK_USD = Object.freeze({ triage: 0.3, dm: 0.6, spec: 0.5, build: 2.5, followup: 0.5, checks_fix: 0.6 });
const MIN_HISTORY = 3;

/** OpenRouter's own figures for each id, from the stored catalog. */
async function catalogFigures(pool, ids) {
  try {
    const { rows } = await pool.query('SELECT models FROM openrouter_model_catalog WHERE id = TRUE');
    const models = Array.isArray(rows[0]?.models) ? rows[0].models : [];
    const want = new Set(ids);
    const out = new Map();
    for (const m of models) {
      if (!m || !want.has(m.id)) continue;
      const perToken = (v) => {
        const n = Number.parseFloat(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };
      out.set(m.id, {
        contextTokens: Number(m.context_length || m.top_provider?.context_length) || null,
        inputPerMillion: perToken(m.pricing?.prompt) == null ? null : perToken(m.pricing.prompt) * 1e6,
        outputPerMillion: perToken(m.pricing?.completion) == null ? null : perToken(m.pricing.completion) * 1e6,
        name: m.name || null,
      });
    }
    return out;
  } catch (err) {
    log.warn('bench', 'Could not read the OpenRouter catalog', { err: err.message });
    return new Map();
  }
}

/**
 * The models to offer, with what the catalog says of each: the candidates
 * above plus any `extra` ids (models already used in a run).
 */
async function listModels(pool, extra = []) {
  const ids = [...new Set([...CANDIDATES.map((c) => c.id), ...extra.filter((x) => typeof x === 'string')])];
  const figures = await catalogFigures(pool, ids);
  return ids.map((id) => {
    const known = CANDIDATES.find((c) => c.id === id) || {};
    const f = figures.get(id) || {};
    return {
      id,
      label: known.label || f.name || id,
      role: known.role || null,
      stages: known.stages || null,
      contextTokens: f.contextTokens || known.contextTokens || null,
      inputPerMillion: f.inputPerMillion ?? null,
      outputPerMillion: f.outputPerMillion ?? null,
      inCatalog: figures.has(id),
    };
  });
}

/** A model's entry for one id, offered or not. */
function modelInfo(models, id) {
  return models.find((m) => m.id === id) || {
    id, label: id, role: null, stages: null, contextTokens: null, inputPerMillion: null, outputPerMillion: null, inCatalog: false,
  };
}

/** A prompt's size in tokens, roughly (chars / 3.5). */
function estimateTokens(chars) {
  const n = Number(chars);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 3.5) : 0;
}

/**
 * Whether a task can be put to a model at all. Null when it can; otherwise
 * the reason it is not applicable (never a failure of the model).
 */
function notApplicableReason(model, stage, promptChars) {
  if (Array.isArray(model.stages) && !model.stages.includes(stage)) {
    return `${model.label} is entered for ${model.stages.join(' and ')} only`;
  }
  if (model.contextTokens) {
    const need = estimateTokens(promptChars) + (WORKING_TOKENS[stage] || 128_000);
    if (need > model.contextTokens) {
      return `the task needs about ${Math.round(need / 1000)}K tokens of context; ${model.label} has ${Math.round(model.contextTokens / 1000)}K`;
    }
  }
  return null;
}

/**
 * What one trial is expected to cost, for the run's cap. The 90th percentile
 * of what this model already spent on this stage when there are at least
 * MIN_HISTORY trials of it; else the stage's token budget at the model's
 * price; else a fallback per stage. Deliberately pessimistic: the cap stops
 * scheduling before a trial that would cross it, not after.
 */
function estimateTrialCost(model, stage, history = []) {
  const costs = history.filter((c) => Number.isFinite(c) && c >= 0).sort((a, b) => a - b);
  if (costs.length >= MIN_HISTORY) return costs[Math.min(costs.length - 1, Math.ceil(0.9 * costs.length) - 1)];
  const budget = TOKEN_BUDGET[stage];
  if (budget && Number.isFinite(model.inputPerMillion) && Number.isFinite(model.outputPerMillion)) {
    return (budget.input * model.inputPerMillion + budget.output * model.outputPerMillion) / 1e6;
  }
  return FALLBACK_USD[stage] ?? 1;
}

module.exports = {
  CANDIDATES,
  BASELINE,
  WORKING_TOKENS,
  TOKEN_BUDGET,
  FALLBACK_USD,
  listModels,
  modelInfo,
  estimateTokens,
  notApplicableReason,
  estimateTrialCost,
};

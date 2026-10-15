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
const modelCosts = require('../model-costs');

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
  // #3737: a first version is a triage and then a build on a starter.
  first_version: 160_000,
});
// A rough upper estimate of what one trial reads and writes, for a model
// with a price and no history yet (p90-ish of the bot's own runs on its
// baseline: triage p90 was $0.26 and a build's $2.00 on a Flash model).
// `input` is every prompt token, cache reads and writes included; most of
// it is cache reads, priced at the model's cache rates (budgetTrialCost).
const TOKEN_BUDGET = Object.freeze({
  triage: { input: 1_500_000, output: 20_000 },
  dm: { input: 3_000_000, output: 40_000 },
  spec: { input: 1_500_000, output: 30_000 },
  build: { input: 6_000_000, output: 120_000 },
  followup: { input: 1_500_000, output: 30_000 },
  checks_fix: { input: 2_000_000, output: 40_000 },
  // A triage, a spec and a whole first version's build on its longer clock.
  first_version: { input: 9_000_000, output: 170_000 },
});
// And with neither a price nor a history: dollars per trial.
// A capture trial runs no model at all (services/bench/taste.js).
const FALLBACK_USD = Object.freeze({ triage: 0.3, dm: 0.6, spec: 0.5, build: 2.5, followup: 0.5, checks_fix: 0.6, first_version: 3, capture: 0 });
const MIN_HISTORY = 3;
// One call of a first version's reviewer (services/bot-review.js): the
// request, the spec and eight screenshots in, a list of issues out, priced
// uncached; and what one is taken to cost with no price to go on (about an
// Opus round).
const REVIEW_CALL_TOKENS = Object.freeze({ input: 25_000, output: 5_000 });
const FALLBACK_REVIEW_CALL_USD = 0.2;

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
        // What a prompt-cache read and write cost, null where the catalog
        // lists none (agent-models.js reads the same two fields).
        cacheReadPerMillion: perToken(m.pricing?.input_cache_read) == null ? null : perToken(m.pricing.input_cache_read) * 1e6,
        cacheWritePerMillion: perToken(m.pricing?.input_cache_write) == null ? null : perToken(m.pricing.input_cache_write) * 1e6,
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
      cacheReadPerMillion: f.cacheReadPerMillion ?? null,
      cacheWritePerMillion: f.cacheWritePerMillion ?? null,
      inCatalog: figures.has(id),
    };
  });
}

/** A model's entry for one id, offered or not. */
function modelInfo(models, id) {
  return models.find((m) => m.id === id) || {
    id, label: id, role: null, stages: null, contextTokens: null, inputPerMillion: null, outputPerMillion: null,
    cacheReadPerMillion: null, cacheWritePerMillion: null, inCatalog: false,
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
  return budgetTrialCost(model, stage) ?? FALLBACK_USD[stage] ?? 1;
}

/**
 * The stage's token budget at the model's price, or null without a price.
 * The budget's input is split as the model picker's typical change splits
 * its own (model-costs.js DOCUMENTED_CACHE_SHARES: 95% cache reads, 5%
 * cache writes, below the 97-98% reads the bench's own GLM 5.3 Flash
 * builds measured), and each part is priced at the model's cache rate
 * where the catalog lists one and at its prompt rate where it does not
 * (model-costs.js tokenCostUsd, the turn ledger's arithmetic). A model
 * with no cache prices gets exactly the prompt-rate figure. Pure.
 */
function budgetTrialCost(model, stage) {
  const budget = TOKEN_BUDGET[stage];
  if (budget && Number.isFinite(model?.inputPerMillion) && Number.isFinite(model?.outputPerMillion)) {
    return modelCosts.tokenCostUsd({
      inputPricePerMillion: model.inputPerMillion,
      outputPricePerMillion: model.outputPerMillion,
      cacheReadPricePerMillion: model.cacheReadPerMillion,
      cacheWritePricePerMillion: model.cacheWritePerMillion,
    }, {
      inputTokens: budget.input,
      ...modelCosts.cacheSplit(budget.input),
      outputTokens: budget.output,
    });
  }
  return null;
}

/** One reviewer call at the model's catalog price, else FALLBACK_REVIEW_CALL_USD. Pure. */
function reviewCallCost(model) {
  const usd = modelCosts.tokenCostUsd({
    inputPricePerMillion: Number.isFinite(model?.inputPerMillion) ? model.inputPerMillion : null,
    outputPricePerMillion: Number.isFinite(model?.outputPerMillion) ? model.outputPerMillion : null,
  }, { inputTokens: REVIEW_CALL_TOKENS.input, outputTokens: REVIEW_CALL_TOKENS.output });
  return usd == null ? FALLBACK_REVIEW_CALL_USD : usd;
}

/**
 * What one first version built by a Homeroom bot configuration's recipe
 * (services/bot-configs.js: { models: { triage, spec, build }, reviewer })
 * is expected to cost, each stage at its own model's price (its token
 * budget, else its fallback): the triage, unless `triage: false` (a side
 * build replays the live run's), the spec, the build, and per review round
 * one reviewer call (reviewCallCost) and one fix turn at the build's model
 * (a follow-up's budget). `models` is listModels' answer, holding every id
 * the recipe names. Pure.
 */
function estimateRecipeCost(models, recipe, { triage = true } = {}) {
  const at = (id, stage) => budgetTrialCost(modelInfo(models, id), stage) ?? FALLBACK_USD[stage] ?? 1;
  const m = recipe?.models || {};
  let usd = (triage ? at(m.triage, 'triage') : 0) + at(m.spec, 'spec') + at(m.build, 'build');
  const rounds = recipe?.reviewer ? Math.max(0, Number(recipe.reviewer.maxRounds) || 0) : 0;
  if (rounds > 0) usd += rounds * (reviewCallCost(modelInfo(models, recipe.reviewer.model)) + at(m.build, 'followup'));
  return usd;
}

/** Every model id a recipe names, for listModels. Pure. */
function recipeModelIds(recipe) {
  const m = recipe?.models || {};
  return [m.triage, m.spec, m.build, recipe?.reviewer?.model].filter((id) => typeof id === 'string' && id);
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}

/**
 * How far the token budget overstates what trials really cost, learned from
 * the models that have run (#3710). For every model in `models` with at least
 * MIN_HISTORY trials at a stage and a price, the ratio of its median trial to
 * its budget estimate; per stage the median of those ratios, and `any` the
 * median across every stage, for a stage nothing has run at yet. The budget
 * used to read every token as uncached, and the bot's turns are mostly cache
 * reads, so on the first production runs a Flash triage cost about a fifth
 * of it; with the cached share priced at the cache rates the ratio sits
 * nearer one.
 * Pure. Returns { byStage: { stage: { ratio, from } }, any: { ratio, from } | null }.
 */
function costCalibration(models, history) {
  const per = {};
  const all = [];
  for (const m of models || []) {
    for (const stage of Object.keys(TOKEN_BUDGET)) {
      const costs = (history.get(`${m.id}|${stage}`) || []).filter((c) => Number.isFinite(c) && c >= 0).sort((a, b) => a - b);
      const budget = budgetTrialCost(m, stage);
      if (costs.length < MIN_HISTORY || !budget) continue;
      const ratio = median(costs) / budget;
      (per[stage] = per[stage] || []).push(ratio);
      all.push(ratio);
    }
  }
  const byStage = {};
  for (const [stage, list] of Object.entries(per)) byStage[stage] = { ratio: median(list.sort((a, b) => a - b)), from: list.length };
  return { byStage, any: all.length ? { ratio: median(all.sort((a, b) => a - b)), from: all.length } : null };
}

/**
 * What one trial is LIKELY to cost, for the launcher's preview (#3710): the
 * median of this model's own trials at this stage when it has enough of
 * them; else its token budget scaled by what the token budget has proved to
 * overstate (costCalibration); else the pessimistic figure. The cap is still
 * scheduled against estimateTrialCost. Pure.
 */
function likelyTrialCost(model, stage, history = [], calibration = null) {
  const costs = history.filter((c) => Number.isFinite(c) && c >= 0).sort((a, b) => a - b);
  if (costs.length >= MIN_HISTORY) return median(costs);
  const budget = budgetTrialCost(model, stage);
  const cal = calibration?.byStage?.[stage] || calibration?.any;
  if (budget != null && cal) return Math.min(budget, budget * cal.ratio);
  return estimateTrialCost(model, stage, history);
}

// The stage a stage with no trials of its own is priced from: a first
// version is a build on a starter (with a triage and a spec before it), and
// the two kinds of follow-up turn on a proposal are alike.
const COMPARABLE_STAGE = Object.freeze({ first_version: 'build', checks_fix: 'followup', followup: 'checks_fix' });

/**
 * What one trial will probably cost, as a range, and what the range rests on
 * (`basis`), for the launcher. The closest trials that exist, in this order:
 *
 *   own         this model's trials at this stage: from MIN_HISTORY of them,
 *               their median to the dearest tenth (the figure the cap is
 *               scheduled against);
 *   stage       other models' trials at this stage: from MIN_HISTORY a
 *               model, this model's price-based guess and that guess scaled
 *               as theirs compared with their price; fewer, their trials;
 *   comparable  nothing has run at this stage, so the stage it is most like
 *               (COMPARABLE_STAGE, named in `from`): this model's trials
 *               there, else any model's;
 *   price       nothing like it has run: from the price scaled by every
 *               stage's history up to the price-based guess itself;
 *   fixed       no price either: the stage's fixed guess (FALLBACK_USD);
 *   none        a trial that runs no model (a capture) costs nothing.
 *
 * Fewer trials than MIN_HISTORY, or another model's, say what such a trial
 * cost without saying what this one will: the range runs from the cheapest
 * of them to the dearest, and takes in this model's price-based guess too,
 * so one trial never reads as a confident figure. likelyTrialCost answers
 * with one figure, and for a stage with no history it borrows every stage's
 * calibration: four first versions read $0.05 while a build costs a dollar
 * or two. Pure.
 */
function costRange(model, stage, history, calibration = null) {
  const sorted = (list) => (list || []).filter((c) => Number.isFinite(c) && c >= 0).sort((a, b) => a - b);
  const p90 = (s) => s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
  const mine = (st) => sorted(history && history.get ? history.get(`${model.id}|${st}`) : null);
  const anyModel = (st) => {
    const all = [];
    if (history && history.forEach) history.forEach((list, key) => { if (key.endsWith(`|${st}`)) all.push(...list); });
    return sorted(all);
  };
  const own = mine(stage);
  if (own.length >= MIN_HISTORY) return { low: median(own), high: p90(own), basis: 'own', from: stage };
  if (!TOKEN_BUDGET[stage] && FALLBACK_USD[stage] === 0) return { low: 0, high: 0, basis: 'none', from: null };
  const est = estimateTrialCost(model, stage, own);
  const likely = likelyTrialCost(model, stage, own, calibration);
  const around = (costs, basis, from) => {
    const all = sorted([...costs, est]);
    return { low: all[0], high: all[all.length - 1], basis, from };
  };
  if (own.length) return around(own, 'own', stage);
  const cal = calibration?.byStage?.[stage];
  const budget = budgetTrialCost(model, stage);
  if (cal && budget != null) return around([budget * cal.ratio], 'stage', stage);
  const theirs = anyModel(stage);
  if (theirs.length) return around(theirs, 'stage', stage);
  const like = COMPARABLE_STAGE[stage];
  if (like) {
    const there = mine(like);
    if (there.length >= MIN_HISTORY) return { low: median(there), high: p90(there), basis: 'comparable', from: like };
    if (there.length) return around(there, 'comparable', like);
    const others = anyModel(like);
    if (others.length) return around(others, 'comparable', like);
  }
  return { low: Math.min(likely, est), high: Math.max(likely, est), basis: budget != null ? 'price' : 'fixed', from: null };
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
  budgetTrialCost,
  REVIEW_CALL_TOKENS,
  FALLBACK_REVIEW_CALL_USD,
  reviewCallCost,
  estimateRecipeCost,
  recipeModelIds,
  costCalibration,
  likelyTrialCost,
  COMPARABLE_STAGE,
  costRange,
};

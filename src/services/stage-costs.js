'use strict';

// What a first version cost, stage by stage and model by model: the reports
// an admin reads (the App bench's trials, services/bench/studio.js; the bot
// configurations' results, services/bot-configs.js) carried one total, so a
// configuration that spends its money on an Opus 5.5 spec and reviewer
// around a GLM build could not be told from one that spends it on the build.
//
// The parts come from where each is known:
//
//   triage           the triage turn's session in the turn ledger
//                    (agent_turns.estimated_cost_usd), or the live run's own
//                    triage cost (homeroom_bot_runs.cost_usd);
//   spec, build      the spec turn and the build turn, each one logical turn
//                    in the ledger (runCodexAttemptLoop's estimatedCostUsd,
//                    every attempt included). The build's look-and-fix loop
//                    is inside its turn, so it is the build's;
//   review_reviewer  the reviewer's calls (services/bot-review.js), which are
//                    not agent turns, from the review state;
//   review_fixes     the review rounds' fix turns, from the review state.
//
// Tokens come from the ledger for the turns it holds (input and output),
// and are left out where nothing records them (the reviewer's calls). What
// the total holds that no part names (a turn a restart threw away and its
// next claim did again, a spec written before a restart) is `other`, so the
// parts always add up to the total.

const STAGES = Object.freeze(['triage', 'spec', 'build', 'review_reviewer', 'review_fixes']);
const MODEL_RE = /^[\w./:@+-]{1,160}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TURN_IDS = 20;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const usd = (v) => Math.round(Number(v) * 1e6) / 1e6;
const modelOf = (m) => (typeof m === 'string' && MODEL_RE.test(m) ? m : null);

/** One part: { usd, model, inputTokens?, outputTokens?, turnIds?, screens? }, or null without a cost. Pure. */
function part({ usd: cost, model = null, inputTokens = null, outputTokens = null, turnIds = null, screens = null } = {}) {
  if (num(cost) == null) return null;
  const out = { usd: usd(cost), model: modelOf(model) };
  if (num(inputTokens) != null) out.inputTokens = Math.round(num(inputTokens));
  if (num(outputTokens) != null) out.outputTokens = Math.round(num(outputTokens));
  const ids = (Array.isArray(turnIds) ? turnIds : []).filter((id) => typeof id === 'string' && UUID_RE.test(id)).slice(0, MAX_TURN_IDS);
  if (ids.length) out.turnIds = ids;
  if (Array.isArray(screens) && screens.length) out.screens = screens.slice(0, 6);
  return out;
}

/**
 * The review's two parts from its state (bot-review.js runReviewLoop): the
 * reviewer's calls on its model, and the fix turns on the build's. Pure.
 */
function reviewParts(review, { buildModel = null, fixTurnIds = [] } = {}) {
  const rounds = Array.isArray(review?.rounds) ? review.rounds : [];
  if (!review || !rounds.length) return {};
  const sum = (pick) => rounds.reduce((s, r) => s + (num(pick(r)) || 0), 0);
  const fixed = rounds.some((r) => r && r.fix && num(r.fix.costUsd) != null);
  const out = {};
  const reviewer = part({ usd: sum((r) => r?.reviewerCostUsd), model: review.reviewer?.model || null });
  if (reviewer) out.review_reviewer = reviewer;
  if (fixed) out.review_fixes = part({ usd: sum((r) => r?.fix?.costUsd), model: buildModel, turnIds: fixTurnIds });
  return out;
}

/**
 * The parts a build knows (homeroom-bot-live.js buildAndPropose's
 * `stageCosts`), as stored: each a part(), the ones with no cost left out.
 * Pure.
 */
function fromStages(stages) {
  const out = {};
  for (const stage of STAGES) {
    const p = stages && stages[stage] ? part(stages[stage]) : null;
    if (p) out[stage] = p;
  }
  return out;
}

/**
 * Tokens for the parts that name their turns, from the ledger: one query.
 * Parts without turns, or a ledger that cannot be read, are left as they
 * are. Never throws.
 */
async function withLedgerTokens(pool, parts) {
  const out = { ...(parts || {}) };
  const ids = [...new Set(Object.values(out).flatMap((p) => (Array.isArray(p?.turnIds) ? p.turnIds : [])))];
  if (!pool || !ids.length) return out;
  try {
    const { rows } = await pool.query(
      `SELECT logical_turn_id::text AS id, COALESCE(SUM(input_tokens), 0)::bigint AS input,
              COALESCE(SUM(output_tokens), 0)::bigint AS output
         FROM agent_turns WHERE logical_turn_id = ANY($1::uuid[])
        GROUP BY logical_turn_id`,
      [ids],
    );
    const byId = new Map((rows || []).map((r) => [String(r.id), r]));
    for (const [stage, p] of Object.entries(out)) {
      const found = (p?.turnIds || []).map((id) => byId.get(id)).filter(Boolean);
      if (!found.length) continue;
      out[stage] = {
        ...p,
        inputTokens: found.reduce((s, r) => s + (Number(r.input) || 0), 0),
        outputTokens: found.reduce((s, r) => s + (Number(r.output) || 0), 0),
      };
    }
  } catch { /* tokens are a nicety; the costs stand without them */ }
  return out;
}

/** What a session's ledger holds: { usd, inputTokens, outputTokens, model }, or null with nothing priced. Never throws. */
async function sessionPart(pool, sessionId, model = null) {
  if (!pool || !sessionId) return null;
  try {
    const { rows: [r] = [] } = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)::float8 AS cost, COUNT(estimated_cost_usd)::int AS priced,
              COALESCE(SUM(input_tokens), 0)::bigint AS input, COALESCE(SUM(output_tokens), 0)::bigint AS output
         FROM agent_turns WHERE session_id = $1`,
      [Number(sessionId)],
    );
    if (!r || !(Number(r.priced) > 0)) return null;
    return part({ usd: r.cost, model, inputTokens: r.input, outputTokens: r.output });
  } catch {
    return null;
  }
}

/**
 * The breakdown a report shows, for a recorded total and its parts:
 * { totalUsd, stages: [{ stage, model, usd, inputTokens?, outputTokens?,
 * screens? }], other: { usd } }, in STAGES order, with `other` what the
 * total holds that no part names. With no total, the parts' sum is the
 * total. A total smaller than its parts (one recorded before a part was)
 * says so in `note` rather than showing a negative remainder. Null with no
 * part. Pure.
 */
function breakdown(totalUsd, parts) {
  const stages = [];
  let sum = 0;
  for (const stage of STAGES) {
    const p = parts && parts[stage] ? part(parts[stage]) : null;
    if (!p) continue;
    const { turnIds: _ids, ...shown } = p;
    // A spec whose drawn screens ran past twice their budget says so on its
    // own line (spec-html.js screenStats): what made it cost what it did.
    if (stage === 'spec' && (p.screens || []).some((sc) => sc && sc.overBudget)) shown.overBudget = true;
    stages.push({ stage, ...shown });
    sum += p.usd;
  }
  if (!stages.length) return null;
  const total = num(totalUsd) == null ? sum : Number(totalUsd);
  const rest = usd(total - sum);
  const out = { totalUsd: usd(total), stages, other: { usd: rest > 0 ? rest : 0 } };
  if (rest < -0.000001) out.note = `the parts come to $${usd(sum)}, more than the recorded total`;
  return out;
}

/**
 * Per-stage averages over breakdowns (one per result), beside the average
 * total they add up to: { n, totalUsd, stages: { [stage]: { usd, models } },
 * otherUsd }. A stage a result did not have counts as nothing spent on it.
 * Null with none. Pure.
 */
function averages(list) {
  const done = (Array.isArray(list) ? list : []).filter((b) => b && Array.isArray(b.stages) && num(b.totalUsd) != null);
  if (!done.length) return null;
  const n = done.length;
  const stages = {};
  for (const stage of STAGES) {
    const seen = done.map((b) => b.stages.find((s) => s.stage === stage)).filter(Boolean);
    if (!seen.length) continue;
    stages[stage] = {
      usd: usd(seen.reduce((s, x) => s + (num(x.usd) || 0), 0) / n),
      models: [...new Set(seen.map((x) => x.model).filter(Boolean))].slice(0, 6),
    };
  }
  return {
    n,
    totalUsd: usd(done.reduce((s, b) => s + Number(b.totalUsd), 0) / n),
    stages,
    otherUsd: usd(done.reduce((s, b) => s + (num(b.other?.usd) || 0), 0) / n),
  };
}

module.exports = {
  STAGES,
  part,
  reviewParts,
  fromStages,
  withLedgerTokens,
  sessionPart,
  breakdown,
  averages,
};

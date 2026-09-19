'use strict';

const log = require('./logger');
const models = require('./models');

// #2570 — what each model is GOOD FOR and what a change on it COSTS.
//
// Two different kinds of number live here and they must not be confused:
//
//   the ESTIMATE  a forward-looking figure the picker shows before you
//                 spend anything. It is per-token pricing multiplied by a
//                 typical change's token profile, and it is labelled an
//                 estimate everywhere it appears. An admin can override it
//                 by hand from the Model costs console.
//   the OBSERVED  what changes on that model actually cost, aggregated
//                 from the platform's own per-turn records. It is never
//                 shown in the picker and never rewrites the estimate on
//                 its own: an admin reads it and decides.
//
// The estimate is deliberately not derived from the observed figure
// automatically. A median over a handful of changes moves violently, and a
// number in the picker that jumps because two people ran long sessions
// yesterday is worse than a stable estimate somebody chose.

// The platform setting that holds the admin overrides, as JSON:
// { "<model id>": <cents> }. Absent means "no overrides", which is the
// state a fresh deployment is in.
const OVERRIDES_KEY = 'model_cost_estimate_overrides';

// A typical change's token profile, used when the platform has no recorded
// usage to measure one from (a fresh deployment, or one whose agent_turns
// history is shorter than the window below).
//
// WHERE THE NUMBERS COME FROM: a coding-agent change is overwhelmingly
// INPUT — the repository context, the conventions block and the turn's own
// transcript are re-sent on every tool round-trip, and the model writes a
// diff and a summary. 2.5M input / 120k output is the order of magnitude a
// single-session change has been running at: dozens of tool round-trips,
// each re-sending the context, is what makes the input figure that large.
// It is one documented constant on purpose: an estimate that nobody can
// point at the origin of is not an estimate, it is a guess with a decimal
// point.
//
// At the prices in this file that profile puts a change at about $0.30 on
// GLM 5.3 Flash, $0.21 on DeepSeek v4.1 Flash, $6.20 on Sonnet 5, $15.50 on
// Opus 5 and $31.00 on Fable 5.1.
const TYPICAL_CHANGE = Object.freeze({
  inputTokens: 2_500_000,
  outputTokens: 120_000,
  source: 'documented_constant',
});

// How far back the observed aggregates look. The request asks for 30 days,
// and it is also about as far back as a per-model figure stays meaningful:
// model ids turn over faster than that on OpenRouter.
const OBSERVED_DAYS = 30;

// The launch notes. One line, present tense, about the WORK — not about
// the vendor and not about the price, which the estimate beside it states.
//
// The three Anthropic entries deliberately reuse `changeSize.short` from
// services/models.js rather than restating it: that copy is the product's
// existing opinion about those three models, and two copies of an opinion
// drift. Only the OpenRouter ids are written out here.
const OPENROUTER_NOTES = Object.freeze({
  'z-ai/glm-5.3-flash': 'fast, inexpensive everyday coding',
  'deepseek/deepseek-v4.1-flash': 'cheap bulk work and long refactors',
});

// Published per-MTok pricing for the models the platform curates, used when
// no live catalogue entry is to hand (the picker has one; the admin console
// does not, because it has no user's key to fetch a catalogue with).
// Anthropic's come from services/models.js and services/llm.js, which agree:
// Sonnet $2/$10, Opus $5/$25, Fable $10/$50 per MTok in/out.
const ANTHROPIC_PRICING = Object.freeze({
  'claude-sonnet-5': { inputPricePerMillion: 2, outputPricePerMillion: 10 },
  'claude-opus-5': { inputPricePerMillion: 5, outputPricePerMillion: 25 },
  'claude-fable-5-1': { inputPricePerMillion: 10, outputPricePerMillion: 50 },
});

const OPENROUTER_PRICING = Object.freeze({
  'z-ai/glm-5.3-flash': { inputPricePerMillion: 0.1, outputPricePerMillion: 0.4 },
  'deepseek/deepseek-v4.1-flash': { inputPricePerMillion: 0.07, outputPricePerMillion: 0.28 },
});

/** A model id as the platform records it, stripped of a transport prefix. */
function normalizeModelId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  // chat_session_messages.model carries `openrouter/<id>`, `scout/<id>` and
  // `claude-code/<id>` labels beside bare ids; agent_turns.requested_model is
  // always bare. One shape reaches the aggregate.
  const stripped = id.replace(/^(?:openrouter|scout|claude-code|codex-openrouter)\//, '');
  return stripped;
}

/** The editorial note for a model id, or '' when there is none. */
function noteFor(modelId) {
  const id = normalizeModelId(modelId);
  if (Object.prototype.hasOwnProperty.call(OPENROUTER_NOTES, id)) return OPENROUTER_NOTES[id];
  const anthropic = models.MODELS[id];
  return anthropic?.changeSize?.short || '';
}

/**
 * Cents for one typical change at these per-MTok prices. Null when either
 * price is missing — a model whose price nobody published gets no estimate
 * rather than a fabricated one.
 */
function estimateCents(pricing, profile = TYPICAL_CHANGE) {
  const input = Number(pricing?.inputPricePerMillion);
  const output = Number(pricing?.outputPricePerMillion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const dollars = (Number(profile.inputTokens) / 1_000_000) * input
    + (Number(profile.outputTokens) / 1_000_000) * output;
  return Math.round(dollars * 100 * 100) / 100;
}

/** The published pricing for a curated id, or null. */
function publishedPricing(modelId) {
  const id = normalizeModelId(modelId);
  return ANTHROPIC_PRICING[id] || OPENROUTER_PRICING[id] || null;
}

/** Every model this module ships a note or a price for. */
function curatedModelIds() {
  return [
    ...Object.keys(ANTHROPIC_PRICING),
    ...Object.keys(OPENROUTER_PRICING),
  ];
}

// ── The typical change, measured ────────────────────────────────────────
//
// agent_turns records per-attempt input and output tokens for every
// OpenRouter turn, so the platform CAN answer "what does a change cost in
// tokens?" from its own history. Summed per session, then a median across
// sessions — a mean here is dominated by the one session somebody left
// running. Below MIN_SESSIONS the answer is noise, so the documented
// constant stands instead and says so.
const MIN_SESSIONS_FOR_PROFILE = 20;

async function typicalChange(pool, { days = OBSERVED_DAYS } = {}) {
  try {
    const { rows } = await pool.query(
      `WITH per_change AS (
         SELECT session_id,
                SUM(input_tokens + cached_input_tokens + cache_write_input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens
           FROM agent_turns
          WHERE started_at >= NOW() - ($1 || ' days')::interval
            AND (input_tokens > 0 OR output_tokens > 0)
          GROUP BY session_id
       )
       SELECT COUNT(*) AS changes,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY input_tokens) AS input_tokens,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY output_tokens) AS output_tokens
         FROM per_change`,
      [String(days)],
    );
    const row = rows[0];
    const changes = Number(row?.changes || 0);
    const inputTokens = Math.round(Number(row?.input_tokens || 0));
    const outputTokens = Math.round(Number(row?.output_tokens || 0));
    if (changes >= MIN_SESSIONS_FOR_PROFILE && inputTokens > 0 && outputTokens > 0) {
      return { inputTokens, outputTokens, source: 'recorded_usage', changes };
    }
    return { ...TYPICAL_CHANGE, changes };
  } catch (err) {
    log.warn('model-costs', 'typical-change read failed; using the documented constant', {
      err: err.message,
    });
    return { ...TYPICAL_CHANGE, changes: 0 };
  }
}

// ── What changes actually cost ──────────────────────────────────────────
//
// Two per-turn cost records carry a model id, and both carry a session id,
// which is what makes "per change" answerable:
//   chat_session_messages (model, cost_cents) — every Mayor turn and every
//     direct OpenRouter reply.
//   agent_turns (requested_model, estimated_cost_usd) — every OpenRouter
//     coding turn.
// chat_sessions.agent_cost_cents, the Claude coding agent's own per-change
// ledger, is deliberately NOT here: it has no model dimension at all (see
// its schema comment), so its spend cannot be attributed to a model without
// inventing the attribution.
async function observedPerModel(pool, { days = OBSERVED_DAYS } = {}) {
  const { rows } = await pool.query(
    `WITH turn_costs AS (
       SELECT session_id, model AS model, cost_cents::numeric AS cents
         FROM chat_session_messages
        WHERE model IS NOT NULL AND cost_cents > 0
          AND created_at >= NOW() - ($1 || ' days')::interval
       UNION ALL
       SELECT session_id, requested_model AS model, (estimated_cost_usd * 100)::numeric AS cents
         FROM agent_turns
        WHERE requested_model IS NOT NULL AND estimated_cost_usd > 0
          AND started_at >= NOW() - ($1 || ' days')::interval
     ),
     per_change AS (
       SELECT model, session_id, SUM(cents) AS cents
         FROM turn_costs
        GROUP BY model, session_id
     )
     SELECT model,
            COUNT(*) AS changes,
            AVG(cents) AS avg_cents,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cents) AS median_cents
       FROM per_change
      GROUP BY model`,
    [String(days)],
  );
  // The label prefixes are stripped here rather than in SQL so one model
  // reached two ways lands in one bucket.
  const byId = new Map();
  for (const row of rows) {
    const id = normalizeModelId(row.model);
    if (!id) continue;
    const changes = Number(row.changes || 0);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        changes,
        avgCents: Number(row.avg_cents || 0),
        medianCents: Number(row.median_cents || 0),
      });
      continue;
    }
    // Two labels for one model: a changes-weighted mean for the average,
    // and the busier label's median, which is the honest thing an average
    // of two medians is not.
    const total = existing.changes + changes;
    existing.avgCents = total > 0
      ? ((existing.avgCents * existing.changes) + (Number(row.avg_cents || 0) * changes)) / total
      : 0;
    if (changes > existing.changes) existing.medianCents = Number(row.median_cents || 0);
    existing.changes = total;
  }
  return byId;
}

// ── Admin overrides ─────────────────────────────────────────────────────

async function readOverrides(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      [OVERRIDES_KEY],
    );
    const raw = rows[0]?.value;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [id, cents] of Object.entries(parsed)) {
      const n = Number(cents);
      if (normalizeModelId(id) && Number.isFinite(n) && n >= 0) clean[normalizeModelId(id)] = n;
    }
    return clean;
  } catch (err) {
    log.warn('model-costs', 'override read failed; showing derived estimates', {
      err: err.message,
    });
    return {};
  }
}

async function writeOverride(pool, { modelId, cents, actorId }) {
  const id = normalizeModelId(modelId);
  if (!id) throw new Error('model id required');
  const current = await readOverrides(pool);
  if (cents == null) delete current[id];
  else current[id] = Number(cents);
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [OVERRIDES_KEY, JSON.stringify(current), actorId || null],
  );
  return current;
}

// ── The two payloads ────────────────────────────────────────────────────

/**
 * What the model picker needs: one note and one estimate per model it can
 * offer, plus the token profile so the client can derive an estimate for a
 * model from the user's own OpenRouter catalogue, which this process has no
 * key to read.
 */
async function pickerPayload(pool) {
  const [profile, overrides] = await Promise.all([
    typicalChange(pool),
    readOverrides(pool),
  ]);
  const out = {};
  for (const id of curatedModelIds()) {
    const override = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null;
    const derived = estimateCents(publishedPricing(id), profile);
    out[id] = {
      note: noteFor(id),
      estimateCents: override != null ? override : derived,
      estimateSource: override != null ? 'override' : (derived == null ? 'none' : 'pricing'),
    };
  }
  for (const [id, cents] of Object.entries(overrides)) {
    if (out[id]) continue;
    out[id] = { note: noteFor(id), estimateCents: cents, estimateSource: 'override' };
  }
  return {
    typicalChange: {
      inputTokens: profile.inputTokens,
      outputTokens: profile.outputTokens,
      source: profile.source,
    },
    models: out,
  };
}

/** What the Model costs console lists: one row per model, estimate + observed. */
async function adminPayload(pool, { days = OBSERVED_DAYS } = {}) {
  const [profile, overrides] = await Promise.all([
    typicalChange(pool, { days }),
    readOverrides(pool),
  ]);
  let observed = new Map();
  let observedError = null;
  try {
    observed = await observedPerModel(pool, { days });
  } catch (err) {
    observedError = err.message;
    log.warn('model-costs', 'observed spend read failed', { err: err.message });
  }
  const ids = new Set([...curatedModelIds(), ...Object.keys(overrides), ...observed.keys()]);
  const rows = [...ids].map((id) => {
    const override = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null;
    const derived = estimateCents(publishedPricing(id), profile);
    const seen = observed.get(id) || null;
    return {
      modelId: id,
      note: noteFor(id),
      derivedCents: derived,
      overrideCents: override,
      shownCents: override != null ? override : derived,
      observedAvgCents: seen ? Math.round(seen.avgCents * 100) / 100 : null,
      observedMedianCents: seen ? Math.round(seen.medianCents * 100) / 100 : null,
      observedChanges: seen ? seen.changes : 0,
    };
  });
  rows.sort((a, b) => (b.observedChanges - a.observedChanges)
    || a.modelId.localeCompare(b.modelId));
  return {
    days,
    typicalChange: {
      inputTokens: profile.inputTokens,
      outputTokens: profile.outputTokens,
      source: profile.source,
      changes: profile.changes ?? 0,
    },
    rows,
    observedError,
  };
}

module.exports = {
  OVERRIDES_KEY,
  OBSERVED_DAYS,
  TYPICAL_CHANGE,
  MIN_SESSIONS_FOR_PROFILE,
  normalizeModelId,
  noteFor,
  estimateCents,
  publishedPricing,
  curatedModelIds,
  typicalChange,
  observedPerModel,
  readOverrides,
  writeOverride,
  pickerPayload,
  adminPayload,
};

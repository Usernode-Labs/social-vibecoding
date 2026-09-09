'use strict';

// Backend-aware agent model catalog (plan.md §7). For codex_openrouter we
// surface the complete user-filtered OpenRouter catalog (only models the
// user's key/policy can use) with advisory compatibility metadata. A model
// being unverified or missing Codex-friendly capabilities must never hide it
// from its owner: OpenRouter is the availability authority for BYOK models.
// For claude_code the legacy allowlist in services/models.js remains
// authoritative.
//
// Per-user cache keyed on (user_id, credential_revision) — never shared
// across users (each key's filtered catalog differs). Short TTL.

const log = require('./logger');
const openrouterClient = require('./openrouter-client');

const CACHE_TTL_MS = 60_000;
const cache = new Map();

// OpenRouter's own pricing sort uses the average prompt/completion price.
// These fixed bands make that same score easier to scan without pretending
// to predict a whole Codex turn (whose token use varies substantially).
const LOW_COST_MAX_PER_MILLION = 2;
const MEDIUM_COST_MAX_PER_MILLION = 10;

function cacheKey(userId, credentialRevision) {
  return `${userId}:${credentialRevision}`;
}

function supportedParameterList(m) {
  const params = m?.supported_parameters || m?.parameters || [];
  return Array.isArray(params) ? params : Object.keys(params);
}

function hasToolSupport(m) {
  const params = supportedParameterList(m);
  return params.includes('tools') || params.includes('tool_choice');
}

// Static minimums a model must meet to even be "experimental" for Codex.
function meetsStaticMinimums(m) {
  if (!m) return false;
  // OpenRouter documents `supported_parameters` as an ARRAY of strings
  // (e.g. ["tools","tool_choice","reasoning"]), not an object. Handle
  // both shapes defensively (review P2).
  // Context length: Codex turns carry large repo context.
  const ctx = m.context_length || m.top_provider?.context_length || 0;
  return hasToolSupport(m) && ctx >= 32000;
}

function pricePerMillion(rawPrice) {
  if (rawPrice == null || rawPrice === '') return null;
  const parsed = Number.parseFloat(rawPrice);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
}

function averageTokenPrice(inputPricePerMillion, outputPricePerMillion) {
  if (!Number.isFinite(inputPricePerMillion) || !Number.isFinite(outputPricePerMillion)) {
    return null;
  }
  return (inputPricePerMillion + outputPricePerMillion) / 2;
}

function costTier(averagePricePerMillion) {
  if (!Number.isFinite(averagePricePerMillion)) return 'unknown';
  if (averagePricePerMillion === 0) return 'free';
  if (averagePricePerMillion <= LOW_COST_MAX_PER_MILLION) return 'low';
  if (averagePricePerMillion <= MEDIUM_COST_MAX_PER_MILLION) return 'medium';
  return 'high';
}

function compareByCost(a, b) {
  const aPrice = Number.isFinite(a.averagePricePerMillion) ? a.averagePricePerMillion : Infinity;
  const bPrice = Number.isFinite(b.averagePricePerMillion) ? b.averagePricePerMillion : Infinity;
  if (aPrice !== bPrice) return aPrice - bPrice;
  return String(a.name || a.id).localeCompare(String(b.name || b.id));
}

// Sanitize a raw OpenRouter model into the UI-friendly shape.
function sanitizeModel(m, compatibility) {
  const pricing = m.pricing || {};
  const params = m.supported_parameters || m.parameters || [];
  const reasoningMetadata = !Array.isArray(params) && params.reasoning;
  const supportsReasoning = Array.isArray(params)
    ? params.includes('reasoning')
    : !!reasoningMetadata;
  const reasoningEfforts = reasoningMetadata && typeof reasoningMetadata === 'object'
    ? (reasoningMetadata.efforts ?? null)
    : null;
  const promptPrice = pricePerMillion(pricing.prompt);
  const completionPrice = pricePerMillion(pricing.completion);
  const averagePricePerMillion = averageTokenPrice(promptPrice, completionPrice);
  return {
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length || null,
    maxOutputTokens: m.top_provider?.max_completion_tokens || null,
    inputPricePerMillion: promptPrice,
    outputPricePerMillion: completionPrice,
    averagePricePerMillion,
    costTier: costTier(averagePricePerMillion),
    supportsTools: hasToolSupport(m),
    meetsCodexMinimums: meetsStaticMinimums(m),
    supportsReasoning,
    reasoningEfforts,
    compatibility: compatibility.status,
    compatibilityNote: compatibility.note || null,
  };
}

// Load the compatibility overlay from the DB (agent_model_compatibility).
async function loadCompatibilityOverlay(pool, backend) {
  try {
    const { rows } = await pool.query(
      `SELECT model_id, status, note FROM agent_model_compatibility WHERE backend = $1`,
      [backend]
    );
    const map = new Map();
    for (const r of rows) map.set(r.model_id, { status: r.status, note: r.note });
    return map;
  } catch (err) {
    log.warn('agent-models', 'compatibility overlay read failed', { backend, err: err.message });
    return new Map();
  }
}

// Default compatibility when no overlay row exists: experimental if it
// meets the static minimums, otherwise blocked. This is advisory catalog
// metadata only; every model returned by OpenRouter remains selectable.
// Operators promote models to "verified" by inserting an overlay row.
function defaultCompatibility(m) {
  return meetsStaticMinimums(m) ? { status: 'experimental', note: null } : { status: 'blocked', note: 'Model does not meet Codex requirements (tools / context).' };
}

async function listOpenRouterModels({ pool, userId, credentialRevision, apiKey, config, forceRefresh }) {
  if (!apiKey) {
    return {
      backend: 'codex_openrouter', credentialRevision, recommendedModelId: null, models: [],
    };
  }

  const key = cacheKey(userId, credentialRevision);
  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  let raw;
  try {
    raw = await openrouterClient.fetchUserModels(apiKey, { baseUrl: config.openrouterApiBase, origin: config.openrouterOrigin });
  } catch (err) {
    log.warn('agent-models', 'OpenRouter catalog fetch failed', { userId, err: err.message });
    throw err;
  }

  const overlay = await loadCompatibilityOverlay(pool, 'codex_openrouter');
  const models = raw
    .filter((m) => m && typeof m.id === 'string' && m.id.trim())
    .map((m) => {
      const compat = overlay.get(m.id) || defaultCompatibility(m);
      return sanitizeModel(m, compat);
    })
    .sort(compareByCost);

  // Preserve a known-good first-run choice while leaving the visible list
  // sorted strictly by price. The UI uses this only when the user has not
  // already selected a model.
  // Prefer the operator-configured default when the user's key can actually
  // access it. This does not filter or lock the catalog: every OpenRouter
  // model remains visible/selectable, and a missing GLM release safely falls
  // back to the existing compatibility/cost ordering.
  const configuredDefault = String(config.openrouterDefaultCodexModel || '');
  const recommended = models.find((m) => m.id === configuredDefault)
    || models.find((m) => m.compatibility === 'verified')
    || models.find((m) => m.meetsCodexMinimums)
    || models[0]
    || null;

  const value = {
    backend: 'codex_openrouter',
    credentialRevision,
    refreshedAt: new Date().toISOString(),
    recommendedModelId: recommended?.id || null,
    models,
  };
  cache.set(key, { value, at: Date.now() });
  return value;
}



// Resolve the sanitized pricing for a single model id (Commit 4, plan 6.4).
// Uses the (cached) user-filtered catalog so the snapshot matches what the
// user's key can actually use; returns null when the model is not in the
// catalog or the catalog fetch fails (cost then becomes 'unavailable').
async function resolveModelPricing({ pool, userId, credentialRevision, apiKey, modelId, config }) {
  try {
    const catalog = await listOpenRouterModels({
      pool, userId, credentialRevision, apiKey, config, forceRefresh: false,
    });
    const matched = (catalog.models || []).find((m) => m.id === String(modelId));
    // listOpenRouterModels already returned the sanitized catalog shape.
    // Sanitizing it again treats its per-million prices as raw per-token
    // pricing and drops fields such as contextLength/compatibility.
    return matched || null;
  } catch (err) {
    log.warn('agent-models', 'single-model pricing resolution failed', { userId, err: err.message });
    return null;
  }
}

function invalidateUser(userId) {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}
function invalidateAll() { cache.clear(); }

module.exports = {
  meetsStaticMinimums,
  hasToolSupport,
  pricePerMillion,
  averageTokenPrice,
  costTier,
  compareByCost,
  sanitizeModel,
  defaultCompatibility,
  loadCompatibilityOverlay,
  listOpenRouterModels,
  resolveModelPricing,
  invalidateUser,
  invalidateAll,
};

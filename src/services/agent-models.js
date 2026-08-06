'use strict';

// Backend-aware agent model catalog (plan.md §7). For codex_openrouter we
// surface the user-filtered OpenRouter catalog (only models the user's
// key/policy can use) with a compatibility overlay (verified /
// experimental / blocked). For claude_code the legacy allowlist in
// services/models.js remains authoritative.
//
// Per-user cache keyed on (user_id, credential_revision) — never shared
// across users (each key's filtered catalog differs). Short TTL.

const log = require('./logger');
const openrouterClient = require('./openrouter-client');

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function cacheKey(userId, credentialRevision) {
  return `${userId}:${credentialRevision}`;
}

// Static minimums a model must meet to even be "experimental" for Codex.
function meetsStaticMinimums(m) {
  if (!m) return false;
  const params = m.supported_parameters || m.parameters || {};
  const supportsTools = Array.isArray(params.tools) ? params.tools.includes('required') : params.tools !== false;
  // Context length: Codex turns carry large repo context.
  const ctx = m.context_length || m.top_provider?.context_length || 0;
  return supportsTools && ctx >= 32000;
}

// Sanitize a raw OpenRouter model into the UI-friendly shape.
function sanitizeModel(m, compatibility) {
  const pricing = m.pricing || {};
  return {
    id: m.id,
    name: m.name || m.id,
    contextLength: m.context_length || null,
    maxOutputTokens: m.top_provider?.max_completion_tokens || null,
    inputPricePerMillion: parseFloat(pricing.prompt) || null,
    outputPricePerMillion: parseFloat(pricing.completion) || null,
    supportsTools: meetsStaticMinimums(m),
    supportsReasoning: !!(m.architecture?.input_modalities || m.supported_parameters?.reasoning),
    reasoningEfforts: m.supported_parameters?.reasoning?.efforts || ['low', 'medium', 'high'],
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
// meets the static minimums, otherwise blocked. Operators promote models
// to "verified" by inserting an overlay row.
function defaultCompatibility(m) {
  return meetsStaticMinimums(m) ? { status: 'experimental', note: null } : { status: 'blocked', note: 'Model does not meet Codex requirements (tools / context).' };
}

async function listOpenRouterModels({ pool, userId, credentialRevision, apiKey, config, forceRefresh }) {
  if (!apiKey) return { backend: 'codex_openrouter', credentialRevision, models: [] };

  const key = cacheKey(userId, credentialRevision);
  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  let raw;
  try {
    raw = await openrouterClient.fetchUserModels(apiKey, { origin: config.openrouterOrigin });
  } catch (err) {
    log.warn('agent-models', 'OpenRouter catalog fetch failed', { userId, err: err.message });
    throw err;
  }

  const overlay = await loadCompatibilityOverlay(pool, 'codex_openrouter');
  const experimentalOk = config.openrouterExperimentalModels;
  const models = raw
    .map((m) => {
      const compat = overlay.get(m.id) || defaultCompatibility(m);
      if (compat.status === 'blocked') return null;
      if (compat.status === 'experimental' && !experimentalOk) return null;
      return sanitizeModel(m, compat);
    })
    .filter(Boolean);

  const value = {
    backend: 'codex_openrouter',
    credentialRevision,
    refreshedAt: new Date().toISOString(),
    models,
  };
  cache.set(key, { value, at: Date.now() });
  return value;
}

function invalidateUser(userId) {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}
function invalidateAll() { cache.clear(); }

module.exports = {
  meetsStaticMinimums,
  sanitizeModel,
  defaultCompatibility,
  loadCompatibilityOverlay,
  listOpenRouterModels,
  invalidateUser,
  invalidateAll,
};

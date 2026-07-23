// Single source of truth for the LLM models the platform exposes to
// authenticated users. Server validates inbound `model` against this
// allowlist (resolve() falls back to DEFAULT_MODEL on anything unknown
// or missing) so a client picking, say, an unreleased high-tier model
// can't escalate per-call cost. The UI consumes the same map via
// GET /api/models (see chat.js routes), eliminating drift between
// client dropdown and server validation.
//
// Adding a model: add an entry here, restart the platform container.
// Removing one: remove here; in-flight chats with that model fall back
// to DEFAULT_MODEL on the very next turn.

const MODELS = {
  'claude-haiku-4-5':    { label: 'Haiku 4.5', tier: 'haiku', outputCostPerMTok: 5 },
  'claude-sonnet-5':    { label: 'Sonnet 5', tier: 'sonnet', outputCostPerMTok: 15 },
  'claude-opus-4-8':    { label: 'Opus 4.8', tier: 'opus', outputCostPerMTok: 25 },
  'claude-fable-5':    { label: 'Fable 5', tier: 'fable', outputCostPerMTok: 50 },
};

const DEFAULT_MODEL = 'claude-opus-4-8';

// The Mayor is a fixed-role router/PM — it never writes code, so it
// doesn't need the user-selected (often top-tier) model the coding agent
// gets. Historically this was a single env-overridable constant; it's now
// a per-user preference (users.mayor_model, mirroring ai_progress_estimate)
// so each user can pick their own routing model instead of the platform
// pinning everyone to the same one. `pref` is whatever's stored on the
// user row (often null); anything not in the allowlist — including an
// unset preference — falls back to the same claude-sonnet-5 default this
// used to be hardcoded to.
const MAYOR_MODEL_DEFAULT = 'claude-sonnet-5';

function resolveMayorModel(pref) {
  if (typeof pref === 'string' && Object.prototype.hasOwnProperty.call(MODELS, pref)) {
    return pref;
  }
  return MAYOR_MODEL_DEFAULT;
}

function isAllowed(m) {
  return typeof m === 'string' && Object.prototype.hasOwnProperty.call(MODELS, m);
}

function resolve(m) {
  return isAllowed(m) ? m : DEFAULT_MODEL;
}

function list() {
  return Object.entries(MODELS).map(([id, meta]) => ({ id, ...meta }));
}

module.exports = { MODELS, DEFAULT_MODEL, MAYOR_MODEL_DEFAULT, resolveMayorModel, isAllowed, resolve, list };

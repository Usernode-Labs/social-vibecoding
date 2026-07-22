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

// Token-optimization (#): the Mayor is a fixed-role router/PM — it never
// writes code, so it does NOT need the user-selected (often top-tier)
// model. Pinning it to Sonnet keeps routing cheap while the user's chosen
// model still reaches the coding agent (scout/build) where reasoning depth
// actually matters. Env-overridable for emergencies; always validated
// through resolve() so a bad override degrades to DEFAULT_MODEL.
const MAYOR_MODEL = resolveMayorModel();

function resolveMayorModel() {
  const override = process.env.MAYOR_MODEL;
  if (typeof override === 'string' && Object.prototype.hasOwnProperty.call(MODELS, override)) {
    return override;
  }
  return 'claude-sonnet-5';
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

module.exports = { MODELS, DEFAULT_MODEL, MAYOR_MODEL, isAllowed, resolve, list };

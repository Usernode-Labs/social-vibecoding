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
//
// #800: Haiku 4.5 was removed from this allowlist — it is the weakest
// tier for multi-step coding work. The platform still uses
// `claude-haiku-4-5` DIRECTLY (not via this map) for cheap housekeeping
// calls — session / PR / issue titling and progress estimates in
// src/services/llm.js, plus src/routes/auth.js — so those are
// unaffected. Anyone who had it selected is coerced to DEFAULT_MODEL by
// resolve() server-side and by DevChat._sanitizeStoredModel()
// client-side.
//
// `changeSize` (#800) — read it as "picker guidance"; the key name is
// narrower than what it holds and was kept only to avoid churn across
// models.js / dev-chat.js / app-view.js / tests. The copy describes the
// KIND of work each model suits, not a size ladder:
//   - Sonnet is the cheap option for one small, self-contained thing.
//   - Opus and Fable are PEERS on coding strength. Opus is the pick for
//     heavy coding (multi-file features, refactors, real debugging);
//     Fable is the pick when the hard part is judgment about how
//     something should look, read, or feel rather than the code itself.
// `short` goes in the dropdown option text, `long` in the caption under
// the selector. It is EDITORIAL — a product opinion, not a measurement.
// Nothing measured feeds the picker: per-change cost is only now
// starting to be recorded (chat_sessions.agent_cost_cents, written by
// routes/anthropic-proxy.js) and has no reader yet.

const MODELS = {
  'claude-sonnet-5': {
    label: 'Sonnet 5',
    tier: 'sonnet',
    outputCostPerMTok: 15,
    changeSize: {
      short: 'small, simple changes',
      long: 'One small thing at a time: a text tweak, a colour, a single file.',
    },
  },
  'claude-opus-5': {
    label: 'Opus 5',
    tier: 'opus',
    outputCostPerMTok: 25,
    changeSize: {
      short: 'big or tricky coding',
      long: 'Multi-file features, refactors, and debugging that needs real digging.',
    },
  },
  'claude-fable-5': {
    label: 'Fable 5',
    tier: 'fable',
    outputCostPerMTok: 50,
    changeSize: {
      short: 'design and taste',
      long: 'Work where how it looks and feels matters: layout, wording, and judgment calls about the feel of a screen.',
    },
  },
};

const DEFAULT_MODEL = 'claude-opus-5';

function isAllowed(m) {
  return typeof m === 'string' && Object.prototype.hasOwnProperty.call(MODELS, m);
}

function resolve(m) {
  return isAllowed(m) ? m : DEFAULT_MODEL;
}

function list() {
  return Object.entries(MODELS).map(([id, meta]) => ({ id, ...meta }));
}

module.exports = { MODELS, DEFAULT_MODEL, isAllowed, resolve, list };

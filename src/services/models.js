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
// tier for multi-step coding work and had the thinnest issue-attempt
// history of any tier. The platform still uses `claude-haiku-4-5`
// DIRECTLY (not via this map) for cheap housekeeping calls — session /
// PR / issue titling and progress estimates in src/services/llm.js,
// plus src/routes/auth.js — so those are unaffected. Anyone who had it
// selected is coerced to DEFAULT_MODEL by resolve() server-side and by
// DevChat._sanitizeStoredModel() client-side.
//
// `changeSize` (#800) is EDITORIAL guidance, not a measured figure —
// nothing in the schema records PR diff size today. `short` goes in the
// dropdown option text, `long` in the caption under the selector.
// The measured half of the selector (a Wilson band over issues solved)
// is computed separately in src/services/model-stats.js.

const MODELS = {
  'claude-sonnet-5': {
    label: 'Sonnet 5',
    tier: 'sonnet',
    outputCostPerMTok: 15,
    changeSize: {
      short: 'small changes',
      long: 'One small thing at a time: a text tweak, a colour, a single file.',
    },
  },
  'claude-opus-5': {
    label: 'Opus 5',
    tier: 'opus',
    outputCostPerMTok: 25,
    changeSize: {
      short: 'a few files',
      long: 'A normal fix or feature: a few files, one screen.',
    },
  },
  'claude-fable-5': {
    label: 'Fable 5',
    tier: 'fable',
    outputCostPerMTok: 50,
    changeSize: {
      short: 'big or tricky work',
      long: 'Multi-file features, refactors, and debugging that needs real digging.',
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

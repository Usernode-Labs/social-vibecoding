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
//   - Opus is the general-purpose coding pick — the default for coding
//     work of any size, from a one-line fix to a multi-file feature or
//     a refactor (#809: it is deliberately NOT framed as reserved for
//     big or tricky changes).
//   - Fable is the pick for design and taste — judgment about how
//     something should look, read, or feel — AND for the most
//     difficult coding work, where it has the edge over Opus.
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
      short: 'simple, small changes',
      long: 'One small thing at a time: a text tweak, a colour, a single file.',
    },
  },
  'claude-opus-5': {
    label: 'Opus 5',
    tier: 'opus',
    outputCostPerMTok: 25,
    changeSize: {
      short: 'general coding work',
      long: 'Anything from a quick fix to a multi-file feature, a refactor, or debugging that needs real digging.',
    },
  },
  // Fable 5.1 succeeds Fable 5 in the same tier at the same per-token price
  // ($10 in / $50 out per MTok), so `outputCostPerMTok` is unchanged. What it
  // does NOT share is forced tool use: `tool_choice` `any`/`tool` returns a
  // 400 on 5.1, which is why services/llm.js's pills call had to move to
  // `auto` + `strict` in the same change as this rename.
  'claude-fable-5-1': {
    label: 'Fable 5.1',
    tier: 'fable',
    outputCostPerMTok: 50,
    changeSize: {
      short: 'design, taste, and difficult coding',
      long: 'Design and taste (how a screen looks, reads, and feels) plus the most difficult coding work.',
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

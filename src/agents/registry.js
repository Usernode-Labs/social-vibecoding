'use strict';

// Backend registry for the platform's coding agents (plan.md §3/§4-PR1).
//
// Today there is exactly one backend — claude_code — which owns the
// worker lifecycle, the stream-json parser, session continuity, billing,
// and the UI. Adding codex_openrouter in later PRs must NOT fork that
// ownership into a maze of if/else; instead each backend is described
// here, and worker.js / progress / billing / UI resolve through this
// single source of truth.
//
// PR1 seeds only `claude_code`. `codex_openrouter` is added by PR5 (the
// worker adapter). Fields are intentionally minimal now and extended as
// later PRs land.
const DEFAULT_BACKEND = 'claude_code';

// Backend descriptor shape:
//   id          stable backend id (persisted in chat_sessions.agent_backend)
//   label       human name shown in the UI. VENUE-first (#1087 follow-up):
//               every selector in the product now names WHERE the work
//               happens, and two of the six venues are these backends. The
//               old labels ("Claude Code", "Codex (OpenRouter BYOK)") named
//               the tool, which collided head-on with the web hand-off's
//               "Claude Code" and with the `claude-code` external-agent id.
//               The ids are UNCHANGED — only the copy moves.
//   provider    upstream provider (anthropic | openrouter)
//   runner      worker entrypoint that runs this agent (PR5 adds codex)
//   claudeLike  true when the runner emits Claude stream-json + cc_*
//               result fields (used to keep the legacy parser working)
const BACKENDS = {
  claude_code: {
    id: 'claude_code',
    label: 'Homeroom · Claude',
    provider: 'anthropic',
    runner: '/usr/local/bin/run-cc.sh',
    claudeLike: true,
  },
  codex_openrouter: {
    id: 'codex_openrouter',
    label: 'Homeroom · OpenRouter',
    provider: 'openrouter',
    runner: '/usr/local/bin/run-codex-agent.sh',
    claudeLike: false,
  },
};

// Which CLI runs an OpenRouter turn (#3296). `codex_openrouter` is the
// OpenRouter VENUE — the user's key, the per-turn ledger, the catalog, the
// picker — and its id is persisted everywhere, so it does not change. The
// harness is a second, narrower choice inside that venue: the Codex CLI (the
// runner above) or the Claude Code CLI talking to OpenRouter's Anthropic-
// compatible Messages endpoint through a worker-local adapter. Some models
// do measurably better in one than the other, so the platform picks it per
// model from config.openrouterModelHarnesses; a model nobody listed keeps
// Codex, which is what every OpenRouter turn ran before this existed.
const OPENROUTER_HARNESSES = Object.freeze(['codex', 'claude']);
const DEFAULT_OPENROUTER_HARNESS = 'codex';
const OPENROUTER_CLAUDE_RUNNER = '/usr/local/bin/run-cc.sh';

function isOpenRouterHarness(h) {
  return typeof h === 'string' && OPENROUTER_HARNESSES.includes(h);
}

// Parse OPENROUTER_MODEL_HARNESSES: comma-separated `model=harness` pairs.
// An entry that names an unknown harness is dropped rather than guessed at,
// and `none` (or an empty value) means "every model on Codex".
function parseOpenRouterHarnessMap(raw) {
  const map = {};
  const text = String(raw == null ? '' : raw).trim();
  if (!text || text.toLowerCase() === 'none') return map;
  for (const entry of text.split(',')) {
    const at = entry.lastIndexOf('=');
    if (at <= 0) continue;
    const model = entry.slice(0, at).trim();
    const harness = entry.slice(at + 1).trim().toLowerCase();
    if (model && isOpenRouterHarness(harness)) map[model] = harness;
  }
  return Object.freeze(map);
}

function openRouterHarnessForModel(modelId, config = {}) {
  const map = config.openrouterModelHarnesses || {};
  const harness = Object.prototype.hasOwnProperty.call(map, String(modelId || ''))
    ? map[String(modelId)]
    : null;
  return isOpenRouterHarness(harness) ? harness : DEFAULT_OPENROUTER_HARNESS;
}

// A persisted or caller-supplied harness value, failing SAFE to Codex: an
// OpenRouter turn recorded before harnesses existed ran Codex, and a value
// this build does not know must never select a runner it has no env for.
function resolveOpenRouterHarness(h) {
  return isOpenRouterHarness(h) ? h : DEFAULT_OPENROUTER_HARNESS;
}

function isBackend(b) {
  return typeof b === 'string' && Object.prototype.hasOwnProperty.call(BACKENDS, b);
}

// Resolve a backend id, FAILING CLOSED on unknown non-empty values.
//
// Only an ABSENT value (null / undefined / '') means "no explicit choice,
// use the platform default" (e.g. a freshly-created session that predates
// the agent_backend column, or a legacy row). Any other non-empty string
// that is not a known backend is a configuration/typo/version-skew error
// and MUST NOT silently dispatch claude_code — that could route a
// should-be-Codex session onto Anthropic (plan.md review F6).
function resolveBackend(b) {
  if (b == null || b === '') return DEFAULT_BACKEND;
  if (isBackend(b)) return b;
  throw new Error(`registry: unknown backend '${b}'`);
}

function getBackend(b) {
  return BACKENDS[resolveBackend(b)] || null;
}

function listBackends() {
  return Object.values(BACKENDS);
}

function providerFor(b) {
  return getBackend(b)?.provider || null;
}

// The runner entrypoint invoked inside the worker container (via
// `docker exec ... sh -c ...$RUNNER...`). Backend-neutral callers should
// prefer this over a hardcoded /usr/local/bin/run-cc.sh so the Codex
// runner can be selected in PR5 without touching worker.js dispatch.
function runnerFor(b, harness = null) {
  const backend = getBackend(b);
  if (!backend) return null;
  if (backend.provider === 'openrouter' && resolveOpenRouterHarness(harness) === 'claude') {
    return OPENROUTER_CLAUDE_RUNNER;
  }
  return backend.runner || null;
}

module.exports = {
  DEFAULT_BACKEND,
  BACKENDS,
  OPENROUTER_HARNESSES,
  DEFAULT_OPENROUTER_HARNESS,
  isBackend,
  resolveBackend,
  getBackend,
  listBackends,
  providerFor,
  runnerFor,
  isOpenRouterHarness,
  parseOpenRouterHarnessMap,
  openRouterHarnessForModel,
  resolveOpenRouterHarness,
};

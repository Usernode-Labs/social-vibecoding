#!/usr/bin/env node
'use strict';

// Codex ships with metadata only for OpenAI's own model slugs. OpenRouter
// exposes many more slugs (including aliases such as ~vendor/model-latest),
// so each turn installs a one-model catalog for the session-pinned model.
// This keeps Codex's tool/runtime behavior while avoiding its unknown-model
// fallback metadata and the misleading diagnostic that fallback produces.
// The entry reuses Codex's own bundled instructions, with the selected model
// named in place of the bundled GPT-5 identity (#2120).

const fs = require('node:fs');

const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_CONTEXT_WINDOW = 10_000_000;
const DEFAULT_BASE_INSTRUCTIONS = [
  "You are Homeroom's repository coding agent.",
  'Work directly in the current workspace and follow the developer and user instructions.',
  'Inspect the relevant code before editing, use the available tools, run proportionate tests,',
  'and do not claim success without verification. Never expose credentials or other secrets.',
].join(' ');
const REASONING_DESCRIPTIONS = {
  minimal: 'Minimal reasoning',
  low: 'Faster responses with lighter reasoning',
  medium: 'Balanced reasoning for everyday tasks',
  high: 'Greater reasoning depth for complex tasks',
  xhigh: 'Extra-high reasoning depth for the hardest tasks',
};
const REASONING_EFFORTS = Object.keys(REASONING_DESCRIPTIONS);
// Codex's bundled prompts open with an identity sentence written for
// OpenAI's own models. At CLI 0.146.0 every entry starts "You are Codex, an
// agent based on GPT-5." (5.6), "You are Codex, a coding agent based on
// GPT-5." (5.4/5.5) or "You are GPT-5.2 running in the Codex CLI, a
// terminal-based coding assistant." Copied verbatim into the one-model
// catalog, that sentence told whichever OpenRouter model the user picked that
// it is GPT-5, and the model dutifully said so (#2120). Only that leading
// sentence is rewritten; everything after it is the tool-use guidance Codex
// relies on and ships unchanged. Leading whitespace or markdown (a heading
// marker, bold) stays in front of the new sentence.
const BUNDLED_IDENTITY_SENTENCE = new RegExp(
  '^([\\s#>*_-]*)'
  + '(?:You are Codex, an? (?:[\\w-]+ )?agent based on [^\\n]*?\\.'
  + '|You are [^\\n]*? running in the Codex CLI, [^\\n]*?\\.)'
  + '(?=[\\s*_]|$)',
  'i',
);
const MAX_MODEL_NAME_LENGTH = 120;

function selectedModelIdentity(modelId, displayName) {
  const slug = String(modelId || '').trim();
  // The display name comes from OpenRouter's catalog: keep it to one short
  // line before it enters the prompt.
  const name = String(displayName || '').replace(/\s+/g, ' ').trim()
    .slice(0, MAX_MODEL_NAME_LENGTH);
  const label = name && name.toLowerCase() !== slug.toLowerCase()
    ? `${name} (${slug})`
    : slug;
  return `You are Codex, a coding agent running on ${label} through OpenRouter.`;
}

// Name the selected model in `instructions`: replace the bundled identity
// sentence when it leads the text, otherwise prepend the identity so the
// model is never left with a foreign one.
function nameSelectedModel(instructions, { modelId, displayName } = {}) {
  const text = String(instructions || '');
  const identity = selectedModelIdentity(modelId, displayName);
  if (BUNDLED_IDENTITY_SENTENCE.test(text)) {
    return text.replace(BUNDLED_IDENTITY_SENTENCE, (_match, lead) => `${lead}${identity}`);
  }
  return text.trim() ? `${identity}\n\n${text}` : identity;
}

function optionalPositiveInteger(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.round(parsed), MAX_CONTEXT_WINDOW);
}

function parseOptionalBoolean(value) {
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false') return false;
  return null;
}

function safeReasoningEfforts(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((effort) => String(effort).trim())
    .filter((effort) => REASONING_EFFORTS.includes(effort)))];
}

function loadBundledBaseInstructions(catalogPath) {
  if (!catalogPath) return DEFAULT_BASE_INSTRUCTIONS;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const source = Array.isArray(parsed?.models)
      ? parsed.models.find((model) => typeof model?.base_instructions === 'string'
        && model.base_instructions.trim())
      : null;
    return source?.base_instructions || DEFAULT_BASE_INSTRUCTIONS;
  } catch {
    return DEFAULT_BASE_INSTRUCTIONS;
  }
}

function buildCodexModelCatalog({
  modelId,
  displayName,
  contextWindow,
  supportsReasoning,
  reasoningEfforts,
  selectedReasoningEffort,
  baseInstructions,
}) {
  const slug = String(modelId || '').trim();
  if (!slug) throw new Error('modelId is required');

  const reasoningSupport = parseOptionalBoolean(supportsReasoning);
  const selectedEffort = REASONING_EFFORTS.includes(selectedReasoningEffort)
    ? selectedReasoningEffort
    : null;
  let supportedEfforts = safeReasoningEfforts(reasoningEfforts);
  if (reasoningSupport === false) {
    supportedEfforts = [];
  } else if (!supportedEfforts.length) {
    // OpenRouter normally exposes reasoning as a boolean capability rather
    // than an effort list. Its normalized effort API accepts this standard
    // set, which is also exactly the set the Homeroom UI permits.
    supportedEfforts = [...REASONING_EFFORTS];
  }
  if (reasoningSupport !== false && selectedEffort && !supportedEfforts.includes(selectedEffort)) {
    supportedEfforts.push(selectedEffort);
  }

  const resolvedContextWindow = optionalPositiveInteger(contextWindow)
    || DEFAULT_CONTEXT_WINDOW;
  const resolvedName = String(displayName || slug).trim().slice(0, 300) || slug;
  const instructions = nameSelectedModel(
    String(baseInstructions || DEFAULT_BASE_INSTRUCTIONS).trim() || DEFAULT_BASE_INSTRUCTIONS,
    { modelId: slug, displayName: resolvedName },
  );
  const defaultReasoningLevel = supportedEfforts.length
    ? (selectedEffort || (supportedEfforts.includes('medium') ? 'medium' : supportedEfforts[0]))
    : null;

  return {
    models: [{
      slug,
      display_name: resolvedName,
      description: 'OpenRouter model selected for this Homeroom session.',
      default_reasoning_level: defaultReasoningLevel,
      supported_reasoning_levels: supportedEfforts.map((effort) => ({
        effort,
        description: REASONING_DESCRIPTIONS[effort],
      })),
      shell_type: 'shell_command',
      visibility: 'hide',
      supported_in_api: true,
      priority: 1,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      base_instructions: instructions,
      model_messages: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: 'none',
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: resolvedContextWindow,
      max_context_window: resolvedContextWindow,
      auto_compact_token_limit: null,
      comp_hash: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null,
    }],
  };
}

function buildCatalogFromEnvironment(env = process.env) {
  const bundledCatalogPath = env.CODEX_BUNDLED_MODELS_PATH
    || '/usr/local/share/usernode-codex-bundled-models.json';
  return buildCodexModelCatalog({
    modelId: env.AGENT_MODEL,
    displayName: env.AGENT_MODEL_NAME,
    contextWindow: env.AGENT_MODEL_CONTEXT_WINDOW,
    supportsReasoning: env.AGENT_MODEL_SUPPORTS_REASONING,
    reasoningEfforts: env.AGENT_MODEL_REASONING_EFFORTS,
    selectedReasoningEffort: env.AGENT_REASONING_EFFORT,
    baseInstructions: loadBundledBaseInstructions(bundledCatalogPath),
  });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(buildCatalogFromEnvironment())}\n`);
  } catch (err) {
    process.stderr.write(`Could not build OpenRouter model metadata: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_BASE_INSTRUCTIONS,
  DEFAULT_CONTEXT_WINDOW,
  buildCodexModelCatalog,
  buildCatalogFromEnvironment,
  loadBundledBaseInstructions,
  nameSelectedModel,
};

'use strict';

// Codex CLI (codex_openrouter) adapter (plan.md §9, §10). Owns:
//   - Codex config generation (codex config.toml pointing DIRECTLY at
//     OpenRouter; the user's key is injected per-turn as OPENROUTER_API_KEY
//     for provider authentication. Company-funded key material stays off the
//     user-facing API and Settings UI).
//   - The JSONL event parser that normalizes codex exec --json output to
//     the backend-neutral progress vocabulary (services/agent-events.js)
//     the worker.js consumer already understands.
//   - Resume-failure classification.
//
// The normalizer is pinned to the Codex CLI 0.146.0 JSONL contract:
//   thread.started  -> thread_started (store agent_thread_id)
//   turn.started    -> phase "[agent]"
//   item.started    -> command_started / file_changed / file_read / mcp_started
//   item.completed  -> command_completed / file_changed / agent_message /
//                      mcp_completed / warning
//   turn.completed  -> usage (complete usage-total object)
//   turn.failed     -> error
//   error           -> error (sanitized)
// Unknown event types are ignored safely rather than treated as fatal.

const crypto = require('crypto');

// Codex retries a dropped stream five times by default. A provider that is
// refusing the request (out of credit, bad key) refuses every retry too, so
// the default budget turns one failure into a minute of silence. Three is
// enough to ride out a genuine blip without hiding a hard refusal.
const STREAM_MAX_RETRIES = 3;
const REQUEST_MAX_RETRIES = 3;

// Generate the Codex config that points the CLI DIRECTLY at OpenRouter.
// The user's key arrives per-turn as OPENROUTER_API_KEY. `agents.enabled
// = false` disables multi-agent in the first release (plan.md §8.6).
function buildCodexConfig({ openRouterBaseUrl, model, reasoningEffort }) {
  const provider = 'usernode_openrouter';
  // TOML-safe serialization (review P1): model/provider/base-url values are
  // interpolated into config.toml, so quotes, backslashes and newlines
  // must be escaped or rejected to prevent injecting extra TOML sections
  // (e.g. an attacker model id like `x"\n[[mcp_servers.malicious]]`).
  const tomlStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const safeModel = tomlStr(model);
  const safeProvider = tomlStr(provider);
  const safeBase = tomlStr((openRouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, ''));
  const safeEffort = reasoningEffort ? tomlStr(reasoningEffort) : '';
  return `model_provider = "${safeProvider}"
model = "${safeModel}"
${safeEffort ? `model_reasoning_effort = "${safeEffort}"` : ''}

[shell_environment_policy]
exclude = ["OPENROUTER_API_KEY"]

[agents]
enabled = false

[model_providers.${provider}]
name = "OpenRouter"
base_url = "${safeBase}"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
stream_max_retries = ${STREAM_MAX_RETRIES}
request_max_retries = ${REQUEST_MAX_RETRIES}
`;
}

// Codex wraps a provider failure it saw mid-stream in its own prefix. The
// wrapper says how the request died, never why, so it is stripped before the
// body underneath is classified.
const STREAM_WRAPPER = /^stream disconnected before completion:\s*/i;
// "Reconnecting... 2/5 (connection reset)" — attempt N of M.
const RECONNECT_ATTEMPT = /^Reconnecting\.\.\.\s+(\d+)\/(\d+)(?:\s|\(|$)/;

// Classify one provider failure message. Pure: no I/O, no database, no
// config — the same function runs in the JSONL normalizer, in the resume
// classifier and in the route that writes the turn's terminal message.
// Returns { code, retryable, requestedTokens, affordableTokens }; retryable
// means "another attempt could plausibly succeed", which for OpenRouter's
// max_tokens refusal means "succeed with a smaller reply limit".
function classifyProviderError(message) {
  const raw = String(message == null ? '' : message);
  const text = raw.replace(STREAM_WRAPPER, '').trim();
  const base = { retryable: false, requestedTokens: null, affordableTokens: null };
  if (text) {
    // OpenRouter's own wording for "this key has credit, but not enough for
    // a reply this long". It names both numbers, which is what makes a
    // smaller retry possible instead of a dead end.
    if (/requires more credits,? or fewer max_tokens/i.test(text)) {
      const amounts = text.match(/requested up to (\d+) tokens[\s\S]*?can only afford (\d+)/i);
      return {
        code: 'insufficient_credits_max_tokens',
        retryable: true,
        requestedTokens: amounts ? Number(amounts[1]) : null,
        affordableTokens: amounts ? Number(amounts[2]) : null,
      };
    }
    if (/\b402\b|insufficient credits|requires more credits/i.test(text)) {
      return { ...base, code: 'insufficient_credits' };
    }
    if (/\b429\b|rate limit/i.test(text)) return { ...base, code: 'rate_limited' };
    if (/\b401\b|\b403\b|unauthorized|invalid api key/i.test(text)) {
      return { ...base, code: 'credential_failure' };
    }
  }
  if (STREAM_WRAPPER.test(raw) || /stream (?:disconnected|closed)/i.test(raw)) {
    return { ...base, code: 'stream_disconnected' };
  }
  return { ...base, code: 'provider_error' };
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Only these fields may leave the worker journal for the attempt ledger or
// session status. Never persist request bodies, headers, keys or /key labels.
function sanitizeProviderRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const diagnostic = {
    model: typeof value.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(value.model)
      ? value.model : null,
    maxOutputTokens: tokenCount(value.maxOutputTokens),
    inputBytes: tokenCount(value.inputBytes),
    inputItems: tokenCount(value.inputItems),
    httpStatus: Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
      ? value.httpStatus : null,
    requestId: typeof value.requestId === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value.requestId)
      ? value.requestId : null,
  };
  if (Object.hasOwn(value, 'keyLookupStatus')) {
    diagnostic.keyLookupStatus = Number.isInteger(value.keyLookupStatus)
      && value.keyLookupStatus >= 100 && value.keyLookupStatus <= 599 ? value.keyLookupStatus : null;
    diagnostic.keyLimitUsd = typeof value.keyLimitUsd === 'number' && Number.isFinite(value.keyLimitUsd)
      && value.keyLimitUsd >= 0 ? value.keyLimitUsd : null;
    diagnostic.keyRemainingUsd = typeof value.keyRemainingUsd === 'number' && Number.isFinite(value.keyRemainingUsd)
      ? value.keyRemainingUsd : null;
    diagnostic.keyLimitReset = ['daily', 'weekly', 'monthly'].includes(value.keyLimitReset) ? value.keyLimitReset : null;
  }
  if (['openrouter_credits', 'openrouter_key_limit', 'openrouter_in_flight_budget'].includes(value.limitSource)) {
    diagnostic.limitSource = value.limitSource;
  }
  if (['in_flight_budget_exhausted', 'weight_exceeds_budget'].includes(value.limitReason)) {
    diagnostic.limitReason = value.limitReason;
  }
  if (typeof value.providerName === 'string' && /^[a-zA-Z0-9 ._:/()-]{1,80}$/.test(value.providerName)) {
    diagnostic.providerName = value.providerName;
  }
  if (tokenCount(value.retryAfterSeconds) != null) diagnostic.retryAfterSeconds = value.retryAfterSeconds;
  if (value.providerErrorStatus === 402) diagnostic.providerErrorStatus = 402;
  return diagnostic;
}

function providerFailureDiagnostics(result) {
  if (!result?.agentErrorCode) return null;
  const knownCodes = new Set([
    'insufficient_credits_max_tokens', 'insufficient_credits', 'rate_limited',
    'credential_failure', 'stream_disconnected', 'provider_error',
  ]);
  return {
    code: knownCodes.has(result.agentErrorCode) ? result.agentErrorCode : 'provider_error',
    requestedOutputTokens: tokenCount(result.requestedOutputTokens),
    affordableOutputTokens: tokenCount(result.affordableOutputTokens),
    request: sanitizeProviderRequest(result.providerRequest),
  };
}

function clipRawError(raw) {
  const text = String(raw || '').replace(STREAM_WRAPPER, '').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

// A refusal reports a requested ceiling, not a prediction of how long the
// agent's reply will be. A 402 alone also cannot establish account balance:
// a key can have its own spending limit. Attribute claims to OpenRouter.
function describeProviderError({
  code,
  requestedTokens = null,
  affordableTokens = null,
  requestDiagnostic = null,
  raw = '',
  includedKey = false,
} = {}) {
  const request = sanitizeProviderRequest(requestDiagnostic);
  const remedy = includedKey
    ? 'Check the credit included with Homeroom or add your own OpenRouter key in Settings.'
    : 'Check this key’s spending limit and your OpenRouter account balance.';
  if (code === 'insufficient_credits' || code === 'insufficient_credits_max_tokens') {
    if (request?.limitSource === 'openrouter_in_flight_budget') {
      const retry = request.retryAfterSeconds > 0
        ? `Try again in ${request.retryAfterSeconds} seconds.`
        : 'Wait for those requests to settle, then try again.';
      return `OpenRouter’s temporary spending budget is occupied by running or recently completed requests. ${retry}`;
    }
    if (request?.limitSource === 'openrouter_key_limit') {
      return `OpenRouter reports that this API key’s spending limit has been reached. ${includedKey
        ? remedy : 'Raise the key’s limit in OpenRouter or wait for it to reset.'}`;
    }
    if (request?.limitReason === 'weight_exceeds_budget') {
      return 'OpenRouter rejected the estimated cost of this request under its temporary spending budget. '
        + 'The request’s input and reply limit need to fit that budget, even when the account has credit. '
        + remedy;
    }
  }
  switch (code) {
    case 'insufficient_credits_max_tokens': {
      const requested = tokenCount(requestedTokens);
      const affordable = tokenCount(affordableTokens);
      const sent = request?.maxOutputTokens;
      const details = ['OpenRouter rejected the reply limit for this request.'];
      if (sent != null) details.push(`We sent a limit of ${sent.toLocaleString('en-US')} output tokens.`);
      if (requested != null) {
        details.push(`OpenRouter checked a limit of ${requested.toLocaleString('en-US')} tokens${affordable != null
          ? ` and reported an allowance of ${affordable.toLocaleString('en-US')} for this key` : ''}.`);
      } else if (affordable != null) {
        details.push(`OpenRouter reported an allowance of ${affordable.toLocaleString('en-US')} output tokens for this key.`);
      }
      if (request?.keyLimitUsd != null && request.keyRemainingUsd != null) {
        details.push(`The key reports $${request.keyRemainingUsd.toFixed(2)} remaining under its $${request.keyLimitUsd.toFixed(2)} spending limit.`);
      }
      details.push(remedy);
      return details.join(' ');
    }
    case 'insufficient_credits':
      return `OpenRouter refused payment for this request. ${remedy}`;
    case 'rate_limited':
      return 'OpenRouter rate-limited this request. Wait a moment, then send the request again.';
    case 'credential_failure':
      return includedKey
        ? 'OpenRouter rejected the key Homeroom uses for this app. Please report this so it can be fixed.'
        : 'OpenRouter rejected your API key. Check the key in Settings, then send the request again.';
    case 'stream_disconnected':
      return 'The connection to OpenRouter dropped before the reply finished. Send the request again to retry.';
    default: {
      const detail = clipRawError(raw);
      return detail
        ? `OpenRouter could not finish this request: ${detail}`
        : 'OpenRouter could not finish this request. Send the request again to retry.';
    }
  }
}

// Classify a Codex resume error to decide whether a fresh-thread retry is
// safe. Returns { retryFresh, reason }.
function classifyResumeError(stderr, exitCode) {
  void exitCode;
  const text = String(stderr || '');
  if (/thread not found|local rollout unavailable|session not found/i.test(text)) {
    return { retryFresh: true, reason: 'thread_missing' };
  }
  // The shared classifier decides the provider conditions; the broader
  // patterns beside it are the ones this resume path matched before it and
  // are kept so a stderr tail it already handled keeps its reason.
  const { code } = classifyProviderError(text);
  if (code === 'credential_failure' || /authentication|api key|invalid/i.test(text)) {
    return { retryFresh: false, reason: 'auth_failure' };
  }
  if (code === 'insufficient_credits' || code === 'insufficient_credits_max_tokens'
      || /payment|credit|insufficient/i.test(text)) {
    return { retryFresh: false, reason: 'insufficient_credits' };
  }
  if (code === 'rate_limited') {
    return { retryFresh: false, reason: 'rate_limited' };
  }
  return { retryFresh: false, reason: 'unknown_error' };
}

// Missing data stays null, never a false zero.
function normalizeNonNegativeInteger(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function verbFor(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'write' || k === 'created' || k === 'add' || k === 'add_file') return 'Writing';
  if (k === 'delete' || k === 'deleted' || k === 'remove') return 'Deleting';
  return 'Editing';
}

// Record a provider error until the CLI reports a terminal outcome. Explicit
// turn.completed clears recovered errors; turn.failed / a nonzero exit do not.
function emitError(state, msg) {
  const raw = msg != null ? String(msg) : 'Codex error';
  const classification = classifyProviderError(raw);
  // The CLI may keep only the SSE error's message, dropping its HTTP-like
  // code and metadata. The worker's observation preserves that evidence.
  if ((state.providerRequest?.httpStatus === 402 || state.providerRequest?.providerErrorStatus === 402)
      && ['provider_error', 'stream_disconnected'].includes(classification.code)) {
    classification.code = 'insufficient_credits';
  }
  state.ccIsError = true;
  // The raw provider text stays on the state: telemetry and the ledger's
  // error detail want what OpenRouter actually said, not the rewrite.
  state.agentError = raw;
  state.agentErrorCode = classification.code;
  if (classification.affordableTokens != null) {
    state.affordableOutputTokens = classification.affordableTokens;
  }
  if (classification.requestedTokens != null) {
    state.requestedOutputTokens = classification.requestedTokens;
  }
  const text = describeProviderError({ ...classification, raw, requestDiagnostic: state.providerRequest });
  // One provider failure can arrive twice: a top-level error, then the
  // turn.failed that follows it. Both still update the turn state; only
  // the repeated progress line is dropped, so dev chat shows it once.
  const duplicate = state.lastEmittedErrorText === text;
  state.lastEmittedErrorText = text;
  return {
    kind: 'error',
    text: duplicate ? null : text,
    errorMessage: raw,
    errorCode: classification.code,
    requestedOutputTokens: classification.requestedTokens,
    affordableOutputTokens: classification.affordableTokens,
  };
}

// Codex 0.146 emits some retry/fallback diagnostics in the same JSONL shapes
// it uses for fatal errors. They are not terminal: a turn.started or a retry
// follows. Keep them visible as provider-neutral warnings without poisoning
// the turn state or rendering a terminal failure.
function nonFatalDiagnostic(msg) {
  const text = String(msg || '');
  if (/^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata;/.test(text)) {
    return 'OpenRouter model metadata was unavailable; continuing with conservative defaults.';
  }
  const attempt = text.match(RECONNECT_ATTEMPT);
  if (attempt) {
    // Five identical "retrying…" lines read as a hang. Showing which attempt
    // this is makes the same sequence legible as bounded progress.
    const { code } = classifyProviderError(text);
    const cause = code === 'insufficient_credits' || code === 'insufficient_credits_max_tokens'
      ? 'OpenRouter rejected an attempt because of a payment or spending limit'
      : code === 'credential_failure' ? 'OpenRouter rejected an attempt’s API key'
        : 'OpenRouter connection interrupted';
    return `${cause}, retrying (attempt ${attempt[1]} of ${attempt[2]})…`;
  }
  return null;
}

function emitDiagnosticOrError(state, msg, { nonfatal = false } = {}) {
  const raw = String(msg || '');
  const warning = nonFatalDiagnostic(raw);
  if (warning || nonfatal) {
    return {
      kind: 'warning',
      text: `⚠ ${warning || `OpenRouter notice: ${clipRawError(raw)}`}`,
      diagnostic: RECONNECT_ATTEMPT.test(raw) ? 'provider_retry' : 'provider_warning',
    };
  }
  return emitError(state, msg);
}

/**
 * Sum one model request's usage, as the worker-local relay saw it finish,
 * into `state.relayUsage` (#3038).
 *
 * This is deliberately NOT folded into `inputTokens` / `outputTokens`: those
 * are the agent's own turn.completed totals, which the platform ledger
 * prices as a THREAD's running total. `relayUsage` is a separate, per-turn
 * sum, and it exists for the one case the agent cannot report: a turn
 * stopped before turn.completed. It is a floor — the request in flight at a
 * stop never finishes, so its usage is never seen.
 */
function addRelayUsage(state, usage) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  if (input == null && output == null) return;
  const sum = state.relayUsage || {
    requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
  };
  sum.requests += 1;
  sum.inputTokens += input ?? 0;
  sum.cachedInputTokens += count(usage?.cachedInputTokens) ?? 0;
  sum.outputTokens += output ?? 0;
  sum.reasoningOutputTokens += count(usage?.reasoningOutputTokens) ?? 0;
  state.relayUsage = sum;
}

// Parse one JSONL line into an array of normalized progress events
// (empty array when the line should be dropped: unknown/malformed). `state`
// accumulates the thread id, tool-use labels, error state and usage flags
// across lines. Multiple events may be returned (e.g. a file_change with
// several changed paths).
function normalizeCodexLine(line, state) {
  if (!line || !line.trim()) return [];
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }

  if (ev.type === 'usernode.openrouter.request') {
    state.providerRequest = sanitizeProviderRequest(ev.diagnostic);
    return [];
  }
  if (ev.type === 'usernode.openrouter.usage') {
    addRelayUsage(state, ev.usage);
    return [];
  }
  if (ev.type === 'thread.started') {
    const tid = ev.thread_id || ev.id;
    if (tid) state.agentThreadId = tid;
    // turn.started, which follows, prints the turn's marker.
    return [{ kind: 'thread_started', text: null, threadId: tid || null }];
  }
  if (ev.type === 'turn.started') {
    return [{ kind: 'phase', text: '[agent]', lifecycle: 'turn_started' }];
  }
  if (ev.type === 'item.started') {
    const item = ev.item || {};
    const t = item.type;
    if (t === 'command_execution' || t === 'function_call') {
      const cmd = item.command || '';
      const label = cmd ? `$ ${String(cmd).slice(0, 150)}` : 'Running command';
      if (item.id) state.toolUses.set(item.id, { label, kind: 'command' });
      return [{
        kind: 'command_started', text: label, lifecycle: 'started',
        itemId: item.id || null, toolName: 'command',
      }];
    }
    if (t === 'file_change' || t === 'file.edit' || t === 'file.write') {
      const path = item.path || item.file_path || '';
      return [{
        kind: 'file_changed', text: path ? `Editing ${path}` : 'Editing file',
        lifecycle: 'started', itemId: item.id || null,
        toolName: 'file_change', resourcePath: path || null,
      }];
    }
    if (t === 'file_read') {
      const path = item.path || '';
      return [{
        kind: 'file_read', text: path ? `Reading ${path}` : 'Reading file',
        lifecycle: 'started', itemId: item.id || null,
        toolName: 'file_read', resourcePath: path || null,
      }];
    }
    if (t === 'mcp_tool_call') {
      const name = item.tool || item.server || 'browser';
      return [{
        kind: 'mcp_started', text: `Using ${name}`, lifecycle: 'started',
        itemId: item.id || null, toolName: String(name),
      }];
    }
    return [];
  }
  if (ev.type === 'item.completed') {
    const item = ev.item || {};
    const t = item.type;
    if (t === 'agent_message') {
      const txt = item.text;
      if (txt) {
        return [{
          kind: 'agent_message',
          text: String(txt).slice(0, 300),
          fullText: String(txt),
          lifecycle: 'completed',
          itemId: item.id || null,
        }];
      }
      return [];
    }
    if (t === 'error') {
      // In pinned Codex 0.146.0, ErrorItem explicitly means a nonfatal
      // notice (including warnings, deprecations and model reroutes).
      // turn.failed / the process exit supplies the terminal verdict.
      return [emitDiagnosticOrError(state, item.message || 'OpenRouter notice', { nonfatal: true })];
    }
    if (t === 'file_change') {
      const changes = Array.isArray(item.changes) && item.changes.length
        ? item.changes
        : null;
      if (!changes) {
        const path = item.path || '';
        return [{
          kind: 'file_changed', text: path ? `Editing ${path}` : 'Editing file',
          lifecycle: 'completed', itemId: item.id || null,
          toolName: 'file_change', resourcePath: path || null, countCompletion: true,
        }];
      }
      return changes.map((change, index) => ({
        kind: 'file_changed',
        text: `${verbFor(change.kind)} ${change.path}`,
        lifecycle: 'completed',
        itemId: item.id || null,
        toolName: 'file_change',
        resourcePath: change.path || null,
        countCompletion: index === 0,
      }));
    }
    if (t === 'file_read') {
      const path = item.path || item.file_path || '';
      return [{
        kind: 'file_read_completed',
        // Completion was previously silent; telemetry observes it without
        // adding a duplicate progress line to the user-visible stream.
        text: null,
        status: item.status || null,
        lifecycle: 'completed',
        itemId: item.id || null,
        toolName: 'file_read', resourcePath: path || null, countCompletion: true,
      }];
    }
    if (t === 'command_execution' || t === 'function_call') {
      const summary = summarizeResult(item.aggregated_output);
      return [{
        kind: 'command_completed',
        text: `  ⎿ ${summary}`,
        exitCode: item.exit_code != null ? item.exit_code : null,
        status: item.status || null,
        lifecycle: 'completed',
        itemId: item.id || null,
        toolName: 'command',
        countCompletion: true,
      }];
    }
    if (t === 'mcp_tool_call') {
      return [{
        kind: 'mcp_completed',
        text: item.status ? `MCP ${item.status}` : 'MCP complete',
        status: item.status || null,
        lifecycle: 'completed',
        itemId: item.id || null,
        toolName: String(item.tool || item.server || 'mcp'),
        countCompletion: true,
      }];
    }
    return [];
  }
  if (ev.type === 'turn.completed') {
    // A provider error can recover inside the CLI. Keeping its old flag
    // after explicit success made the host fail and sometimes re-run work
    // that had completed. Clear only provider state; host fatal errors and
    // the runner's eventual exit status remain independent failure gates.
    state.ccIsError = false;
    state.agentError = null;
    state.agentErrorCode = null;
    state.requestedOutputTokens = null;
    state.affordableOutputTokens = null;
    state.lastEmittedErrorText = null;
    const u = ev.usage || {};
    state.usageSeen = true;
    state.cacheWriteInputTokens = normalizeNonNegativeInteger(u.cache_write_input_tokens);
    return [{
      kind: 'usage',
      text: '[done]',
      usage: {
        inputTokens: normalizeNonNegativeInteger(u.input_tokens),
        cachedInputTokens: normalizeNonNegativeInteger(u.cached_input_tokens),
        cacheWriteInputTokens: normalizeNonNegativeInteger(u.cache_write_input_tokens),
        outputTokens: normalizeNonNegativeInteger(u.output_tokens),
        reasoningOutputTokens: normalizeNonNegativeInteger(u.reasoning_output_tokens),
      },
    }];
  }
  if (ev.type === 'turn.failed') {
    const msg = ev.error && ev.error.message != null ? ev.error.message : (ev.message || 'Codex turn failed');
    return [emitError(state, msg)];
  }
  if (ev.type === 'error') {
    const msg = ev.message != null ? ev.message : (ev.error && ev.error.message) || 'OpenRouter error';
    return [emitDiagnosticOrError(state, msg)];
  }
  // Unknown event — ignore safely.
  return [];
}

function summarizeResult(result) {
  if (result == null) return 'ok';
  if (typeof result === 'string') {
    const lines = result.split('\n');
    if (lines.length > 3) return `${lines.length} lines`;
    const last = [...lines].reverse().find((l) => l.trim()) || '';
    const t = last.trim().replace(/\s+/g, ' ');
    return t.length > 120 ? `${t.slice(0, 117)}…` : t || 'ok';
  }
  return 'ok';
}

function newCodexState() {
  return {
    agentThreadId: null,
    toolUses: new Map(),
    ccIsError: false,
    agentError: null,
    agentErrorCode: null,
    requestedOutputTokens: null,
    affordableOutputTokens: null,
    providerRequest: null,
    relayUsage: null,
    lastEmittedErrorText: null,
    usageSeen: false,
    cacheWriteInputTokens: null,
  };
}

module.exports = {
  buildCodexConfig,
  classifyProviderError,
  classifyResumeError,
  describeProviderError,
  providerFailureDiagnostics,
  normalizeCodexLine,
  nonFatalDiagnostic,
  summarizeResult,
  newCodexState,
};

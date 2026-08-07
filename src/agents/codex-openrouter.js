'use strict';

// Codex CLI (codex_openrouter) adapter (plan.md §9, §10). Owns:
//   - Codex config generation (codex config.toml pointing DIRECTLY at
//     OpenRouter; the user's key is injected per-turn as OPENROUTER_API_KEY
//     and is visible to the worker's code by design — see the Settings UI
//     disclosure).
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
//                      mcp_completed / error
//   turn.completed  -> usage (complete usage-total object)
//   turn.failed     -> error
//   error           -> error (sanitized)
// Unknown event types are ignored safely rather than treated as fatal.

const crypto = require('crypto');

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

[agents]
enabled = false

[model_providers.${provider}]
name = "OpenRouter"
base_url = "${safeBase}"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
`;
}

// Classify a Codex resume error to decide whether a fresh-thread retry is
// safe. Returns { retryFresh, reason }.
function classifyResumeError(stderr, exitCode) {
  const text = String(stderr || '').toLowerCase();
  if (/thread not found|local rollout unavailable|session not found/.test(text)) {
    return { retryFresh: true, reason: 'thread_missing' };
  }
  if (/401|unauthorized|authentication|api key|invalid/.test(text)) {
    return { retryFresh: false, reason: 'auth_failure' };
  }
  if (/402|payment|credit|insufficient/.test(text)) {
    return { retryFresh: false, reason: 'insufficient_credits' };
  }
  if (/429|rate limit/.test(text)) {
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

// Emit an error event and mark the running state as errored so a later
// turn.failed / terminal exit marker cannot be reported as a clean success.
function emitError(state, msg) {
  state.ccIsError = true;
  state.agentError = msg != null ? String(msg) : null;
  return {
    kind: 'error',
    text: `[agent_failed] ${String(msg == null ? 'Codex error' : msg).slice(0, 200)}`,
    errorMessage: msg != null ? String(msg) : 'Codex error',
  };
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

  if (ev.type === 'thread.started') {
    const tid = ev.thread_id || ev.id;
    if (tid) state.agentThreadId = tid;
    return [{ kind: 'thread_started', text: '[agent]', threadId: tid || null }];
  }
  if (ev.type === 'turn.started') {
    return [{ kind: 'phase', text: '[agent]' }];
  }
  if (ev.type === 'item.started') {
    const item = ev.item || {};
    const t = item.type;
    if (t === 'command_execution' || t === 'function_call') {
      const cmd = item.command || '';
      const label = cmd ? `$ ${String(cmd).slice(0, 150)}` : 'Running command';
      if (item.id) state.toolUses.set(item.id, { label, kind: 'command' });
      return [{ kind: 'command_started', text: label }];
    }
    if (t === 'file_change' || t === 'file.edit' || t === 'file.write') {
      const path = item.path || item.file_path || '';
      return [{ kind: 'file_changed', text: path ? `Editing ${path}` : 'Editing file' }];
    }
    if (t === 'file_read') {
      const path = item.path || '';
      return [{ kind: 'file_read', text: path ? `Reading ${path}` : 'Reading file' }];
    }
    if (t === 'mcp_tool_call') {
      const name = item.tool || item.server || 'browser';
      return [{ kind: 'mcp_started', text: `Using ${name}` }];
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
        }];
      }
      return [];
    }
    if (t === 'error') {
      return [emitError(state, item.message || 'Codex error')];
    }
    if (t === 'file_change') {
      const changes = Array.isArray(item.changes) && item.changes.length
        ? item.changes
        : null;
      if (!changes) {
        const path = item.path || '';
        return [{ kind: 'file_changed', text: path ? `Editing ${path}` : 'Editing file' }];
      }
      return changes.map((change) => ({
        kind: 'file_changed',
        text: `${verbFor(change.kind)} ${change.path}`,
      }));
    }
    if (t === 'command_execution' || t === 'function_call') {
      const summary = summarizeResult(item.aggregated_output);
      return [{
        kind: 'command_completed',
        text: `  ⎿ ${summary}`,
        exitCode: item.exit_code != null ? item.exit_code : null,
        status: item.status || null,
      }];
    }
    if (t === 'mcp_tool_call') {
      return [{
        kind: 'mcp_completed',
        text: item.status ? `MCP ${item.status}` : 'MCP complete',
      }];
    }
    return [];
  }
  if (ev.type === 'turn.completed') {
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
    const msg = ev.message != null ? ev.message : (ev.error && ev.error.message) || 'Codex error';
    return [emitError(state, msg)];
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
    usageSeen: false,
    cacheWriteInputTokens: null,
  };
}

module.exports = {
  buildCodexConfig,
  classifyResumeError,
  normalizeCodexLine,
  summarizeResult,
  newCodexState,
};

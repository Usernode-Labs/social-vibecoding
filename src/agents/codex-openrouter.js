'use strict';

// Codex CLI (codex_openrouter) adapter (plan.md §9, §10). Owns:
//   - Codex config generation (platform-owned config.toml pointing at the
//     relay; raw key never in the worker).
//   - The JSONL event parser that normalizes codex exec --json output to
//     the backend-neutral progress vocabulary (services/agent-events.js)
//     the worker.js consumer already understands.
//   - Resume-failure classification.
//
// Codex emits one JSON object per line (--json). Event shapes we map:
//   thread.started   -> thread_started (store agent_thread_id)
//   turn.started     -> phase "[agent]"
//   item.started     -> command_started / file_changed / file_read
//   item.completed   -> command_completed / tool_result
//   agent message    -> agent_message
//   turn.completed   -> usage + turn_completed
//   turn.failed      -> error
//   error            -> error (sanitized)
// Unknown event types are ignored safely rather than treated as fatal.

const crypto = require('crypto');

// Generate the platform-owned Codex config that points the CLI at the
// Usernode relay. The worker never holds the OpenRouter key; the relay
// injects it. `agents.enabled = false` disables multi-agent in the first
// release (plan.md §8.6).
function buildCodexConfig({ relayBaseUrl, model, reasoningEffort }) {
  const provider = 'usernode_openrouter';
  return `model_provider = "${provider}"
model = "${model}"
${reasoningEffort ? `model_reasoning_effort = "${reasoningEffort}"` : ''}

[agents]
enabled = false

[model_providers.${provider}]
name = "Usernode OpenRouter"
base_url = "${relayBaseUrl.replace(/\/$/, '')}"
wire_api = "responses"
env_key = "USERNODE_AGENT_TOKEN"
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

// Parse one JSONL line into a normalized progress event, or null if it
// should be dropped (unknown/malformed). `state` accumulates the thread
// id and tool-use labels across lines (mirrors worker.js applyStreamEvent).
function normalizeCodexLine(line, state) {
  if (!line || !line.trim()) return null;
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }

  // Thread id: codex emits a thread/session id we can resume later.
  if (ev.type === 'thread.started' || (ev.type === 'thread' && ev.id)) {
    const tid = ev.thread_id || ev.id || ev.session_id;
    if (tid) state.agentThreadId = tid;
    return { kind: 'thread_started', text: '[agent]', threadId: tid };
  }
  if (ev.type === 'turn.started') {
    return { kind: 'phase', text: '[agent]' };
  }
  if (ev.type === 'item.started' || ev.type === 'item') {
    const item = ev.item || ev;
    const t = item.type || item.kind;
    if (t === 'command_execution' || t === 'command' || t === 'function_call') {
      const cmd = item.command || item.arguments?.command || item.name || '';
      const label = cmd ? `$ ${String(cmd).slice(0, 150)}` : 'Running command';
      if (item.id) state.toolUses.set(item.id, { label });
      return { kind: 'command_started', text: label };
    }
    if (t === 'file_change' || t === 'file.edit' || t === 'file.write') {
      const path = item.path || item.file_path || item.arguments?.path || '';
      const op = item.operation || (t === 'file.write' ? 'Writing' : 'Editing');
      return { kind: 'file_changed', text: path ? `${op} ${path}` : `${op} file` };
    }
    if (t === 'file.read' || t === 'file_read') {
      const path = item.path || item.file_path || '';
      return { kind: 'file_read', text: path ? `Reading ${path}` : 'Reading file' };
    }
    if (t === 'mcp_tool_call' || t === 'mcp') {
      const name = item.name || item.tool || 'browser';
      return { kind: 'mcp_started', text: `Using ${name}` };
    }
  }
  if (ev.type === 'item.completed' || ev.type === 'item_result') {
    const item = ev.item || ev;
    const t = item.type || item.kind;
    // agent_message: the agent's final text output (review F3). Without
    // this the UI shows empty progress because 0.146.0 emits the agent
    // message inside item.completed, not as a top-level message event.
    if (t === 'agent_message') {
      const txt = item.message || item.content || item.text || '';
      if (txt) return { kind: 'agent_message', text: String(txt).slice(0, 300) };
    }
    if (t === 'error') {
      const msg = item.message || item.error || 'Codex error';
      return { kind: 'error', text: `[agent_failed] ${String(msg).slice(0, 200)}` };
    }
    if (t === 'command_execution' || t === 'command' || t === 'function_call') {
      const summary = summarizeResult(item.output || item.result || item.content);
      return { kind: 'command_completed', text: `  ⎿ ${summary}` };
    }
    if (item.tool_use_id && state.toolUses.has(item.tool_use_id)) {
      const prior = state.toolUses.get(item.tool_use_id);
      const summary = summarizeResult(item.output || item.result || item.content);
      state.toolUses.delete(item.tool_use_id);
      return { kind: 'tool_result', text: `  ⎿ ${summary}` };
    }
  }
  if (ev.type === 'message' || ev.type === 'agent_message') {
    const txt = ev.content || ev.text || ev.message || '';
    if (txt) return { kind: 'agent_message', text: String(txt).slice(0, 300) };
  }
  if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    return {
      kind: 'usage',
      text: '[done]',
      usage: {
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cost: u.cost || null,
        model: ev.model || null,
      },
    };
  }
  if (ev.type === 'turn.failed' || ev.type === 'error') {
    const msg = ev.error?.message || ev.message || 'Codex turn failed';
    return { kind: 'error', text: `[agent_failed] ${String(msg).slice(0, 200)}` };
  }
  // Unknown event — ignore safely.
  return null;
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
  return { agentThreadId: null, toolUses: new Map() };
}

module.exports = {
  buildCodexConfig,
  classifyResumeError,
  normalizeCodexLine,
  summarizeResult,
  newCodexState,
};

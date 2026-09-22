'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/services/worker');

test('evidence worker reports the last browser tool without retaining its inputs or results', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  const progress = () => {};
  const privateUrl = 'https://example.invalid/?token=private-token';
  worker.parseLine('__USERNODE_PHASE__ evidence_browser_bootstrap', progress, state);
  worker.parseLine(JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'private-session',
    mcp_servers: [{ name: 'evidence' }, { name: 'browser_member' }, { name: 'browser_admin' }],
    tools: ['private-tool-definition'],
  }), progress, state);
  worker.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', private: 'private-token' } }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'private-tool-id',
      name: 'mcp__browser_member__browser_navigate', input: { url: privateUrl },
    }] },
  }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'private-tool-id', is_error: true,
      content: `Page said private-token at ${privateUrl}`,
    }] },
  }), progress, state);

  assert.deepEqual(events, [
    { kind: 'runner_phase', phase: 'evidence_browser_bootstrap' },
    { kind: 'provider_init', mcpServerCount: 3, toolDefinitionCount: 1 },
    { kind: 'first_stream' },
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'browser_navigate', persona: 'member' },
    { kind: 'tool_end', sequence: 1, tool: 'browser_navigate', persona: 'member', outcome: 'error' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|example\.invalid|session|url/i);
});

test('evidence diagnostics classify unknown tools and phases without copying their names', () => {
  const events = [];
  const state = worker.newWatchState();
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  worker.parseLine('__USERNODE_PHASE__ secret-phase private-token', () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'x', name: 'private-token', input: { password: 'private-token' },
    }] },
  }), () => {}, state);
  assert.deepEqual(events, [
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'other' },
  ]);
});

test('Codex MCP events report the tool lifecycle without recording its arguments', () => {
  const events = [];
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.evidenceDiagnosticObserver = (event) => events.push(event);
  worker.parseLine(JSON.stringify({ type: 'turn.started' }), () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'item.started', item: {
      id: 'private-item', type: 'mcp_tool_call',
      tool: 'evidence.evidence_get_context', arguments: { token: 'private-token' },
    },
  }), () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'item.completed', item: {
      id: 'private-item', type: 'mcp_tool_call',
      tool: 'evidence.evidence_get_context', status: 'completed',
      result: { token: 'private-token' },
    },
  }), () => {}, state);
  assert.deepEqual(events, [
    { kind: 'provider_init' },
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'evidence_get_context' },
    { kind: 'tool_end', sequence: 1, tool: 'evidence_get_context', outcome: 'ok' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

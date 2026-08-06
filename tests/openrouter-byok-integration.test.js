'use strict';
// Vertical integration test for the Codex/OpenRouter path (plan.md review
// #4): feeds an AUTHENTIC pinned-Codex JSONL stream through worker.js
// parseLine and an AUTHENTIC OpenRouter SSE response through the usage
// parser + settlement, and asserts the full chain (thread extraction,
// progress, agent message, usage/cost) works.

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');
const { parseSseFrames, extractUsage } = require('../src/services/openrouter-usage');

// Authentic pinned-Codex 0.146.0 JSONL (captured from a real run).
const AUTHENTIC_CODEX_JSONL = [
  { type: 'thread.started', thread_id: '019fd774-7674-7252-806d-2aac62a95cc5' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'mock' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', message: 'I updated the test file to pass.' } },
  { type: 'turn.completed', usage: { input_tokens: 314, output_tokens: 128 }, model: 'openai/gpt-5.3-codex' },
];

test('vertical: authentic Codex JSONL → thread id + progress + final message', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  for (const ev of AUTHENTIC_CODEX_JSONL) {
    worker.parseLine(JSON.stringify(ev), (t) => progress.push(t), state);
  }
  assert.equal(state.agentThreadId, '019fd774-7674-7252-806d-2aac62a95cc5', 'thread id extracted for resume');
  assert.ok(progress.includes('[agent]'), 'turn start renders a phase marker');
  assert.ok(progress.some((t) => t.includes('I updated the test file')), 'agent message surfaces');
});

// Authentic OpenRouter Responses SSE — data-only frames, usage inside
// response.usage on response.done.
function authenticOpenRouterSse() {
  return [
    'data: {"type":"response.created","response":{"id":"gen_req_123","model":"openai/gpt-5.3-codex"}}',
    '',
    'data: {"type":"response.output_text.delta","delta":"Updating"}',
    '',
    'data: {"type":"response.output_text.delta","delta":" files..."}',
    '',
    'data: {"type":"response.completed","response":{"id":"gen_req_123","usage":{"input_tokens":412,"output_tokens":201}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
}

test('vertical: authentic OpenRouter SSE → usage parsed for settlement', () => {
  const parsed = parseSseFrames(authenticOpenRouterSse());
  const usageEvents = parsed.events
    .map((e) => extractUsage(e.event, e.data))
    .filter(Boolean);
  assert.ok(usageEvents.length >= 1, 'terminal usage event parsed');
  const u = usageEvents[usageEvents.length - 1];
  assert.equal(u.requestId, 'gen_req_123');
  assert.equal(u.inputTokens, 412);
  assert.equal(u.outputTokens, 201);
});

test('vertical: response.done with response.usage + cost settles', () => {
  const data = { type: 'response.done', response: { id: 'gen_req_456', model: 'm', usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.02 } };
  const u = extractUsage('response.done', data);
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 5);
  assert.equal(u.cost, 0.02);
  assert.equal(u.requestId, 'gen_req_456');
});

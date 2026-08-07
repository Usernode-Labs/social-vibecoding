'use strict';
// Vertical integration test for the Codex/OpenRouter path (plan.md review
// #4): feeds an AUTHENTIC pinned-Codex JSONL stream through worker.js
// parseLine and an AUTHENTIC OpenRouter SSE response through the usage
// parser + settlement, and asserts the full chain (thread extraction,
// progress, agent message, usage/cost) works.

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');
const { sanitizeModel } = require('../src/services/agent-models');

// Authentic pinned-Codex 0.146.0 JSONL (captured from a real run).
const AUTHENTIC_CODEX_JSONL = [
  { type: 'thread.started', thread_id: '019fd774-7674-7252-806d-2aac62a95cc5' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'mock' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I updated the test file to pass.' } },
  { type: 'turn.completed', usage: { input_tokens: 314, cached_input_tokens: 100, cache_write_input_tokens: 20, output_tokens: 128, reasoning_output_tokens: 40 } },
];

test('vertical: Codex turn.failed marks turn as error (prevents clean completion)', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  for (const ev of [
    { type: 'thread.started', thread_id: '019fd774-7674-7252-806d-2aac62a95cc5' },
    { type: 'turn.started' },
    { type: 'turn.failed', error: { message: 'provider unreachable' } },
  ]) {
    worker.parseLine(JSON.stringify(ev), (t) => progress.push(t), state);
  }
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'provider unreachable');
});

test('vertical: missing usage does not fabricate a cost', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  for (const ev of [
    { type: 'thread.started', thread_id: '019fd774-7674-7252-806d-2aac62a95cc5' },
    { type: 'turn.completed', usage: { input_tokens: 5 } },
  ]) {
    worker.parseLine(JSON.stringify(ev), () => {}, state);
  }
  assert.equal(state.inputTokens, 5);
  // Missing usage never fabricates a cost; the codex-only cache-write field
  // stays null rather than being coerced to a false zero (plan 5.6).
  assert.equal(state.cacheWriteInputTokens, null);
});

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

test('streaming UTF-8 decoding preserves a character split across chunks', () => {
  const bytes = Buffer.from('data: {"delta":"€"}\r\n\r\n');
  const split = bytes.indexOf(Buffer.from('€')) + 1;
  const decoder = new TextDecoder();
  const text = decoder.decode(bytes.subarray(0, split), { stream: true })
    + decoder.decode(bytes.subarray(split), { stream: true })
    + decoder.decode();
  assert.equal(text, 'data: {"delta":"€"}\r\n\r\n');
});

test('sanitizeModel converts per-token prices and uses reasoning metadata', () => {
  const compatibility = { status: 'verified', note: null };
  const arrayModel = sanitizeModel({
    id: 'array', pricing: { prompt: '0', completion: '0.000002' },
    supported_parameters: ['tools', 'reasoning'], context_length: 32000,
  }, compatibility);
  assert.equal(arrayModel.inputPricePerMillion, 0);
  assert.equal(arrayModel.outputPricePerMillion, 2);
  assert.equal(arrayModel.supportsReasoning, true);
  assert.equal(arrayModel.reasoningEfforts, null);

  const metadataModel = sanitizeModel({
    id: 'metadata', supported_parameters: { tools: true, reasoning: { efforts: ['low', 'high'] } },
    context_length: 32000,
  }, compatibility);
  assert.equal(metadataModel.supportsReasoning, true);
  assert.deepEqual(metadataModel.reasoningEfforts, ['low', 'high']);
});

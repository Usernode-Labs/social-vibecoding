'use strict';
// Tests for the OpenRouter BYOK / Codex server-side pieces (plan.md).
// Covers: the Codex JSONL normalizer, the codex config builder, resume-error
// classification, and the registry codex_openrouter entry.
//
// Run with: node --test tests/openrouter-byok.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const codex = require('../src/agents/codex-openrouter');
const registry = require('../src/agents/registry');

// ── Registry ──────────────────────────────────────────────────────────
test('registry resolves codex_openrouter and its runner', () => {
  assert.equal(registry.resolveBackend('codex_openrouter'), 'codex_openrouter');
  assert.equal(registry.getBackend('codex_openrouter').runner, '/usr/local/bin/run-codex-agent.sh');
  assert.equal(registry.providerFor('codex_openrouter'), 'openrouter');
});

// ── Codex config builder ──────────────────────────────────────────────
test('buildCodexConfig points directly at OpenRouter and disables agents', () => {
  const cfg = codex.buildCodexConfig({
    openRouterBaseUrl: 'https://openrouter.ai/api/v1/',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
  assert.match(cfg, /model_provider = "usernode_openrouter"/);
  assert.match(cfg, /model = "openai\/gpt-5.3-codex"/);
  assert.match(cfg, /base_url = "https:\/\/openrouter.ai\/api\/v1"/);
  assert.match(cfg, /env_key = "OPENROUTER_API_KEY"/);
  assert.match(cfg, /\[agents\][\s\S]*enabled = false/);
  assert.match(cfg, /model_reasoning_effort = "high"/);
});

test('buildCodexConfig omits reasoning effort when not provided', () => {
  const cfg = codex.buildCodexConfig({ openRouterBaseUrl: 'http://x/v1', model: 'm' });
  assert.ok(!/model_reasoning_effort/.test(cfg), 'no reasoning effort line when unset');
});

// ── Codex JSONL normalizer ───────────────────────────────────────────
test('normalizeCodexLine maps thread.started to thread_started + stores thread id', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'thr-0199' }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'thread_started');
  assert.equal(state.agentThreadId, 'thr-0199');
});

test('normalizeCodexLine maps a command item to $ <command>', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.started', item: { type: 'command_execution', command: 'npm test' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'command_started');
  assert.match(ev[0].text, /^\$ npm test/);
});

test('normalizeCodexLine maps a file edit to Editing <path>', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.started', item: { type: 'file.edit', path: 'src/app.js' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'file_changed');
  assert.match(ev[0].text, /Editing src\/app\.js/);
});

test('normalizeCodexLine maps turn.completed to usage + [done] with pinned fields', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 30,
      cache_write_input_tokens: 5,
      output_tokens: 50,
      reasoning_output_tokens: 12,
    },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'usage');
  assert.equal(ev[0].text, '[done]');
  assert.equal(ev[0].usage.inputTokens, 100);
  assert.equal(ev[0].usage.cachedInputTokens, 30);
  assert.equal(ev[0].usage.cacheWriteInputTokens, 5);
  assert.equal(ev[0].usage.outputTokens, 50);
  assert.equal(ev[0].usage.reasoningOutputTokens, 12);
  // The pinned contract has no dollar cost or model id here.
  assert.equal('cost' in ev[0].usage, false);
  assert.equal('model' in ev[0].usage, false);
});

test('normalizeCodexLine returns empty array for malformed JSON and unknown events', () => {
  const state = codex.newCodexState();
  assert.deepEqual(codex.normalizeCodexLine('not json', state), []);
  assert.deepEqual(codex.normalizeCodexLine(JSON.stringify({ type: 'future_event' }), state), []);
});

test('normalizeCodexLine maps turn.failed to an error event', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'error');
  assert.match(ev[0].text, /\[agent_failed\]/);
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'boom');
});

test('normalizeCodexLine maps item.completed with agent_message via item.text (real 0.146.0)', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I edited the file.' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'agent_message');
  assert.equal(ev[0].text, 'I edited the file.');
  assert.equal(ev[0].fullText, 'I edited the file.');
});

test('normalizeCodexLine maps item.completed with error type (real 0.146.0)', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed', item: { id: 'item_0', type: 'error', message: '401 Unauthorized' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'error');
  assert.match(ev[0].text, /401/);
  assert.equal(state.ccIsError, true);
});

// ── Resume-error classification ───────────────────────────────────────
test('classifyResumeError: thread-missing is retry-fresh; auth/credit/rate are not', () => {
  assert.equal(codex.classifyResumeError('thread not found', 1).retryFresh, true);
  assert.equal(codex.classifyResumeError('401 unauthorized', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('402 insufficient credits', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('429 rate limit', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('something weird', 1).retryFresh, false);
});

// ── Canonical OpenRouter API base (Commit 2 / plan 4) ────────────────
const { canonicalOpenRouterApiBase } = require('../src/config');

test('canonicalOpenRouterApiBase: default HTTPS base is canonical', () => {
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1', {}), 'https://openrouter.ai/api/v1');
});

test('canonicalOpenRouterApiBase: trailing slashes are stripped', () => {
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1/', {}), 'https://openrouter.ai/api/v1');
  assert.equal(canonicalOpenRouterApiBase('https://example.com/gw///', {}), 'https://example.com/gw');
});

test('canonicalOpenRouterApiBase: HTTPS custom path is accepted', () => {
  assert.equal(canonicalOpenRouterApiBase('https://proxy.example.com/openrouter/v1', {}), 'https://proxy.example.com/openrouter/v1');
});

test('canonicalOpenRouterApiBase: username/password rejected', () => {
  assert.equal(canonicalOpenRouterApiBase('https://user:pass@openrouter.ai/api/v1', {}), null);
});

test('canonicalOpenRouterApiBase: query params and fragments rejected', () => {
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1?x=1', {}), null);
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1#frag', {}), null);
});

test('canonicalOpenRouterApiBase: remote HTTP rejected even with insecure flag', () => {
  assert.equal(canonicalOpenRouterApiBase('http://openrouter.ai/api/v1', { isLocalDev: true, allowInsecureBase: 'true' }), null);
});

test('canonicalOpenRouterApiBase: loopback HTTP rejected without both local-dev conditions', () => {
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', { isLocalDev: false, allowInsecureBase: 'true' }), null);
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', { isLocalDev: true, allowInsecureBase: 'false' }), null);
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', {}), null);
});

test('canonicalOpenRouterApiBase: loopback HTTP accepted only with both local-dev conditions', () => {
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', { isLocalDev: true, allowInsecureBase: 'true' }), 'http://localhost:3000');
  assert.equal(canonicalOpenRouterApiBase('http://127.0.0.1:3000', { isLocalDev: true, allowInsecureBase: 'true' }), 'http://127.0.0.1:3000');
});

test('canonicalOpenRouterApiBase: empty or invalid values rejected', () => {
  assert.equal(canonicalOpenRouterApiBase('', {}), null);
  assert.equal(canonicalOpenRouterApiBase('not a url', {}), null);
  assert.equal(canonicalOpenRouterApiBase(null, {}), null);
});

// ── Pinned 0.146.0 JSONL contract (Commit 3) ─────────────────────────
test('normalizeCodexLine: full usage-total object retains cached/cache-write/reasoning', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 1000, cached_input_tokens: 400,
      cache_write_input_tokens: 90, output_tokens: 350,
      reasoning_output_tokens: 120,
    },
  }), state);
  assert.equal(evs[0].usage.inputTokens, 1000);
  assert.equal(evs[0].usage.cachedInputTokens, 400);
  assert.equal(evs[0].usage.cacheWriteInputTokens, 90);
  assert.equal(evs[0].usage.outputTokens, 350);
  assert.equal(evs[0].usage.reasoningOutputTokens, 120);
  assert.equal(state.usageSeen, true);
  assert.equal(state.cacheWriteInputTokens, 90);
});

test('normalizeCodexLine: missing usage stays null, not a false zero', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 10 },
  }), state);
  assert.equal(evs[0].usage.inputTokens, 10);
  assert.equal(evs[0].usage.outputTokens, null);
  assert.equal(evs[0].usage.cachedInputTokens, null);
  assert.equal(state.usageSeen, true);
});

test('normalizeCodexLine: command_completed uses aggregated_output + exit_code/status', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'c1', type: 'command_execution', aggregated_output: 'ok\n', exit_code: 0, status: 'completed' },
  }), state);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'command_completed');
  assert.equal(evs[0].exitCode, 0);
  assert.equal(evs[0].status, 'completed');
});

test('normalizeCodexLine: multiple file changes emit one event per path', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'f1', type: 'file_change', changes: [
      { kind: 'edit', path: 'a.js' },
      { kind: 'write', path: 'b.txt' },
    ] },
  }), state);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, 'file_changed');
  assert.match(evs[0].text, /Editing a\.js/);
  assert.match(evs[1].text, /Writing b\.txt/);
});

test('normalizeCodexLine: top-level error sets terminal error state', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({ type: 'error', message: 'fatal' }), state);
  assert.equal(evs[0].kind, 'error');
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'fatal');
});

test('normalizeCodexLine: turn.failed influences final status even with later exit marker', () => {
  const state = codex.newCodexState();
  codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'backend exploded' } }), state);
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'backend exploded');
});

test('normalizeCodexLine: unknown future events are ignored (empty array)', () => {
  const state = codex.newCodexState();
  assert.deepEqual(codex.normalizeCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'some_future_kind' } }), state), []);
  assert.deepEqual(codex.normalizeCodexLine(JSON.stringify({ type: 'turn.halted' }), state), []);
});

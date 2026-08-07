'use strict';
// Tests for the OpenRouter BYOK / Codex server-side pieces (plan.md).
// Covers: the scoped agent-proxy token, the Codex JSONL normalizer, the
// OpenRouter SSE usage parser, the codex config builder, resume-error
// classification, and the registry codex_openrouter entry.
//
// Run with: node --test tests/openrouter-byok.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const platformJwt = require('../src/services/platform-jwt');
const codex = require('../src/agents/codex-openrouter');
const { parseSseFrames, extractUsage } = require('../src/services/openrouter-usage');
const registry = require('../src/agents/registry');

// ── Registry ──────────────────────────────────────────────────────────
test('registry resolves codex_openrouter and its runner', () => {
  assert.equal(registry.resolveBackend('codex_openrouter'), 'codex_openrouter');
  assert.equal(registry.getBackend('codex_openrouter').runner, '/usr/local/bin/run-codex-agent.sh');
  assert.equal(registry.providerFor('codex_openrouter'), 'openrouter');
});

// ── Scoped agent-proxy token ──────────────────────────────────────────
test('signAgentProxyToken / verifyAgentProxyToken round-trip and are scoped', () => {
  process.env.WORKER_JWT_SECRET = 'test-worker-secret';
  const tok = platformJwt.signAgentProxyToken({
    sessionId: 123, userId: 456, turnId: 'turn-abc',
    backend: 'codex_openrouter', model: 'openai/gpt-5.3-codex',
    credentialRevision: 3, agentConfigVersion: 1,
  });
  const claims = platformJwt.verifyAgentProxyToken(tok);
  assert.equal(claims.session_id, 123);
  assert.equal(claims.user_id, 456);
  assert.equal(claims.turn_id, 'turn-abc');
  assert.equal(claims.backend, 'codex_openrouter');
  assert.equal(claims.model, 'openai/gpt-5.3-codex');
  assert.equal(claims.credential_revision, 3);
  assert.equal(claims.scope, platformJwt.PUR_AGENT_PROXY);
});

test('a worker:session token does NOT verify as agent-proxy', () => {
  process.env.WORKER_JWT_SECRET = 'test-worker-secret';
  const workerTok = platformJwt.signWorkerToken({ sessionId: 1 });
  assert.throws(() => platformJwt.verifyAgentProxyToken(workerTok), /purpose/);
});

// ── Codex config builder ──────────────────────────────────────────────
test('buildCodexConfig points directly at OpenRouter and disables agents', () => {
  const cfg = codex.buildCodexConfig({
    openRouterBaseUrl: 'http://usernode:3000/api/internal/openrouter/v1/',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
  assert.match(cfg, /model_provider = "usernode_openrouter"/);
  assert.match(cfg, /model = "openai\/gpt-5.3-codex"/);
  assert.match(cfg, /base_url = "http:\/\/usernode:3000\/api\/internal\/openrouter\/v1"/);
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
  assert.equal(ev.kind, 'thread_started');
  assert.equal(state.agentThreadId, 'thr-0199');
});

test('normalizeCodexLine maps a command item to $ <command>', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.started', item: { type: 'command_execution', command: 'npm test' },
  }), state);
  assert.equal(ev.kind, 'command_started');
  assert.match(ev.text, /^\$ npm test/);
});

test('normalizeCodexLine maps a file edit to Editing <path>', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.started', item: { type: 'file.edit', path: 'src/app.js' },
  }), state);
  assert.equal(ev.kind, 'file_changed');
  assert.match(ev.text, /Editing src\/app\.js/);
});

test('normalizeCodexLine maps turn.completed to usage + [done]', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, cost: 0.02 }, model: 'm',
  }), state);
  assert.equal(ev.kind, 'usage');
  assert.equal(ev.text, '[done]');
  assert.equal(ev.usage.inputTokens, 100);
  assert.equal(ev.usage.cost, 0.02);
});

test('normalizeCodexLine returns null for malformed JSON and unknown events', () => {
  const state = codex.newCodexState();
  assert.equal(codex.normalizeCodexLine('not json', state), null);
  assert.equal(codex.normalizeCodexLine(JSON.stringify({ type: 'future_event' }), state), null);
});

test('normalizeCodexLine maps turn.failed to an error event', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }), state);
  assert.equal(ev.kind, 'error');
  assert.match(ev.text, /\[agent_failed\]/);
});

test('normalizeCodexLine maps item.completed with agent_message (real 0.146.0)', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed', item: { id: 'item_0', type: 'agent_message', message: 'I edited the file.' },
  }), state);
  assert.equal(ev.kind, 'agent_message');
  assert.equal(ev.text, 'I edited the file.');
});

test('normalizeCodexLine maps item.completed with error type (real 0.146.0)', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed', item: { id: 'item_0', type: 'error', message: '401 Unauthorized' },
  }), state);
  assert.equal(ev.kind, 'error');
  assert.match(ev.text, /401/);
});

// ── Resume-error classification ───────────────────────────────────────
test('classifyResumeError: thread-missing is retry-fresh; auth/credit/rate are not', () => {
  assert.equal(codex.classifyResumeError('thread not found', 1).retryFresh, true);
  assert.equal(codex.classifyResumeError('401 unauthorized', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('402 insufficient credits', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('429 rate limit', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('something weird', 1).retryFresh, false);
});

// ── OpenRouter SSE parser ─────────────────────────────────────────────
test('parseSseFrames handles data-only frames split across chunks', () => {
  // OpenRouter uses data-only frames (no event: header). The type is
  // inside the JSON payload.
  const a = parseSseFrames('data: {"type":"response.created","response":{"id":"r1"}}\n\ndata: {"type":"response.do');
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].event, 'response.created');
  assert.equal(a.rest, 'data: {"type":"response.do');
  const b = parseSseFrames(a.rest + 'ne","response":{"id":"r1","usage":{}}}\n\n');
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].event, 'response.done');
});

test('parseSseFrames handles the [DONE] terminator', () => {
  const r = parseSseFrames('data: [DONE]\n\n');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].event, 'done');
  assert.equal(r.events[0].data, null);
});

test('extractUsage pulls tokens + cost from response.done (real format)', () => {
  // Real OpenRouter format: usage lives inside response.usage on the
  // response.done frame, not at the top level.
  const data = {
    type: 'response.done',
    response: {
      id: 'req-123', model: 'openai/gpt-5.3-codex', provider: 'openai',
      usage: { input_tokens: 200, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 } },
      cost: 0.0142,
    },
  };
  const u = extractUsage('response.done', data);
  assert.equal(u.requestId, 'req-123');
  assert.equal(u.inputTokens, 200);
  assert.equal(u.outputTokens, 80);
  assert.equal(u.reasoningOutputTokens, 30);
  assert.equal(u.cost, 0.0142);
  assert.equal(u.routedProvider, 'openai');
});

test('extractUsage returns null for non-usage events', () => {
  assert.equal(extractUsage('response.output_text.delta', { delta: 'hi' }), null);
});

test('extractUsage returns null for null data', () => {
  assert.equal(extractUsage('done', null), null);
});

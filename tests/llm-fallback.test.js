// Tests for the Fable 5 classifier-fallback plumbing in
// src/services/llm.js (spec: "Adopt Claude Fable 5 classifier-fallback
// handling in the platform's Anthropic calls"):
//   - detectFallback: usage.iterations is the ONLY reliable signal
//     (sticky-served turns carry no `fallback` content block)
//   - sanitizeFallbackContent: truncated pre-boundary tool_use/thinking
//     blocks are omitted per the streaming echo rule
//   - streamChat: fable requests go through the beta path with the
//     server-side-fallback opt-in; other models keep the plain path;
//     a refusal carrying stop_details.recommended_model triggers exactly
//     one direct retry
//   - estimateCostCents: fable priced per models.js ($10/$50 per MTok),
//     above sonnet and opus
//
// Run with: node --test tests/llm-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');

// ── Stub client ─────────────────────────────────────────────────────

// Minimal stand-in for the SDK stream handle: .on() is a no-op (we don't
// exercise token streaming here) and finalMessage() resolves the canned
// response.
function fakeStream(finalMessage) {
  return {
    on() {},
    finalMessage: async () => finalMessage,
  };
}

// A client whose plain and beta stream methods pop canned finalMessages
// in order, recording which surface each call used and with what params.
function makeStubClient(responses) {
  const calls = [];
  const next = (kind, params) => {
    calls.push({ kind, params });
    if (!responses.length) throw new Error('stub client: no more canned responses');
    return fakeStream(responses.shift());
  };
  return {
    calls,
    messages: { stream: (params) => next('plain', params) },
    beta: { messages: { stream: (params) => next('beta', params) } },
  };
}

function baseMessage(overrides = {}) {
  return {
    model: 'claude-fable-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: 'hello' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

async function withStubClient(responses, fn) {
  const stub = makeStubClient(responses);
  const prev = llm._setClientForTests(stub);
  try {
    return await fn(stub);
  } finally {
    llm._setClientForTests(prev);
  }
}

// ── detectFallback ──────────────────────────────────────────────────

test('detectFallback: fallback_message in usage.iterations is detected', () => {
  const msg = baseMessage({
    usage: {
      input_tokens: 10, output_tokens: 5,
      iterations: [{ type: 'message' }, { type: 'fallback_message' }],
    },
  });
  assert.equal(llm.detectFallback(msg), true);
});

test('detectFallback: iterations without a fallback_message is NOT a fallback', () => {
  const msg = baseMessage({
    usage: { input_tokens: 10, output_tokens: 5, iterations: [{ type: 'message' }] },
  });
  assert.equal(llm.detectFallback(msg), false);
});

test('detectFallback: missing/absent iterations is NOT a fallback', () => {
  assert.equal(llm.detectFallback(baseMessage()), false);
  assert.equal(llm.detectFallback({ usage: {} }), false);
  assert.equal(llm.detectFallback({}), false);
  assert.equal(llm.detectFallback(null), false);
});

test('detectFallback: sticky-served shape (iterations entry, NO fallback content block) is detected', () => {
  const msg = baseMessage({
    model: 'claude-opus-4-8', // sticky routing serves directly on the fallback model
    content: [{ type: 'text', text: 'served sticky' }], // no {type:'fallback'} block
    usage: {
      input_tokens: 10, output_tokens: 5,
      iterations: [{ type: 'fallback_message' }],
    },
  });
  assert.equal(llm.detectFallback(msg), true);
  assert.equal(llm.fallbackBoundary(msg.content), null);
});

// ── sanitizeFallbackContent ─────────────────────────────────────────

test('sanitizeFallbackContent: pre-boundary tool_use/thinking dropped, text and post-boundary kept, fallback block preserved', () => {
  const content = [
    { type: 'text', text: 'partial before decline' },
    { type: 'thinking', thinking: 'truncated reasoning' },
    { type: 'tool_use', id: 'tu_truncated', name: 'dispatch_scout', input: {} },
    { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
    { type: 'text', text: 'continued by the fallback' },
    { type: 'tool_use', id: 'tu_valid', name: 'dispatch_scout', input: {} },
  ];
  const out = llm.sanitizeFallbackContent(content);
  assert.deepEqual(out.map((b) => b.type), ['text', 'fallback', 'text', 'tool_use']);
  assert.equal(out.find((b) => b.type === 'tool_use').id, 'tu_valid');
  // The boundary marker survives (ignorable audit marker).
  assert.ok(out.some((b) => b.type === 'fallback'));
});

test('sanitizeFallbackContent: content with no fallback block passes through untouched', () => {
  const content = [
    { type: 'thinking', thinking: 'fine' },
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'tu_1', name: 'web_fetch', input: { url: 'https://example.com' } },
  ];
  assert.equal(llm.sanitizeFallbackContent(content), content);
});

test('sanitizeFallbackContent: sanitization uses the LAST fallback block as the boundary', () => {
  const content = [
    { type: 'tool_use', id: 'tu_a', name: 'x', input: {} },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'tool_use', id: 'tu_b', name: 'x', input: {} },
    { type: 'fallback', from: { model: 'b' }, to: { model: 'c' } },
    { type: 'text', text: 'final' },
  ];
  const out = llm.sanitizeFallbackContent(content);
  // Both pre-boundary tool_use blocks dropped; both markers survive? Only
  // blocks before the LAST boundary are filtered, and the first fallback
  // block is not a tool_use/thinking block so it stays.
  assert.deepEqual(out.map((b) => b.type), ['fallback', 'fallback', 'text']);
});

// ── streamChat surface selection + result fields ────────────────────

test('streamChat: fable requests use the beta path with the fallback opt-in', async () => {
  await withStubClient([baseMessage()], async (stub) => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].kind, 'beta');
    assert.deepEqual(stub.calls[0].params.betas, [llm.FALLBACK_BETA]);
    assert.deepEqual(stub.calls[0].params.fallbacks, [{ model: llm.FALLBACK_TARGET_MODEL }]);
    assert.equal(result.servedModel, 'claude-fable-5');
    assert.equal(result.fallbackServed, false);
  });
});

test('streamChat: non-fable models never get the beta path', async () => {
  await withStubClient([baseMessage({ model: 'claude-opus-4-8' })], async (stub) => {
    await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-opus-4-8',
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].kind, 'plain');
    assert.equal(stub.calls[0].params.betas, undefined);
    assert.equal(stub.calls[0].params.fallbacks, undefined);
  });
});

test('streamChat: fallback-served response reports servedModel + fallbackServed', async () => {
  const served = baseMessage({
    model: 'claude-opus-4-8',
    content: [
      { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: 'rescued' },
    ],
    usage: {
      input_tokens: 10, output_tokens: 5,
      iterations: [{ type: 'message' }, { type: 'fallback_message' }],
    },
  });
  await withStubClient([served], async () => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.equal(result.fallbackServed, true);
    assert.equal(result.servedModel, 'claude-opus-4-8');
    assert.deepEqual(result.fallbackBoundary, { from: 'claude-fable-5', to: 'claude-opus-4-8' });
    assert.equal(result.text, 'rescued');
  });
});

test('streamChat: toolUses derive from SANITIZED content (truncated pre-boundary tool_use never surfaces)', async () => {
  const served = baseMessage({
    model: 'claude-opus-4-8',
    content: [
      { type: 'tool_use', id: 'tu_truncated', name: 'dispatch_scout', input: {} },
      { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: 'after' },
      { type: 'tool_use', id: 'tu_valid', name: 'web_fetch', input: { url: 'https://x.test' } },
    ],
    usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'fallback_message' }] },
  });
  await withStubClient([served], async () => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.deepEqual(result.toolUses.map((t) => t.id), ['tu_valid']);
    assert.ok(!result.rawContent.some((b) => b.type === 'tool_use' && b.id === 'tu_truncated'));
  });
});

// ── recommended_model single retry ──────────────────────────────────

test('streamChat: refusal with recommended_model triggers exactly one direct retry on the plain path', async () => {
  const refusal = baseMessage({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', recommended_model: 'claude-opus-4-8' },
    content: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const retryOk = baseMessage({
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'retried fine' }],
  });
  await withStubClient([refusal, retryOk], async (stub) => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].kind, 'beta');
    assert.equal(stub.calls[1].kind, 'plain'); // retry needs no fallbacks param
    assert.equal(stub.calls[1].params.model, 'claude-opus-4-8');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.servedModel, 'claude-opus-4-8');
    assert.equal(result.fallbackServed, true);
    assert.equal(result.text, 'retried fine');
  });
});

test('streamChat: refusal-after-retry is final (no second retry) and surfaces stopDetails', async () => {
  const refusal1 = baseMessage({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'bio', recommended_model: 'claude-opus-4-8' },
    content: [],
  });
  const refusal2 = baseMessage({
    model: 'claude-opus-4-8',
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'bio', explanation: 'nope' },
    content: [],
  });
  await withStubClient([refusal1, refusal2], async (stub) => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.equal(stub.calls.length, 2);
    assert.equal(result.stopReason, 'refusal');
    assert.equal(result.stopDetails.category, 'bio');
  });
});

test('streamChat: refusal WITHOUT recommended_model makes a single call and passes stopDetails through', async () => {
  const refusal = baseMessage({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: null },
    content: [],
  });
  await withStubClient([refusal], async (stub) => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(result.stopReason, 'refusal');
    assert.deepEqual(result.stopDetails, { type: 'refusal', category: null });
    assert.equal(result.fallbackServed, false);
  });
});

test('streamChat: non-refusal responses carry null stopDetails', async () => {
  await withStubClient([baseMessage()], async () => {
    const result = await llm.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'sys',
      model: 'claude-fable-5',
    });
    assert.equal(result.stopDetails, null);
  });
});

// ── estimateCostCents ───────────────────────────────────────────────

test('estimateCostCents: fable priced per models.js, above sonnet and opus', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  const fable = llm.estimateCostCents(usage, 'claude-fable-5');
  const opus = llm.estimateCostCents(usage, 'claude-opus-4-8');
  const sonnet = llm.estimateCostCents(usage, 'claude-sonnet-5');
  const haiku = llm.estimateCostCents(usage, 'claude-haiku-4-5');
  // $10/MTok in + $50/MTok out → 1¢ + 5¢ per 1k+1k tokens.
  assert.equal(fable, 6);
  assert.ok(fable > opus, `fable (${fable}) should out-price opus (${opus})`);
  assert.ok(opus > sonnet, `opus (${opus}) should out-price sonnet (${sonnet})`);
  assert.ok(sonnet > haiku, `sonnet (${sonnet}) should out-price haiku (${haiku})`);
});

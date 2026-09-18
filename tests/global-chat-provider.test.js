'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const provider = require('../src/services/global-chat/openrouter');
const accounting = require('../src/services/global-chat/accounting');

const STRICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
};

const MODEL = {
  id: 'cheap/default',
  inputPricePerMillion: 0.06,
  outputPricePerMillion: 0.12,
};

function responseFromParts(parts, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Generation-Id': 'gen_test_1',
    },
  });
}

test('OpenRouter request pins tools, strict schema, low effort, usage, and required parameters', () => {
  const request = provider.buildRequest({
    model: MODEL.id,
    reasoning: 'low',
    messages: [{ role: 'user', content: 'List my work' }],
    tools: [{ type: 'function', function: { name: 'search_capabilities', parameters: STRICT_SCHEMA } }],
    schema: STRICT_SCHEMA,
    sessionId: 'thread_123',
  });
  assert.equal(request.model, MODEL.id);
  assert.deepEqual(request.reasoning, { effort: 'low' });
  assert.equal(request.max_tokens, 800);
  assert.equal(request.temperature, 0.1);
  assert.equal(request.stream, true);
  assert.deepEqual(request.usage, { include: true });
  assert.deepEqual(request.provider, { require_parameters: true });
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(request.parallel_tool_calls, true);
});

test('OpenRouter SSE parser reconstructs split tool calls and provider-reported usage', async () => {
  let sent;
  const result = await provider.streamChat({
    apiKey: 'sk-or-private',
    baseUrl: 'https://openrouter.ai/api/v1',
    origin: 'https://usernode.dev',
    model: MODEL.id,
    reasoning: 'low',
    messages: [{ role: 'user', content: 'Find issues' }],
    tools: [],
    schema: STRICT_SCHEMA,
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) };
      return responseFromParts([
        'data: {"id":"gen_test_1","model":"served/model","provider":"fast-provider","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"issues.list","arguments":"{\\"query\\":\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"open\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":101,"completion_tokens":12,"completion_tokens_details":{"reasoning_tokens":3},"prompt_tokens_details":{"cached_tokens":20},"cost":0.00004}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });

  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent.options.headers.Authorization, 'Bearer sk-or-private');
  assert.doesNotMatch(JSON.stringify(sent.body), /sk-or-private/);
  assert.equal(result.servedModel, 'served/model');
  assert.equal(result.provider, 'fast-provider');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'issues.list', arguments: '{"query":"open"}' },
  }]);
  assert.deepEqual(result.usage, {
    inputTokens: 101,
    cachedInputTokens: 20,
    outputTokens: 12,
    reasoningTokens: 3,
    costUsd: 0.00004,
  });
});

test('OpenRouter SSE parsing preserves Unicode split across network chunks', async () => {
  const full = Buffer.from('data: {"choices":[{"delta":{"content":"€"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const euro = full.indexOf(Buffer.from('€'));
  const pieces = [full.subarray(0, euro + 1), full.subarray(euro + 1)];
  const result = await provider.streamChat({
    apiKey: 'key',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: MODEL.id,
    reasoning: 'low',
    messages: [],
    tools: [],
    schema: STRICT_SCHEMA,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    }), { status: 200 }),
  });
  assert.equal(result.content, '€');
});

test('provider HTTP failures expose status but never echo response or credential content', async () => {
  await assert.rejects(
    provider.streamChat({
      apiKey: 'sk-or-secret',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: MODEL.id,
      reasoning: 'low',
      messages: [],
      tools: [],
      schema: STRICT_SCHEMA,
      fetchImpl: async () => new Response('credential sk-or-secret and private prompt', { status: 429 }),
    }),
    (error) => error.code === 'rate_limited'
      && error.status === 429
      && !error.message.includes('sk-or-secret')
      && !error.message.includes('private prompt'),
  );
});

function reservationPool({ cap = '1', spent = '0.1' } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT spend_cap_usd/.test(sql)) return { rows: [{ spend_cap_usd: cap }] };
      if (/SUM\(cost_usd\)/.test(sql)) return { rows: [{ spent_usd: spent }] };
      if (/INSERT INTO global_chat_usage/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return {
    calls,
    pool: {
      async connect() { return client; },
    },
  };
}

test('cost estimation reserves a tokenizer-independent maximum output budget', () => {
  const estimate = accounting.estimateInvocationCost({
    model: MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    schema: STRICT_SCHEMA,
    maxOutputTokens: 800,
  });
  assert.ok(estimate.estimatedInputTokens > 5);
  assert.equal(estimate.maxOutputTokens, 800);
  assert.match(estimate.costUsd, /^0\.0/);
  assert.equal(accounting.costFromUsage(MODEL, { inputTokens: 1000, outputTokens: 100 }), '0.000072');
});

test('monthly cap is checked and reserved atomically before provider dispatch', async () => {
  const allowed = reservationPool({ cap: '0.5', spent: '0.1' });
  const reservation = await accounting.reserveInvocation(allowed.pool, {
    userId: 7,
    threadId: '95df0790-4873-43cc-9608-728f3349da50',
    requestedModel: MODEL.id,
    reasoningEffort: 'low',
    estimatedCostUsd: '0.2',
    overallRemainingUsd: '0.4',
    now: new Date('2026-09-18T00:00:00Z'),
  });
  assert.equal(reservation.userId, 7);
  assert.equal(reservation.spentBeforeUsd, '0.1');
  assert.ok(allowed.calls.some(({ sql }) => /pg_advisory_xact_lock/.test(sql)));
  assert.ok(allowed.calls.some(({ sql }) => /INSERT INTO global_chat_usage/.test(sql)));
  assert.ok(allowed.calls.some(({ sql }) => sql === 'COMMIT'));

  const blocked = reservationPool({ cap: '0.25', spent: '0.1' });
  await assert.rejects(
    accounting.reserveInvocation(blocked.pool, {
      userId: 7,
      requestedModel: MODEL.id,
      reasoningEffort: 'low',
      estimatedCostUsd: '0.2',
      now: new Date('2026-09-18T00:00:00Z'),
    }),
    (error) => error.code === 'global_chat_cap_exceeded'
      && error.details.resetAt === '2026-10-01T00:00:00.000Z',
  );
  assert.ok(!blocked.calls.some(({ sql }) => /INSERT INTO global_chat_usage/.test(sql)));
  assert.ok(blocked.calls.some(({ sql }) => sql === 'ROLLBACK'));
});

test('overall allowance blocks before a DB reservation or model request', async () => {
  let connected = 0;
  await assert.rejects(
    accounting.invokeAccounted({
      pool: { async connect() { connected += 1; throw new Error('should not connect'); } },
      config: { openrouterApiBase: 'https://openrouter.ai/api/v1' },
      apiKey: 'key',
      userId: 7,
      threadId: null,
      model: MODEL,
      reasoningEffort: 'low',
      messages: [],
      tools: [],
      schema: STRICT_SCHEMA,
      validateKey: async () => ({ limitRemaining: 0 }),
      streamChat: async () => { throw new Error('should not dispatch'); },
    }),
    (error) => error.code === 'overall_allowance_exhausted',
  );
  assert.equal(connected, 0);
});

test('an accounted provider call settles tokens and provider-reported cost', async () => {
  const reserve = reservationPool({ cap: '1', spent: '0' });
  const updates = [];
  reserve.pool.query = async (sql, params) => {
    updates.push({ sql, params });
    return { rows: [{ id: params[0], cost_usd: '0.00003', cost_source: 'provider_reported', outcome: 'success' }] };
  };
  const result = await accounting.invokeAccounted({
    pool: reserve.pool,
    config: { openrouterApiBase: 'https://openrouter.ai/api/v1', openrouterOrigin: 'https://usernode.dev' },
    apiKey: 'key',
    userId: 7,
    threadId: '95df0790-4873-43cc-9608-728f3349da50',
    model: MODEL,
    reasoningEffort: 'low',
    spendCapUsd: '1',
    messages: [],
    tools: [],
    schema: STRICT_SCHEMA,
    validateKey: async () => ({ limitRemaining: 1 }),
    streamChat: async () => ({
      generationId: 'gen_test_1', servedModel: MODEL.id, provider: 'fast-provider',
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 2, costUsd: 0.00003 },
      toolCalls: [{ id: 'call' }], content: '', assistantMessage: { role: 'assistant', content: null },
    }),
  });
  assert.ok(result.reservationId);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /UPDATE global_chat_usage/);
  assert.equal(updates[0].params[7], '0.00003');
  assert.equal(updates[0].params[8], 'provider_reported');
  assert.equal(updates[0].params[9], 'success');
  assert.equal(updates[0].params[10], 1);
});

test('Global Chat usage participates in provider-neutral telemetry without content fields', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'llm-telemetry.js'),
    'utf8',
  );
  assert.match(source, /FROM global_chat_usage g/);
  assert.match(source, /'global_chat' AS backend/);
  assert.match(source, /'global_chat' AS component/);
  assert.match(source, /g\.metadata \|\| jsonb_strip_nulls/);
  assert.doesNotMatch(source, /g\.(plain_text|structured_payload|normalized_input)/);
});

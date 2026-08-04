'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');
const { getMayorSystemPrompt, cacheUsageTelemetry } = require('../src/routes/sessions');

function fakeStream(finalMessage) {
  return {
    on() {},
    finalMessage: async () => finalMessage,
  };
}

function stubClient(finalMessage) {
  const calls = [];
  const stream = (params) => {
    calls.push(params);
    return fakeStream(finalMessage);
  };
  return {
    calls,
    messages: { stream },
    beta: { messages: { stream } },
  };
}

async function withClient(client, fn) {
  const previous = llm._setClientForTests(client);
  try {
    return await fn();
  } finally {
    llm._setClientForTests(previous);
  }
}

function response(usage = { input_tokens: 7, output_tokens: 3 }) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: 'done' }],
    usage,
  };
}

test('cacheableSystemPrompt marks one exact ordered prefix and preserves every byte', () => {
  const prompt = [
    'Mayor instructions and app name',
    '==== PLATFORM CONVENTIONS (authoritative) ====',
    'large stable conventions',
    llm.PLATFORM_CONVENTIONS_END,
    'dynamic spec, PR and status suffix',
  ].join('\n\n');

  const blocks = llm.cacheableSystemPrompt(prompt);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].cache_control, undefined);
  assert.equal(blocks.map((block) => block.text).join(''), prompt);
  assert.equal(
    blocks.filter((block) => block.cache_control).length,
    1,
    'exactly one provider cache breakpoint is allowed'
  );
});

test('cacheableSystemPrompt leaves markerless and non-string prompts unchanged', () => {
  const ordinary = 'small title-generation or maintenance prompt';
  const blocks = [{ type: 'text', text: 'already structured' }];
  assert.equal(llm.cacheableSystemPrompt(ordinary), ordinary);
  assert.equal(llm.cacheableSystemPrompt(blocks), blocks);
});

test('the real Mayor prompt exposes a large cacheable prefix with an uncached live suffix', () => {
  const prompt = getMayorSystemPrompt(
    'Measured app', false, '# Live spec\nchanges per turn', false, null
  );
  const blocks = llm.cacheableSystemPrompt(prompt);
  assert.ok(Array.isArray(blocks));
  assert.ok(blocks[0].text.length > 100_000, `expected >100 KB, got ${blocks[0].text.length}`);
  assert.match(blocks[1].text, /CURRENT SPEC DOC/);
  assert.match(blocks[1].text, /changes per turn/);
  assert.equal(blocks.map((block) => block.text).join(''), prompt);
});

test('cache usage telemetry is additive, numeric and backward-compatible', () => {
  assert.deepEqual(cacheUsageTelemetry(undefined), {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  assert.deepEqual(cacheUsageTelemetry({
    cache_creation_input_tokens: 123,
    cache_read_input_tokens: 456,
  }), {
    cacheCreationInputTokens: 123,
    cacheReadInputTokens: 456,
  });
});

test('streamChat adds caching metadata without changing model, limits, messages or tools', async () => {
  const client = stubClient(response());
  const messages = [{ role: 'user', content: 'please build it' }];
  const tools = [{ name: 'dispatch_claude_code', description: 'build', input_schema: { type: 'object' } }];
  const prompt = `fixed\n${llm.PLATFORM_CONVENTIONS_END}\ndynamic`;

  await withClient(client, () => llm.streamChat({
    messages,
    systemPrompt: prompt,
    model: 'claude-opus-5',
    tools,
    toolChoice: { type: 'auto' },
  }));

  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.equal(params.model, 'claude-opus-5');
  assert.equal(params.max_tokens, 8192);
  assert.equal(params.messages, messages);
  assert.equal(params.tools, tools);
  assert.deepEqual(params.tool_choice, { type: 'auto' });
  assert.equal(params.system.map((block) => block.text).join(''), prompt);
});

test('repeated eligible calls expose an identical cacheable prefix', async () => {
  const client = stubClient(response());
  const common = `fixed instructions\n${llm.PLATFORM_CONVENTIONS_END}`;

  await withClient(client, async () => {
    await llm.streamChat({
      messages: [{ role: 'user', content: 'first' }],
      systemPrompt: `${common}\nspec version one`,
      model: 'claude-opus-5',
    });
    await llm.streamChat({
      messages: [{ role: 'user', content: 'second' }],
      systemPrompt: `${common}\nspec version two`,
      model: 'claude-opus-5',
    });
  });

  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0].system[0], client.calls[1].system[0]);
  assert.notEqual(client.calls[0].system[1].text, client.calls[1].system[1].text);
});

test('streamChat propagates provider cache usage for telemetry and billing', async () => {
  const usage = {
    input_tokens: 20,
    output_tokens: 10,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 2000,
  };
  const client = stubClient(response(usage));
  const result = await withClient(client, () => llm.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    systemPrompt: 'ordinary',
    model: 'claude-opus-5',
  }));
  assert.deepEqual(result.usage, usage);
});

test('cache-aware pricing preserves legacy totals and applies 5-minute multipliers', () => {
  const legacy = llm.estimateCostCents(
    { input_tokens: 1000, output_tokens: 1000 },
    'claude-opus-5'
  );
  assert.equal(legacy, 3); // 0.5c input + 2.5c output

  const cacheWrite = llm.estimateCostCents(
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 },
    'claude-opus-5'
  );
  const cacheRead = llm.estimateCostCents(
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 },
    'claude-opus-5'
  );
  assert.equal(cacheWrite, 0.625); // 1.25 x the normal 0.5c input price
  assert.equal(cacheRead, 0.05); // 0.1 x the normal 0.5c input price
  assert.equal(cacheRead / 0.5, 0.1, 'a cache hit cuts repeated input cost by 90%');
});

// llm.js streamChat, the one Messages call with a tool-loop surface (a fleet
// campaign's loop, the Workshop ask box's second try), and the price table
// the platform's calls are costed at. Task 2275 moved every such call to
// OpenRouter's Claude Messages endpoint on the platform's key, so the Fable
// server-side fallback this file used to pin (an Anthropic-only beta) is
// gone: one plain request, its answer as it came.
//
// The failures are driven through the real transport
// (services/openrouter-messages.js) with a fake fetch: the provider's own
// HTTP answer, never a hand-built error.
//
// Run with: node --test tests/llm-stream-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');
const openrouterMessages = require('../src/services/openrouter-messages');

const BASE = 'https://openrouter.test/api/v1';

function message(overrides = {}) {
  return {
    id: 'msg_1', type: 'message', model: 'anthropic/claude-opus-5.5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'hello' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

// The platform client over a fake fetch: `answers` are the HTTP responses
// OpenRouter gives, in order.
async function withTransport(answers, fn) {
  const sent = [];
  const prevFetch = globalThis.fetch;
  const prevKey = openrouterMessages._setPlatformKeyForTests('sk-or-platform');
  const prevClient = llm._setClientForTests(openrouterMessages.platformClient({ openrouterApiBase: BASE }));
  globalThis.fetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return new Response(JSON.stringify(next.body), { status: next.status || 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = prevFetch;
    openrouterMessages._setPlatformKeyForTests(prevKey);
    llm._setClientForTests(prevClient);
  }
}

test('one plain request to OpenRouter, the answer handed back with its tool calls', async () => {
  const tools = [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } }];
  await withTransport([{ body: message({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.js' } },
    ],
  }) }], async (sent) => {
    const tokens = [];
    const out = await llm.streamChat({
      model: 'claude-opus-5-5', systemPrompt: 'Campaign', tools, toolChoice: { type: 'auto' },
      messages: [{ role: 'user', content: 'Apply it' }],
      onToken: (t) => tokens.push(t),
      telemetryContext: { component: 'fleet_maintenance', backend: 'helper' },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `${BASE}/messages`);
    assert.equal(sent[0].headers.authorization, 'Bearer sk-or-platform');
    assert.equal(sent[0].body.model, 'anthropic/claude-opus-5.5');
    assert.equal(sent[0].body.max_tokens, 8192, 'the default ceiling');
    assert.equal(sent[0].body.system, 'Campaign');
    assert.deepEqual(sent[0].body.tools, tools);
    assert.deepEqual(sent[0].body.tool_choice, { type: 'auto' });
    assert.equal(sent[0].body.stream, false);
    for (const gone of ['betas', 'fallbacks']) assert.equal(gone in sent[0].body, false, `no ${gone}: Anthropic's beta is gone`);
    assert.equal(out.text, 'Reading it.');
    assert.deepEqual(out.toolUses, [{ id: 'tu_1', name: 'read_file', input: { path: 'a.js' } }]);
    assert.equal(out.rawContent.length, 2);
    assert.equal(out.stopReason, 'tool_use');
    assert.equal(out.servedModel, 'anthropic/claude-opus-5.5');
    assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
    assert.deepEqual(tokens, ['Reading it.'], 'a forwarding caller gets the whole text once');
  });
});

test('a refusal is one call, with its details passed through', async () => {
  await withTransport([{ body: message({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }) }], async (sent) => {
    const out = await llm.streamChat({ model: 'claude-fable-5-1', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(sent.length, 1, 'no server-side fallback, no retry on a recommended model');
    assert.equal(out.stopReason, 'refusal');
    assert.deepEqual(out.stopDetails, { category: 'cyber' });
  });
});

test('OpenRouter out of credit fails the call with its 402, and the caller hears it', async () => {
  await withTransport([{ status: 402, body: { error: { message: 'Insufficient credits' } } }], async () => {
    let heard = null;
    await assert.rejects(
      llm.streamChat({ model: 'claude-opus-5-5', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], onError: (e) => { heard = e; } }),
      (err) => err.status === 402 && err.code === 'credit_out',
    );
    assert.equal(heard && heard.code, 'credit_out');
  });
});

test('#3557: a 400 on a request with a PDF retries once with the PDF named, not sent', async () => {
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'brief.pdf' };
  await withTransport([
    { status: 400, body: { error: { message: 'invalid pdf' } } },
    { body: message({ content: [{ type: 'text', text: 'Read the note.' }] }) },
  ], async (sent) => {
    const result = await llm.streamChat({
      model: 'claude-opus-5-5', systemPrompt: 'Mayor',
      messages: [{ role: 'user', content: [doc, { type: 'text', text: 'what does it say?' }] }],
    });
    assert.equal(result.text, 'Read the note.');
    assert.equal(sent.length, 2, 'exactly one retry');
    assert.equal(sent[0].body.messages[0].content[0].type, 'document');
    assert.equal(sent[1].body.messages[0].content[0].type, 'text');
    assert.match(sent[1].body.messages[0].content[0].text, /brief\.pdf — PDF\. The model provider could not read it/);
    assert.equal(JSON.stringify(sent[1].body.messages).includes('JVBERi0'), false);
  });
  // Without a PDF, or on another status, a refusal is final.
  for (const [messages, status] of [
    [[{ role: 'user', content: 'hi' }], 400],
    [[{ role: 'user', content: [doc] }], 429],
  ]) {
    await withTransport([{ status, body: { error: { message: 'nope' } } }], async (sent) => {
      await assert.rejects(llm.streamChat({ model: 'claude-opus-5-5', systemPrompt: 'Mayor', messages }), (err) => err.status === status);
      assert.equal(sent.length, 1, `no retry (status ${status})`);
    });
  }
});

test('estimateCostCents: fable priced per models.js, above sonnet and opus', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  const fable = llm.estimateCostCents(usage, 'claude-fable-5-1');
  const opus = llm.estimateCostCents(usage, 'claude-opus-5');
  const sonnet = llm.estimateCostCents(usage, 'claude-sonnet-5');
  const haiku = llm.estimateCostCents(usage, 'claude-haiku-4-5');
  // $10/MTok in + $50/MTok out → 1¢ + 5¢ per 1k+1k tokens.
  assert.equal(fable, 6);
  assert.ok(fable > opus, `fable (${fable}) should out-price opus (${opus})`);
  assert.ok(opus > sonnet, `opus (${opus}) should out-price sonnet (${sonnet})`);
  assert.ok(sonnet > haiku, `sonnet (${sonnet}) should out-price haiku (${haiku})`);
});

test('estimateCostCents: a Claude model under its OpenRouter id is priced as Claude, and OpenRouter\'s own figure wins', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  assert.equal(llm.estimateCostCents(usage, 'anthropic/claude-sonnet-5.5'), llm.estimateCostCents(usage, 'claude-sonnet-5-5'));
  assert.equal(llm.estimateCostCents(usage, 'anthropic/claude-haiku-5.5'), llm.estimateCostCents(usage, 'claude-haiku-5-5'));
  assert.equal(llm.estimateCostCents({ ...usage, cost: 0.0123 }, 'anthropic/claude-sonnet-5.5'), 1.23);
});

'use strict';

// The OpenRouter session Mayor (#2809/#2810): the Anthropic Messages shapes
// the chat route speaks, translated to OpenRouter Chat Completions and back,
// and the per-session setup that decides whether a session gets a Mayor at
// all. No network: the client takes an injected fetch.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/openrouter-mayor');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');
const llmTelemetry = require('../src/services/llm-telemetry');

const DISPATCH_TOOL = {
  name: 'dispatch_scout',
  description: 'Draft or revise the spec.',
  input_schema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  },
};

function completion({ content = null, toolCalls = null, finish = 'stop', usage = null, model = 'z-ai/glm-5.3-flash' } = {}) {
  return {
    id: 'gen-1',
    model,
    choices: [{
      finish_reason: finish,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: usage || { prompt_tokens: 1200, completion_tokens: 80, cost: 0.00015 },
  };
}

function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetchImpl, calls };
}

test('Anthropic history becomes Chat Completions messages, tool results first', () => {
  const messages = mayor.toChatMessages([{ type: 'text', text: 'You are the Mayor.' }], [
    { role: 'user', content: 'Add a leaderboard' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'I will draft a spec.' },
        { type: 'tool_use', id: 'toolu_1', name: 'dispatch_scout', input: { prompt: 'Spec a leaderboard' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Spec drafted.' },
        { type: 'text', text: 'and make it weekly' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'boom' }], is_error: true }],
    },
  ]);
  assert.deepEqual(messages[0], { role: 'system', content: 'You are the Mayor.' });
  assert.deepEqual(messages[1], { role: 'user', content: 'Add a leaderboard' });
  assert.deepEqual(messages[2], {
    role: 'assistant',
    content: 'I will draft a spec.',
    tool_calls: [{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'dispatch_scout', arguments: '{"prompt":"Spec a leaderboard"}' },
    }],
  });
  assert.deepEqual(messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'Spec drafted.' });
  assert.equal(messages[4].role, 'user');
  assert.match(messages[4].content, /and make it weekly/);
  assert.match(messages[4].content, /image attachment omitted/, 'image bytes never reach a text-only model');
  assert.deepEqual(messages[5], { role: 'tool', tool_call_id: 'toolu_2', content: 'Error: boom' });
  assert.equal(JSON.stringify(messages).includes('private'), false, 'thinking is never replayed');
});

test('tools and tool choice translate to the OpenAI function shapes', () => {
  assert.deepEqual(mayor.toChatTools([DISPATCH_TOOL, { name: 'server_tool', type: 'web_search_20250305' }]), [{
    type: 'function',
    function: {
      name: 'dispatch_scout',
      description: 'Draft or revise the spec.',
      parameters: DISPATCH_TOOL.input_schema,
    },
  }]);
  assert.equal(mayor.toChatToolChoice({ type: 'none' }), 'none');
  assert.equal(mayor.toChatToolChoice({ type: 'auto' }), 'auto');
  assert.equal(mayor.toChatToolChoice({ type: 'any' }), 'required');
  assert.deepEqual(mayor.toChatToolChoice({ type: 'tool', name: 'dispatch_scout' }),
    { type: 'function', function: { name: 'dispatch_scout' } });
  assert.equal(mayor.toChatToolChoice(undefined), undefined);
});

test('a completion comes back in the shape llm.streamChat returns', () => {
  const result = mayor.fromChatCompletion(completion({
    content: 'Drafting the spec now.',
    finish: 'tool_calls',
    toolCalls: [
      { id: 'call_a', type: 'function', function: { name: 'dispatch_scout', arguments: '{"prompt":"Spec it"}' } },
      { type: 'function', function: { name: 'suggest_replies', arguments: 'not json' } },
    ],
  }), { requestedModel: 'z-ai/glm-5.3-flash' });
  assert.equal(result.text, 'Drafting the spec now.');
  assert.equal(result.stopReason, 'tool_use');
  assert.deepEqual(result.toolUses, [
    { id: 'call_a', name: 'dispatch_scout', input: { prompt: 'Spec it' } },
    { id: 'call_2', name: 'suggest_replies', input: {} },
  ]);
  assert.deepEqual(result.rawContent[0], { type: 'text', text: 'Drafting the spec now.' });
  assert.equal(result.rawContent[1].type, 'tool_use');
  assert.deepEqual(result.usage, { input_tokens: 1200, output_tokens: 80, cost_usd: 0.00015 });
  assert.equal(result.servedModel, 'openrouter/z-ai/glm-5.3-flash');
  assert.equal(result.fallbackServed, false);
  assert.equal(result.stopDetails, null);

  // The echoed assistant turn round-trips into the next request with the
  // same ids, which is what lets the wrap-up answer the dispatch.
  const replay = mayor.toChatMessages('', [{ role: 'assistant', content: result.rawContent }]);
  assert.deepEqual(replay[0].tool_calls.map((c) => c.id), ['call_a', 'call_2']);

  assert.equal(mayor.fromChatCompletion(completion({ content: 'Hi' })).stopReason, 'end_turn');
  assert.equal(mayor.fromChatCompletion(completion({ content: 'Hi', finish: 'length' })).stopReason, 'max_tokens');
});

test('cost: OpenRouter-reported figure first, catalog price second, never a guess', () => {
  assert.equal(mayor.estimateCostCents({ input_tokens: 1, output_tokens: 1, cost_usd: 0.0125 }), 1.25);
  const pricing = { inputPricePerMillion: 0.1, outputPricePerMillion: 0.4 };
  assert.equal(
    Math.round(mayor.estimateCostCents({ input_tokens: 1_000_000, output_tokens: 500_000 }, pricing) * 1000) / 1000,
    30,
  );
  assert.equal(mayor.estimateCostCents({ input_tokens: 5000, output_tokens: 100 }, null), 0);
  assert.equal(mayor.estimateCostCents(null, pricing), 0);
});

test('the Mayor reasons at low effort, or the nearest level a model offers', () => {
  assert.equal(mayor.reasoningEffortFor(null), 'low');
  assert.equal(mayor.reasoningEffortFor({ supportsReasoning: true, reasoningEfforts: null }), 'low');
  assert.equal(mayor.reasoningEffortFor({ supportsReasoning: true, reasoningEfforts: ['low', 'high'] }), 'low');
  assert.equal(mayor.reasoningEffortFor({ supportsReasoning: true, reasoningEfforts: ['high', 'xhigh'] }), 'high');
  assert.equal(mayor.reasoningEffortFor({ supportsReasoning: true, reasoningEfforts: ['minimal'] }), 'minimal');
  assert.equal(mayor.reasoningEffortFor({ supportsReasoning: false }), null);
});

test('the client sends one atomic request on the bound model and key', async () => {
  const { fetchImpl, calls } = fakeFetch(completion({ content: 'On it.' }));
  const client = mayor.createClient({
    apiKey: 'sk-or-v1-session',
    apiBase: 'https://openrouter.example/api/v1/',
    origin: 'https://homeroom.example',
    model: 'z-ai/glm-5.3-flash',
    catalogModel: { supportsReasoning: true, reasoningEfforts: null, inputPricePerMillion: 0.1, outputPricePerMillion: 0.4 },
    sessionId: 'homeroom-session-42',
    fetchImpl,
  });
  assert.equal(client.modelLabel, 'openrouter/z-ai/glm-5.3-flash');
  assert.equal(client.isEnabled(), true);
  const tokens = [];
  const result = await client.streamChat({
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt: 'You are the Mayor.',
    // A Claude id and an Anthropic key from the caller must never leak through.
    model: 'claude-opus-5-5',
    apiKey: 'sk-ant-should-not-be-used',
    tools: [DISPATCH_TOOL],
    toolChoice: { type: 'auto' },
    onToken: (text) => tokens.push(text),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.example/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-v1-session');
  assert.equal(calls[0].init.headers['HTTP-Referer'], 'https://homeroom.example');
  const body = calls[0].body;
  assert.equal(body.model, 'z-ai/glm-5.3-flash');
  assert.equal(body.stream, false);
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools[0].function.name, 'dispatch_scout');
  assert.equal(body.session_id, 'homeroom-session-42');
  assert.equal(body.max_tokens, mayor.DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(JSON.stringify(body).includes('sk-ant'), false);
  assert.equal(JSON.stringify(body).includes('claude-opus'), false);
  assert.deepEqual(tokens, ['On it.']);
  assert.equal(result.text, 'On it.');
});

test('provider failures surface as coded errors and a stop is not disguised', async () => {
  const refused = mayor.createClient({
    apiKey: 'k', model: 'm/x', fetchImpl: fakeFetch({ error: { message: 'no' } }, { status: 402 }).fetchImpl,
  });
  await assert.rejects(refused.streamChat({ messages: [] }), (err) => err.code === 'billing' && err.status === 402);

  const inBody = mayor.createClient({
    apiKey: 'k', model: 'm/x', fetchImpl: fakeFetch({ error: { code: 429, message: 'slow down' } }).fetchImpl,
  });
  await assert.rejects(inBody.streamChat({ messages: [] }), (err) => err.code === 'rate_limited');

  const controller = new AbortController();
  const aborted = mayor.createClient({
    apiKey: 'k',
    model: 'm/x',
    fetchImpl: async (url, init) => {
      controller.abort();
      init.signal.throwIfAborted();
      return null;
    },
  });
  await assert.rejects(
    aborted.streamChat({ messages: [], signal: controller.signal }),
    (err) => !(err instanceof mayor.OpenRouterMayorError),
    'a user stop propagates as the abort it is',
  );

  assert.throws(() => mayor.createClient({ apiKey: '', model: 'm/x' }), (err) => err.code === 'authentication');
});

test('each call records content-free telemetry on the session', async (t) => {
  const events = [];
  const previousEnabled = llmTelemetry._setEnabledForTests(true);
  const previousSink = llmTelemetry._setSinkForTests((event) => { events.push(event); });
  t.after(() => {
    llmTelemetry._setEnabledForTests(previousEnabled);
    llmTelemetry._setSinkForTests(previousSink);
  });
  const client = mayor.createClient({
    apiKey: 'k',
    model: 'z-ai/glm-5.3-flash',
    billingPath: 'platform',
    fetchImpl: fakeFetch(completion({ content: 'Hello there' })).fetchImpl,
  });
  await client.streamChat({
    messages: [{ role: 'user', content: 'secret prompt text' }],
    telemetryContext: { pool: {}, appId: 3, sessionId: 42, backend: 'mayor', component: 'mayor_phase_1' },
  });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.provider, 'openrouter');
  assert.equal(event.backend, 'mayor');
  assert.equal(event.component, 'mayor_phase_1');
  assert.equal(event.billing_path, 'platform');
  assert.equal(event.session_id ?? event.sessionId, 42);
  assert.equal(event.cost_source, 'provider_reported');
  assert.equal(event.outcome, 'success');
  assert.equal(JSON.stringify(event).includes('secret prompt text'), false);
  assert.equal(JSON.stringify(event).includes('Hello there'), false);
});

test('a session gets a Mayor only with a usable key and a model that calls tools', async (t) => {
  const originals = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    resolveModelPricing: agentModels.resolveModelPricing,
  };
  t.after(() => Object.assign(credentialStore, {
    readMetadata: originals.readMetadata,
    readSecret: originals.readSecret,
  }));
  t.after(() => { agentModels.resolveModelPricing = originals.resolveModelPricing; });

  let meta = { status: 'valid', revision: 3, metadata: { source: 'usernode_managed' } };
  let catalog = { id: 'z-ai/glm-5.3-flash', supportsTools: true, supportsReasoning: true };
  credentialStore.readMetadata = async () => meta;
  credentialStore.readSecret = async ({ expectedRevision }) => (expectedRevision === 3 ? 'sk-or-v1-x' : null);
  agentModels.resolveModelPricing = async () => catalog;

  const config = {
    openrouterSessionMayorEnabled: true,
    codexOpenrouterEnabled: true,
    openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
  };
  const session = { id: 7, agent_model: 'deepseek/deepseek-v4.1-flash' };

  const resolved = await mayor.resolveForSession({ pool: {}, config, session, userId: 1 });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.model, 'deepseek/deepseek-v4.1-flash', 'the session-pinned model is the Mayor');
  assert.equal(resolved.modelLabel, 'openrouter/deepseek/deepseek-v4.1-flash');
  assert.equal(resolved.usesIncludedKey, true);

  meta = { ...meta, metadata: { source: 'user' } };
  assert.equal((await mayor.resolveForSession({ pool: {}, config, session, userId: 1 })).usesIncludedKey, false);

  assert.deepEqual(
    await mayor.resolveForSession({ pool: {}, config: { ...config, openrouterSessionMayorEnabled: false }, session, userId: 1 }),
    { error: 'disabled' },
  );
  assert.deepEqual(
    await mayor.resolveForSession({ pool: {}, config: { ...config, codexOpenrouterEnabled: false }, session, userId: 1 }),
    { error: 'backend_disabled' },
  );

  catalog = { ...catalog, supportsTools: false };
  assert.deepEqual(await mayor.resolveForSession({ pool: {}, config, session, userId: 1 }), { error: 'model_without_tools' });
  catalog = null; // catalog unavailable: tool support unknown, not refused
  assert.equal((await mayor.resolveForSession({ pool: {}, config, session, userId: 1 })).error, undefined);

  meta = { status: 'invalid', revision: 3 };
  assert.deepEqual(await mayor.resolveForSession({ pool: {}, config, session, userId: 1 }), { error: 'credential_required' });
});

'use strict';

// Task 2275: Claude's Messages API, served through OpenRouter
// (src/services/openrouter-messages.js). Every model call the platform pays
// for goes here now: the helpers' second try and the Sonnet calls in llm.js,
// the worker relay (routes/anthropic-proxy.js) and the app relay
// (routes/app-llm-proxy.js). Pins the model mapping, the refusal of a model
// that is not Claude, the routes, the body and headers sent, and how a
// provider's refusal comes back: driven through a fake fetch, the real HTTP
// boundary, never a hand-built error.
//
// Run with: node --test tests/openrouter-messages.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const messages = require('../src/services/openrouter-messages');

function fakeFetch(respond) {
  const sent = [];
  const impl = async (url, init) => {
    sent.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return respond(url, init);
  };
  return { sent, impl };
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('a Claude id as the platform writes it becomes OpenRouter\'s', () => {
  const cases = {
    'claude-sonnet-5-5': 'anthropic/claude-sonnet-5.5',
    'claude-haiku-5-5': 'anthropic/claude-haiku-5.5',
    'claude-opus-5-5': 'anthropic/claude-opus-5.5',
    'claude-fable-5-1': 'anthropic/claude-fable-5.1',
    'claude-opus-5': 'anthropic/claude-opus-5',
    'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',
    'claude-3-5-haiku-latest': 'anthropic/claude-3.5-haiku',
    'claude-sonnet-5-5[1m]': 'anthropic/claude-sonnet-5.5',
    'anthropic/claude-sonnet-5.5': 'anthropic/claude-sonnet-5.5',
  };
  for (const [from, to] of Object.entries(cases)) {
    assert.equal(messages.toOpenRouterModel(from), to, from);
  }
  for (const notClaude of ['z-ai/glm-5.3-flash', 'gpt-6', 'openai/gpt-6-astra', '', null, undefined, 42, 'claude']) {
    assert.equal(messages.toOpenRouterModel(notClaude), null, String(notClaude));
  }
});

test('the way back is the spelling the Claude price table reads', () => {
  assert.equal(messages.fromOpenRouterModel('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5-5');
  assert.equal(messages.fromOpenRouterModel('anthropic/claude-haiku-4.5'), 'claude-haiku-4-5');
  assert.equal(messages.fromOpenRouterModel('z-ai/glm-5.3-flash'), 'z-ai/glm-5.3-flash');
});

test('only the two Messages routes go upstream, on the configured base', () => {
  const base = 'https://openrouter.example/api/v1/';
  assert.equal(messages.upstreamUrlFor(base, '/v1/messages'), 'https://openrouter.example/api/v1/messages');
  assert.equal(messages.upstreamUrlFor(base, '/v1/messages?beta=true'), 'https://openrouter.example/api/v1/messages');
  assert.equal(messages.upstreamUrlFor(base, '/v1/messages/count_tokens'), 'https://openrouter.example/api/v1/messages/count_tokens');
  for (const other of ['/v1/models', '/v1/complete', '/', '/v1/messages/batches', '/v1/organizations/cost_report']) {
    assert.equal(messages.upstreamUrlFor(base, other), null, other);
  }
  assert.equal(messages.upstreamUrlFor(null, '/v1/messages'), 'https://openrouter.ai/api/v1/messages');
});

test('the body goes up with OpenRouter\'s model and data collection denied; a model that is not Claude is refused', () => {
  const sent = messages.requestBody({
    model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
    provider: { data_collection: 'allow', order: ['anthropic'] },
  });
  assert.equal(sent.model, 'anthropic/claude-sonnet-5.5');
  assert.deepEqual(sent.provider, { order: ['anthropic'], data_collection: 'deny' });
  assert.throws(() => messages.requestBody({ model: 'openai/gpt-6-astra', messages: [] }),
    (err) => err.code === 'unsupported_model' && err.status === 400);
  assert.throws(() => messages.requestBody(null), (err) => err.code === 'invalid_request');
});

test('only the Messages headers ride along, and the key goes in as a bearer token', () => {
  const headers = messages.upstreamHeaders({
    'x-api-key': 'relay-token', authorization: 'Bearer app-token', 'x-usernode-app-token': 'a',
    'anthropic-beta': 'context-1m', cookie: 'c=1',
  }, 'sk-or-platform', 'https://homeroom.example');
  assert.equal(headers.authorization, 'Bearer sk-or-platform');
  assert.equal(headers['anthropic-beta'], 'context-1m');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['HTTP-Referer'], 'https://homeroom.example');
  for (const gone of ['x-api-key', 'x-usernode-app-token', 'cookie']) assert.equal(gone in headers, false, gone);
});

test('one call: POST /messages on the key, the answer returned as it came', async () => {
  const answer = {
    id: 'msg_1', type: 'message', model: 'anthropic/claude-sonnet-5.5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 12, output_tokens: 3, cost: 0.0004 },
  };
  const fetch = fakeFetch(() => ok(answer));
  const reply = await messages.createMessage({
    apiKey: 'sk-or-platform', baseUrl: 'https://openrouter.example/api/v1',
    params: { model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] },
    fetchImpl: fetch.impl,
  });
  assert.deepEqual(reply, answer);
  assert.equal(fetch.sent.length, 1);
  assert.equal(fetch.sent[0].url, 'https://openrouter.example/api/v1/messages');
  assert.equal(fetch.sent[0].init.headers.authorization, 'Bearer sk-or-platform');
  assert.equal(fetch.sent[0].body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(fetch.sent[0].body.stream, false);
  assert.equal(fetch.sent[0].body.provider.data_collection, 'deny');
});

test('OpenRouter out of credit (its 402) comes back as credit_out, with the provider\'s own words', async () => {
  const fetch = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }), { status: 402 }));
  await assert.rejects(messages.createMessage({
    apiKey: 'k', params: { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, fetchImpl: fetch.impl,
  }), (err) => err.status === 402 && err.code === 'credit_out' && /Insufficient credits/.test(err.message));
});

// #6898: one reading of a refusal for every OpenRouter client
// (provider-error.js). The 402 that only asks for a shorter reply is the
// key's billing refusal, not an outage; a 402 carried in a 200's body reads
// as the 402 it names; the rest of the table is the shared one.
test('refusals read as provider-error.js reads them: credit, a shorter reply, a body-carried 402, the table', async () => {
  const call = (respond) => messages.createMessage({
    apiKey: 'k', params: { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, fetchImpl: fakeFetch(respond).impl,
  });
  await assert.rejects(call(() => new Response(JSON.stringify({ error: {
    message: 'This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 900.', code: 402,
  } }), { status: 402 })), (err) => err.status === 402 && err.code === 'billing', 'a smaller request gets through: no outage');
  await assert.rejects(call(() => ok({ error: { code: 402, message: 'Insufficient credits' } })),
    (err) => err.status === 402 && err.code === 'credit_out', 'a 200 carrying the 402');
  for (const [status, code] of [[401, 'authentication'], [429, 'rate_limited'], [503, 'provider_unavailable'], [400, 'invalid_request']]) {
    await assert.rejects(call(() => new Response('{"error":{"message":"no"}}', { status })), (err) => err.code === code, String(status));
  }
});

test('a refusal and an answer that is not a message both throw, and no call goes out without a key', async () => {
  const refused = fakeFetch(() => new Response('{"error":{"message":"busy"}}', { status: 503 }));
  await assert.rejects(messages.createMessage({
    apiKey: 'k', params: { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, fetchImpl: refused.impl,
  }), (err) => err.status === 503 && err.message === 'busy');
  const garbled = fakeFetch(() => new Response('not json', { status: 200 }));
  await assert.rejects(messages.createMessage({
    apiKey: 'k', params: { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, fetchImpl: garbled.impl,
  }), (err) => err.status === 502);
  const never = fakeFetch(() => ok({}));
  await assert.rejects(messages.createMessage({
    apiKey: null, params: { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, fetchImpl: never.impl,
  }), (err) => err.code === 'no_platform_key');
  assert.equal(never.sent.length, 0);
});

test('the platform client reads the platform key and says when it is missing', async () => {
  const prev = messages._setPlatformKeyForTests(null);
  try {
    assert.equal(await messages.platformKey({ dataEncryptionKey: 'x' }), null);
    assert.equal(messages.platformKeyMissing(), true);
    const client = messages.platformClient({ dataEncryptionKey: 'x' });
    assert.equal(client.keyMissing(), true);
    await assert.rejects(client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [] }),
      (err) => err.code === 'no_platform_key');
    messages._setPlatformKeyForTests('sk-or-platform');
    assert.equal(messages.platformKeyMissing(), false);
    assert.equal(await messages.platformKey({}), 'sk-or-platform');
  } finally {
    messages._setPlatformKeyForTests(prev);
  }
});

// A staging preview has no platform key. The gate used to say "not missing"
// before any read and again once an answer was a minute old, so
// llm.isEnabled() was true there and every model feature ran in previews.
test('the key counts as missing until a read finds it; a found key stands while it is read again', async () => {
  const secrets = require('../src/services/secrets');
  const DATA_KEY = 'test-data-encryption-key-0000';
  const prev = messages._setPlatformKeyForTests(undefined);
  let stored = null;
  let reads = 0;
  const pool = {
    async query(sql) {
      if (/FROM users/.test(sql)) { reads += 1; return { rows: [{ id: 7 }] }; }
      if (/user_ai_credentials/.test(sql)) {
        return { rows: stored ? [{ status: 'valid', secret_last4: 'abcd', secret_enc: secrets.encrypt(stored, DATA_KEY), revision: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
  const config = { dataEncryptionKey: DATA_KEY };
  try {
    messages.forgetPlatformKey();
    assert.equal(messages.platformKeyMissing(), true, 'before any read');
    await messages.warmPlatformKey(config, { pool });
    assert.equal(messages.platformKeyMissing(), true, 'a read that found none');
    assert.equal(reads, 1);
    await messages.warmPlatformKey(config, { pool });
    assert.equal(reads, 1, 'a fresh answer is not read again');
    stored = 'sk-or-platform';
    messages.forgetPlatformKey();
    await Promise.all([messages.warmPlatformKey(config, { pool }), messages.warmPlatformKey(config, { pool })]);
    assert.equal(reads, 2, 'one read at a time');
    assert.equal(messages.platformKeyMissing(), false, 'a read found it');
    assert.equal(await messages.platformKey(config, { pool }), 'sk-or-platform');
  } finally {
    messages.forgetPlatformKey();
    messages._setPlatformKeyForTests(prev);
  }
});

test('with no data key there is nothing to read the platform key with', async () => {
  const prev = messages._setPlatformKeyForTests(undefined);
  try {
    messages.forgetPlatformKey();
    assert.equal(await messages.platformKey({}), null);
    assert.equal(await messages.platformKey(null), null);
  } finally {
    messages._setPlatformKeyForTests(prev);
  }
});

test('nothing on the platform sends to api.anthropic.com or holds an Anthropic key any more', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'migrations'].includes(e.name) ? [] : walk(p);
    return /\.(js|ts|tsx|sh)$/.test(e.name) ? [p] : [];
  });
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'worker')), path.join(root, 'server.js')];
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/^\s*#.*$/gm, '');
  for (const file of files) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(root, file);
    assert.doesNotMatch(code, /api\.anthropic\.com/, `${rel} names api.anthropic.com outside a comment`);
    assert.doesNotMatch(code, /@anthropic-ai\/sdk/, `${rel} loads the Anthropic SDK`);
    assert.doesNotMatch(code, /process\.env\.ANTHROPIC_(API|ADMIN)_KEY/, `${rel} reads an Anthropic key from the environment`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal('@anthropic-ai/sdk' in (pkg.dependencies || {}), false, 'the SDK is not a dependency');
});

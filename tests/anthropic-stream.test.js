// Tests for src/services/anthropic-stream.js — the shared Anthropic
// stream-forwarding mechanics extracted from routes/anthropic-proxy.js
// (issue #34) and now consumed by both the worker proxy and the
// app-LLM proxy. Covers the SSE tee parser (fragmented chunks, CRLF,
// multi-line data, comments) and the forward-header builder
// (hop-by-hop + credential stripping, key injection), and the forward to
// OpenRouter itself (task 2275).
//
// Run with: node --test tests/anthropic-stream.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeSseTee, buildForwardHeaders, HOP_BY_HOP } = require('../src/services/anthropic-stream');

test('SSE tee parses a complete event', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed('event: message_start\ndata: {"a":1}\n\n');
  assert.deepEqual(events, [{ event: 'message_start', data: '{"a":1}' }]);
});

test('SSE tee handles events fragmented across chunks', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed('event: messa');
  feed('ge_delta\nda');
  feed('ta: {"usage":{"output_tokens"');
  feed(':42}}\n');
  assert.equal(events.length, 0, 'no event until the blank-line terminator');
  feed('\n');
  assert.deepEqual(events, [{ event: 'message_delta', data: '{"usage":{"output_tokens":42}}' }]);
});

test('SSE tee joins multiple data lines with newlines', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed('data: line1\ndata: line2\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'line1\nline2' }]);
});

test('SSE tee strips CR and ignores comments', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed(': heartbeat\r\nevent: ping\r\ndata: {}\r\n\r\n');
  assert.deepEqual(events, [{ event: 'ping', data: '{}' }]);
});

test('SSE tee survives a throwing handler', () => {
  let calls = 0;
  const feed = makeSseTee(() => { calls++; throw new Error('boom'); });
  feed('data: one\n\ndata: two\n\n');
  assert.equal(calls, 2, 'second event still delivered after the first handler threw');
});

test('buildForwardHeaders keeps only the Messages headers, drops every credential, injects the key as a bearer', () => {
  const fwd = buildForwardHeaders({
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    connection: 'keep-alive',
    host: 'usernode:3000',
    'content-length': '123',
    'x-api-key': 'caller-jwt-or-token',
    authorization: 'Bearer caller-token',
    'x-usernode-app-token': 'a'.repeat(64),
    'x-usernode-user-token': 'user.jwt.here',
    cookie: 'session=secret',
  }, 'sk-or-real', { origin: 'https://homeroom.example' });

  // Task 2275: the upstream is OpenRouter, which takes the key as a bearer
  // token; nothing the caller sent as a credential travels.
  assert.equal(fwd.authorization, 'Bearer sk-or-real');
  assert.equal(fwd['anthropic-version'], '2023-06-01');
  assert.equal(fwd['content-type'], 'application/json');
  assert.equal(fwd['HTTP-Referer'], 'https://homeroom.example');
  for (const gone of ['connection', 'host', 'content-length', 'x-api-key',
    'x-usernode-app-token', 'x-usernode-user-token', 'cookie']) {
    assert.equal(fwd[gone], undefined, `${gone} must not be forwarded`);
  }
});

test('buildForwardHeaders joins array header values', () => {
  const fwd = buildForwardHeaders({ 'anthropic-beta': ['a', 'b'] }, 'k');
  assert.equal(fwd['anthropic-beta'], 'a, b');
});

test('HOP_BY_HOP covers the RFC 7230 set', () => {
  for (const h of ['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    assert.ok(HOP_BY_HOP.has(h), h);
  }
});

// ── Task 2275: the forward itself, to OpenRouter ────────────────────────
//
// Both relays forward through forwardCall. Driven end to end here: a real
// express request in, the upstream answered by a fake fetch (OpenRouter's
// own HTTP answer, not a hand-built error), the response read back.

const http = require('node:http');
const express = require('express');
const { forwardCall } = require('../src/services/anthropic-stream');

async function relay(body, upstream) {
  const sent = [];
  const prevFetch = globalThis.fetch;
  const app = express();
  app.use(express.json());
  let result = null;
  app.post('/v1/messages', async (req, res) => {
    result = await forwardCall({
      req, res, upstreamUrl: 'https://openrouter.test/api/v1/messages', apiKey: 'sk-or-platform',
      origin: 'https://homeroom.example', logTag: 'test',
    });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return prevFetch(url, init);
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return upstream();
  };
  try {
    const res = await prevFetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'relay-token', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text(), sent, result };
  } finally {
    globalThis.fetch = prevFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a Claude call goes up mapped, denied and on the bearer key; the stream\'s cost is OpenRouter\'s own figure', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"anthropic/claude-sonnet-5.5","usage":{"input_tokens":100,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello there"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":20,"cost":0.0125}}',
    '',
    '',
  ].join('\n');
  const out = await relay(
    { model: 'claude-sonnet-5-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }], provider: { data_collection: 'allow' } },
    () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  assert.equal(out.status, 200);
  assert.match(out.text, /Hello there/, 'the stream reaches the caller');
  assert.equal(out.sent.length, 1);
  assert.equal(out.sent[0].body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(out.sent[0].body.provider.data_collection, 'deny');
  assert.equal(out.sent[0].headers.authorization, 'Bearer sk-or-platform');
  assert.equal(out.sent[0].headers['x-api-key'], undefined, 'the relay token never travels');
  assert.equal(out.result.costCents, 1.25, 'usage.cost, in cents');
});

test('a model that is not Claude is refused at the relay, and nothing goes upstream', async () => {
  const out = await relay(
    { model: 'openai/gpt-6-astra', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] },
    () => { throw new Error('must not be called'); },
  );
  assert.equal(out.status, 400);
  assert.equal(JSON.parse(out.text).code, 'unsupported_model');
  assert.equal(out.sent.length, 0);
  assert.equal(out.result.costCents, 0);
});

test('OpenRouter\'s refusal (its 402 for credit) reaches the caller as it came', async () => {
  const out = await relay(
    { model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
    () => new Response('{"error":{"message":"Insufficient credits","code":402}}', { status: 402, headers: { 'content-type': 'application/json' } }),
  );
  assert.equal(out.status, 402);
  assert.match(out.text, /Insufficient credits/);
  assert.equal(out.result.costCents, 0);
  // #6898's one reading, for the relay to record the outage by.
  assert.equal(out.result.refusal, 'credit_out');
});

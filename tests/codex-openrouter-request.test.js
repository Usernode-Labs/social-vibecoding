'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startRequestAdapter } = require('../worker/codex-openrouter-request');
const { buildCatalogFromEnvironment } = require('../worker/build-codex-model-catalog');
const codex = require('../src/agents/codex-openrouter');

const MODEL = 'z-ai/glm-5.3-flash';
const KEY = 'test-openrouter-key';

async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}/api/v1`;
}

async function adapter(t, baseUrl, options = {}) {
  const instance = await startRequestAdapter({ baseUrl, apiKey: KEY, model: MODEL, maxOutputTokens: 32000, ...options });
  t.after(() => instance.close());
  return instance;
}

function request(instance, body, options = {}) {
  return fetch(`${instance.baseUrl}/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), ...options,
  });
}

async function json(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('the wire cap is enforced on every GLM request, independently of history size', async t => {
  const calls = [];
  const base = await upstream(t, async (req, res) => {
    calls.push({ url: req.url, headers: req.headers, body: await json(req) });
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-glm-1' });
    res.end('{"id":"response-1"}');
  });
  const diagnostics = [];
  const instance = await adapter(t, base, { onRequest: d => diagnostics.push(d) });
  const original = {
    model: MODEL, stream: true, instructions: 'coding instructions',
    input: [{ role: 'user', content: 'Short request ☀' }],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' }, store: false, parallel_tool_calls: true,
  };
  const bodies = [
    original,
    { ...original, input: [{ role: 'user', content: 'long history '.repeat(20000) }] },
    { ...original, instructions: 'Summarize the conversation', max_output_tokens: 128000 },
    { ...original, max_output_tokens: 8000 },
  ];
  for (const body of bodies) {
    const response = await request(instance, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-glm-1');
    assert.deepEqual(await response.json(), { id: 'response-1' });
  }
  assert.deepEqual(calls.map(c => c.body.max_output_tokens), [32000, 32000, 32000, 8000]);
  for (let i = 0; i < calls.length; i++) {
    assert.equal(calls[i].url, '/api/v1/responses');
    assert.equal(calls[i].headers.authorization, `Bearer ${KEY}`);
    const { max_output_tokens: _cap, ...rest } = calls[i].body;
    const { max_output_tokens: _originalCap, ...expected } = bodies[i];
    assert.deepEqual(rest, expected, 'the adapter must preserve tools, history and reasoning');
  }
  assert.equal(diagnostics[0].maxOutputTokens, 32000);
  assert.equal(diagnostics[0].inputBytes, Buffer.byteLength(JSON.stringify(original.input)));
  assert.equal(diagnostics[0].inputItems, 1);
  assert.equal(diagnostics[0].httpStatus, 200);
  assert.equal(diagnostics[0].requestId, 'req-glm-1');
  assert.doesNotMatch(JSON.stringify(diagnostics), /test-openrouter-key|coding instructions|Short request|long history/);
});

test('a real HTTP refusal is retried with the smaller limit on the wire and safe ledger evidence', async t => {
  // The attempt-loop's database behavior is covered in agent-ledger-codex;
  // this test connects its decision to the HTTP boundary without a paid call.
  const { codexMaxTokensRetry } = require('../src/routes/sessions');
  const caps = [];
  const routes = [];
  const base = await upstream(t, async (req, res) => {
    routes.push(req.url);
    if (req.url === '/api/v1/key') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: {
        limit: 100, limit_remaining: 85, limit_reset: 'weekly',
        label: 'private@example.test', hash: 'private-key-hash', usage: 15,
      } }));
      return;
    }
    const body = await json(req);
    caps.push(body.max_output_tokens);
    if (body.max_output_tokens > 16000) {
      res.writeHead(402, { 'content-type': 'application/json', 'x-request-id': 'req-refused' });
      res.end(JSON.stringify({ error: {
        message: `This request requires more credits, or fewer max_tokens. You requested up to ${body.max_output_tokens} tokens, but can only afford 16000.`,
      } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"response-retry"}');
    }
  });
  const state = codex.newCodexState();
  const first = await adapter(t, base, { onRequest: diagnostic => codex.normalizeCodexLine(JSON.stringify({
    type: 'usernode.openrouter.request', diagnostic,
  }), state) });
  const response = await request(first, { model: MODEL, input: [{ role: 'user', content: 'Hello' }] });
  assert.equal(response.status, 402);
  codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: (await response.json()).error }), state);
  const retry = codexMaxTokensRetry(state);
  assert.deepEqual(retry, { clamped: 12800 });
  // The same catalog path the runner uses supplies the next invocation.
  const catalog = buildCatalogFromEnvironment({
    AGENT_MODEL: MODEL, AGENT_MODEL_MAX_OUTPUT_TOKENS: String(retry.clamped),
  });
  const second = await adapter(t, base, { maxOutputTokens: catalog.models[0].max_output_tokens });
  const success = await request(second, { model: MODEL, input: [{ role: 'user', content: 'Hello' }] });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).id, 'response-retry');
  assert.deepEqual(caps, [32000, 12800]);
  assert.deepEqual(routes, ['/api/v1/responses', '/api/v1/key', '/api/v1/responses']);
  const evidence = codex.providerFailureDiagnostics(state);
  assert.equal(evidence.requestedOutputTokens, 32000);
  assert.equal(evidence.affordableOutputTokens, 16000);
  assert.equal(evidence.request.keyRemainingUsd, 85);
  assert.equal(evidence.request.keyLimitReset, 'weekly');
  assert.equal(evidence.request.requestId, 'req-refused');
  assert.doesNotMatch(JSON.stringify(evidence), /private@|private-key-hash|test-openrouter-key|Hello/);
});

test('streaming is forwarded before completion and cancellation closes the upstream request', async t => {
  let finish;
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const base = await upstream(t, async (req, res) => {
    await json(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"delta":"hello"}\n\n');
    finish = () => res.end('event: response.completed\ndata: {}\n\n');
    res.on('close', disconnected);
  });
  const instance = await adapter(t, base);
  const controller = new AbortController();
  const response = await request(instance, { model: MODEL, stream: true, input: [] }, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(Buffer.from(first.value).toString(), /hello/);
  assert.equal(typeof finish, 'function', 'first chunk arrives while the upstream response is still open');
  controller.abort();
  await closed;
});

test('key lookup failure never replaces the original provider refusal', async t => {
  const diagnostics = [];
  const original = '{"error":{"message":"This request requires more credits, or fewer max_tokens."}}';
  const base = await upstream(t, (req, res) => {
    req.resume();
    res.writeHead(req.url.endsWith('/key') ? 403 : 402, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/key') ? '{"error":"lookup forbidden"}' : original);
  });
  const instance = await adapter(t, base, { onRequest: d => diagnostics.push(d) });
  const response = await request(instance, { model: MODEL, input: [] });
  assert.equal(response.status, 402);
  assert.equal(await response.text(), original);
  assert.equal(diagnostics[0].keyLookupStatus, 403);
  assert.equal(diagnostics[0].keyRemainingUsd, undefined);
});

test('HTTP and streamed 402 metadata identify the actual limiting budget with an unlimited key', async t => {
  for (const streamed of [false, true]) {
    for (const [source, reason, wording] of [
      ['openrouter_in_flight_budget', 'in_flight_budget_exhausted', /running or recently completed requests.*7 seconds/],
      ['openrouter_key_limit', null, /API key’s spending limit has been reached/],
      ['openrouter_credits', 'weight_exceeds_budget', /estimated cost.*even when the account has credit/],
    ]) {
      await t.test(`${streamed ? 'SSE' : 'HTTP'} ${source}`, async sub => {
        const payload = { error: { code: 402, message: 'Request refused', metadata: {
          limit_source: source, reason, remedy_hint: 'private freeform detail', raw: 'secret provider body',
        } } };
        const body = streamed ? `event: response.failed\r\ndata: ${JSON.stringify({
          type: 'response.failed', response: payload,
        })}\r\n\r\n` : JSON.stringify(payload);
        let keyCalls = 0;
        const base = await upstream(sub, (req, res) => {
          req.resume();
          if (req.url.endsWith('/key')) {
            keyCalls++;
            res.setHeader('content-type', 'application/json');
            res.end('{"data":{"limit":null,"limit_remaining":null}}');
            return;
          }
          res.writeHead(streamed ? 200 : 402, {
            'content-type': streamed ? 'text/event-stream' : 'application/json', 'retry-after': '7',
          });
          res.write(body.slice(0, 70));
          setImmediate(() => res.end(body.slice(70)));
        });
        const state = codex.newCodexState();
        const instance = await adapter(sub, base, { onRequest: diagnostic => {
          codex.normalizeCodexLine(JSON.stringify({ type: 'usernode.openrouter.request', diagnostic }), state);
        } });
        const response = await request(instance, { model: MODEL, input: [] });
        assert.equal(response.status, streamed ? 200 : 402);
        assert.equal(await response.text(), body, 'the provider response is forwarded byte for byte');
        const events = codex.normalizeCodexLine(JSON.stringify({
          type: 'turn.failed', error: { message: 'stream disconnected before completion: Request refused' },
        }), state);
        assert.equal(state.agentErrorCode, 'insufficient_credits', 'the recorded 402 survives a stripped CLI message');
        assert.equal(state.providerRequest.limitSource, source);
        assert.equal(state.providerRequest.keyLimitUsd, null, 'unlimited is not zero credit');
        assert.equal(state.providerRequest.keyRemainingUsd, null);
        assert.equal(keyCalls, 1, 'HTTP and body diagnostics share a single key lookup');
        assert.match(events[0].text, wording);
        assert.doesNotMatch(events[0].text, /out of credit|agent needs more|Top up/);
        assert.doesNotMatch(JSON.stringify(codex.providerFailureDiagnostics(state)), /private freeform|secret provider/);
      });
    }
  }
});

test('large SSE output stays intact and does not hide a later provider refusal', async t => {
  const text = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'λ'.repeat(80000) })}\n\n`;
  const refusal = `data: ${JSON.stringify({ type: 'error', error: {
    code: 402, message: 'provider refused', metadata: { provider_name: 'Test Provider' },
  } })}\n\n`;
  const base = await upstream(t, (req, res) => {
    req.resume();
    if (req.url.endsWith('/key')) { res.end('{"data":{"limit":null}}'); return; }
    res.setHeader('content-type', 'text/event-stream');
    res.write(text.slice(0, 70000));
    setImmediate(() => res.end(text.slice(70000) + refusal));
  });
  const diagnostics = [];
  const instance = await adapter(t, base, { onRequest: d => diagnostics.push(d) });
  const response = await request(instance, { model: MODEL, stream: true, input: [] });
  assert.equal(await response.text(), text + refusal);
  assert.equal(diagnostics.at(-1).providerName, 'Test Provider');
  assert.equal(diagnostics.at(-1).providerErrorStatus, 402);
  assert.doesNotMatch(JSON.stringify(diagnostics), /λ|provider refused/);
});

test('only the selected model and authenticated Responses requests reach the provider', async t => {
  let upstreamCalls = 0;
  const base = await upstream(t, (req, res) => {
    upstreamCalls++;
    req.resume();
    res.end('{}');
  });
  const instance = await adapter(t, base);
  const cases = [
    [{ model: 'another/model', input: [] }, {}, 400],
    [{ model: MODEL }, { headers: { authorization: 'Bearer wrong' } }, 401],
    [{ model: MODEL }, { headers: { authorization: `Bearer ${KEY}`, 'content-encoding': 'gzip' } }, 415],
    ...[0, -1, 1.5, '32000'].map(max_output_tokens => [{ model: MODEL, max_output_tokens }, {}, 400]),
  ];
  for (const [body, options, expected] of cases) {
    const response = await request(instance, body, options);
    assert.equal(response.status, expected);
    await response.body.cancel();
  }
  const wrongRoute = await fetch(`${instance.baseUrl}/key`);
  assert.equal(wrongRoute.status, 404);
  await wrongRoute.body.cancel();
  assert.equal(upstreamCalls, 0);
});

test('closing the invocation releases its listener', async t => {
  const base = await upstream(t, (req, res) => { req.resume(); res.end('{}'); });
  const instance = await startRequestAdapter({ baseUrl: base, apiKey: KEY, model: MODEL, maxOutputTokens: 32000 });
  await instance.close();
  // Use raw http so the suite's loopback fetch retry cannot hide lifecycle errors.
  await new Promise((resolve, reject) => {
    const req = http.get(`${instance.baseUrl}/responses`, () => reject(new Error('listener still open')));
    req.on('error', err => err.code === 'ECONNREFUSED' ? resolve() : reject(err));
  });
});

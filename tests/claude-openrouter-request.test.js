'use strict';

// #3296: worker/claude-openrouter-request.js lets Claude Code run an
// OpenRouter model without ever holding the user's key. These pin the
// adapter's policy (model pin, output cap, auth, routes, header allowlist),
// the environment Claude Code gets, redaction, and run-cc.sh driving it end
// to end against a stub `claude` and a fake OpenRouter.
//
// Run with: node --test tests/claude-openrouter-request.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const {
  startMessagesAdapter, applyTurnPolicy, makeRedactor, claudeChildEnv,
} = require('../worker/claude-openrouter-request');

const ROOT = path.join(__dirname, '..');
const GLM = 'z-ai/glm-5.3-flash';
const KEY = 'sk-or-v1-0123456789abcdef-user-key';

test('every request is pinned to the session model and capped at its output limit', () => {
  assert.deepEqual(
    applyTurnPolicy({ model: 'claude-haiku-4-5', max_tokens: 200_000, messages: [] },
      { model: GLM, maxOutputTokens: 64_000, countTokens: false }),
    { model: GLM, max_tokens: 64_000, messages: [] },
  );
  // A smaller ask is kept; a missing or invalid one gets the cap.
  assert.equal(applyTurnPolicy({ max_tokens: 4096 }, { model: GLM, maxOutputTokens: 64_000 }).max_tokens, 4096);
  assert.equal(applyTurnPolicy({}, { model: GLM, maxOutputTokens: 64_000 }).max_tokens, 64_000);
  assert.equal(applyTurnPolicy({ max_tokens: -1 }, { model: GLM, maxOutputTokens: 64_000 }).max_tokens, 64_000);
  // Unknown catalog limit: the ask passes through unchanged.
  assert.equal(applyTurnPolicy({ max_tokens: 32_000 }, { model: GLM, maxOutputTokens: null }).max_tokens, 32_000);
  // A thinking budget the cap would invalidate is dropped, not sent as a 400.
  const clamped = applyTurnPolicy(
    { max_tokens: 100_000, thinking: { type: 'enabled', budget_tokens: 80_000 } },
    { model: GLM, maxOutputTokens: 32_000 },
  );
  assert.equal(clamped.max_tokens, 32_000);
  assert.equal(clamped.thinking, undefined);
  const kept = applyTurnPolicy(
    { max_tokens: 100_000, thinking: { type: 'enabled', budget_tokens: 8_000 } },
    { model: GLM, maxOutputTokens: 32_000 },
  );
  assert.deepEqual(kept.thinking, { type: 'enabled', budget_tokens: 8_000 });
  // count_tokens carries no max_tokens; only the model is pinned.
  assert.deepEqual(
    applyTurnPolicy({ model: 'x', messages: [] }, { model: GLM, maxOutputTokens: 10, countTokens: true }),
    { model: GLM, messages: [] },
  );
});

test('images and documents become a note, because OpenRouter models run on text', () => {
  const body = applyTurnPolicy({
    model: 'x', max_tokens: 10,
    messages: [
      { role: 'user', content: 'plain string content stays' },
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'text', text: 'screenshot taken' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
        ] },
        { type: 'tool_result', tool_use_id: 't2', content: 'string result' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'CCCC' } },
      ] },
    ],
  }, { model: GLM, maxOutputTokens: 10 });
  assert.equal(body.messages[0].content, 'plain string content stays');
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'look' },
    { type: 'text', text: '[image omitted: this model reads text only]' },
  ]);
  assert.deepEqual(body.messages[2].content[0].content, [
    { type: 'text', text: 'screenshot taken' },
    { type: 'text', text: '[image omitted: this model reads text only]' },
  ]);
  assert.equal(body.messages[2].content[0].tool_use_id, 't1');
  assert.equal(body.messages[2].content[1].content, 'string result');
  assert.deepEqual(body.messages[2].content[2], { type: 'text', text: '[document omitted: this model reads text only]' });
  assert.ok(!JSON.stringify(body).includes('AAAA'));
});

test('Claude Code gets the adapter and a local token, never the key', () => {
  const env = claudeChildEnv({
    PATH: '/bin', OPENROUTER_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: 'stale', HOMEROOM_MCP_TOKEN: 'grant',
  }, { baseUrl: 'http://127.0.0.1:4000', localToken: 'local', model: GLM });
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000');
  assert.equal(env.ANTHROPIC_API_KEY, 'local');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.equal(env[name], GLM, name);
  }
  assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
  // The Homeroom bridge Claude spawns still needs its grant.
  assert.equal(env.HOMEROOM_MCP_TOKEN, 'grant');
  assert.equal(env.PATH, '/bin');
  assert.ok(!Object.values(env).includes(KEY));
});

test('redaction is literal and ignores values too short to be secrets', () => {
  const redact = makeRedactor([KEY, 'a+b(c)*grant-value', 'short', null, undefined]);
  assert.equal(redact(`key=${KEY} and ${KEY}`), 'key=**** and ****');
  assert.equal(redact('token a+b(c)*grant-value end'), 'token **** end');
  assert.equal(redact('a short line'), 'a short line');
});

async function fakeOpenRouter(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const record = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    seen.push(record);
    handler(record, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"z-ai/glm-5.3-flash","usage":{"input_tokens":12,"output_tokens":1}}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
}

test('the adapter forwards Messages requests to OpenRouter with the key and streams the reply back', async (t) => {
  const upstream = await fakeOpenRouter((record, res) => {
    if (record.url.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":42}');
    } else sse(res);
  });
  const timing = [];
  const adapter = await startMessagesAdapter({
    baseUrl: upstream.base, apiKey: KEY, model: GLM, maxOutputTokens: 64_000,
    localToken: 'local-token', onTiming: (event) => timing.push(event),
  });
  t.after(async () => { await adapter.close(); await upstream.close(); });

  const send = (pathname, { token = 'local-token', header = 'x-api-key', body } = {}) => fetch(`${adapter.baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-stainless-os': 'Linux',
      ...(header === 'x-api-key' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body || {
      model: 'claude-haiku-4-5', max_tokens: 200_000, stream: true,
      system: 'rules', messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  const reply = await send('/v1/messages?beta=true');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('x-request-id'), 'req-1');
  assert.match(await reply.text(), /message_stop/);
  const forwarded = upstream.seen[0];
  assert.equal(forwarded.url, '/api/v1/messages', 'the query string stays local');
  assert.equal(forwarded.headers.authorization, `Bearer ${KEY}`);
  assert.equal(forwarded.headers['x-api-key'], undefined, 'the local token never leaves the worker');
  assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
  assert.equal(forwarded.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(forwarded.headers['x-stainless-os'], undefined);
  assert.equal(forwarded.body.model, GLM);
  assert.equal(forwarded.body.max_tokens, 64_000);
  assert.deepEqual(forwarded.body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(timing.map((event) => event.kind), [
    'provider_request_start', 'provider_response_headers', 'provider_response_first_byte', 'provider_request_end',
  ]);
  assert.equal(timing[0].inputItems, 1);
  assert.equal(timing[0].maxOutputTokens, 64_000);
  assert.equal(timing[3].outcome, 'ok');
  assert.ok(!JSON.stringify(timing).includes('hi'), 'timing carries sizes and counts, never content');

  // Bearer auth is accepted too; count_tokens is forwarded without a cap.
  const count = await send('/v1/messages/count_tokens', {
    header: 'authorization', body: { model: 'claude-sonnet-5', messages: [] },
  });
  assert.equal(count.status, 200);
  assert.deepEqual(await count.json(), { input_tokens: 42 });
  assert.equal(upstream.seen[1].url, '/api/v1/messages/count_tokens');
  assert.deepEqual(upstream.seen[1].body, { model: GLM, messages: [] });
  assert.equal(timing.length, 4, 'count_tokens is not a model request');

  // Wrong token, wrong route, wrong method: refused locally.
  const denied = await send('/v1/messages', { token: 'guess' });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.type, 'authentication_error');
  const missing = await send('/v1/complete');
  assert.equal(missing.status, 404);
  const get = await fetch(`${adapter.baseUrl}/v1/messages`, { headers: { 'x-api-key': 'local-token' } });
  assert.equal(get.status, 404);
  const bad = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST', headers: { 'x-api-key': 'local-token' }, body: '[1,2]',
  });
  assert.equal(bad.status, 400);
  assert.equal(upstream.seen.length, 2, 'nothing refused locally reached OpenRouter');
});

test('an OpenRouter refusal reaches Claude Code unchanged', async (t) => {
  const upstream = await fakeOpenRouter((record, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end('{"error":{"code":402,"message":"Insufficient credits"}}');
  });
  const adapter = await startMessagesAdapter({
    baseUrl: upstream.base, apiKey: KEY, model: GLM, localToken: 'local-token',
  });
  t.after(async () => { await adapter.close(); await upstream.close(); });
  const reply = await fetch(`${adapter.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [] }),
  });
  assert.equal(reply.status, 402);
  assert.match(await reply.text(), /Insufficient credits/);
});

test('the adapter refuses a config it cannot enforce', async () => {
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: GLM, localToken: 't' }),
    /invalid_request_adapter_config/);
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, model: '', localToken: 't' }),
    /invalid_request_adapter_config/);
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'ftp://openrouter.ai/api/v1', apiKey: KEY, model: GLM, localToken: 't' }),
    /invalid_provider_url/);
  await assert.rejects(() => startMessagesAdapter({ baseUrl: 'https://u:p@openrouter.ai/api/v1', apiKey: KEY, model: GLM, localToken: 't' }),
    /invalid_provider_url/);
});

// ── run-cc.sh, end to end ─────────────────────────────────────────────

function runnerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-openrouter-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const runtimeLog = path.join(dir, 'claude-runtime.json');
  const gitLog = path.join(dir, 'git-env.log');
  const keyFile = path.join(dir, 'leaked-key.txt');
  fs.writeFileSync(keyFile, KEY);
  // A stand-in for the claude CLI: records what it was given, makes one
  // Messages call through ANTHROPIC_BASE_URL as the real CLI would, then
  // prints a key it "found" to prove the journal is scrubbed.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
(async () => {
  const reply = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 999999, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  const text = await reply.text();
  fs.writeFileSync(${JSON.stringify(runtimeLog)}, JSON.stringify({
    args: process.argv.slice(2), prompt, status: reply.status, streamed: text.includes('message_stop'),
    baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY || null,
    haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'found ' + fs.readFileSync(${JSON.stringify(keyFile)}, 'utf8') }] } }));
  console.log(JSON.stringify({ type: 'result', result: 'done', session_id: 'cc-or-1', usage: { input_tokens: 5, output_tokens: 7 } }));
  process.exitCode = 0;
})();
`);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo "git \${OPENROUTER_API_KEY:-unset}" >> ${JSON.stringify(gitLog)}
exit 0
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'find the bug');
  return { dir, bin, ws, prompt, runtimeLog, gitLog };
}

function runRunner(env) {
  return new Promise((resolve) => {
    const child = spawn('sh', [path.join(ROOT, 'worker', 'run-cc.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('run-cc.sh runs an OpenRouter scout through the adapter with the key out of every other process', async (t) => {
  const upstream = await fakeOpenRouter((record, res) => sse(res));
  t.after(() => upstream.close());
  const fx = runnerFixture();
  const env = {
    PATH: `${fx.bin}:${process.env.PATH}`,
    HOME: fx.dir,
    PROMPT_FILE: fx.prompt, BRANCH: 'smoke', SESSION_ID: '1', PLATFORM_URL: 'http://platform',
    MODE: 'scout', WORKSPACE_DIR: fx.ws,
    AGENT_PROVIDER: 'openrouter', MODEL: GLM, AGENT_MODEL: GLM,
    AGENT_MODEL_MAX_OUTPUT_TOKENS: '64000',
    OPENROUTER_API_KEY: KEY, OPENROUTER_API_BASE: upstream.base,
    BROWSER_MCP_CONFIG: path.join(fx.dir, 'absent.json'),
  };
  const { code, out } = await runRunner(env);
  assert.equal(code, 0, out);

  const runtime = JSON.parse(fs.readFileSync(fx.runtimeLog, 'utf8'));
  assert.equal(runtime.prompt, 'find the bug', 'the prompt still arrives on stdin');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.streamed, true);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(runtime.apiKey, KEY);
  assert.equal(runtime.openrouterKey, null, 'Claude Code and its Bash never see the key');
  assert.equal(runtime.haiku, GLM);
  const at = runtime.args.indexOf('--model');
  assert.equal(runtime.args[at + 1], GLM);
  const disallowed = runtime.args.indexOf('--disallowed-tools');
  assert.deepEqual(runtime.args.slice(disallowed, disallowed + 5),
    ['--disallowed-tools', 'Edit', 'Write', 'NotebookEdit', 'WebSearch']);

  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(upstream.seen[0].body.model, GLM);
  assert.equal(upstream.seen[0].body.max_tokens, 64_000);

  assert.ok(!out.includes(KEY), 'the journal never carries the key');
  assert.match(out, /found \*\*\*\*/);
  assert.match(out, /__USERNODE_CODING_PROVIDER__ \{"kind":"provider_request_start"/);
  assert.match(out, /__USERNODE_RESULT__ cc_exit=0 .*mode=scout/);
  assert.ok(fs.readFileSync(fx.gitLog, 'utf8').split('\n').filter(Boolean).every((line) => line === 'git unset'),
    'git runs without the key in its environment');
});

test('run-cc.sh refuses OpenRouter modes and configs it cannot run safely', async () => {
  const fx = runnerFixture();
  const base = {
    PATH: `${fx.bin}:${process.env.PATH}`, HOME: fx.dir,
    PROMPT_FILE: fx.prompt, BRANCH: 'smoke', SESSION_ID: '1', PLATFORM_URL: 'http://platform',
    WORKSPACE_DIR: fx.ws, WORKER_JWT: 'push', AGENT_PROVIDER: 'openrouter',
    MODEL: GLM, AGENT_MODEL: GLM, OPENROUTER_API_KEY: KEY,
  };
  const sync = await runRunner({ ...base, MODE: 'sync' });
  assert.notEqual(sync.code, 0);
  assert.match(sync.out, /__USERNODE_ERROR__ Claude over OpenRouter supports build and scout turns, not sync/);
  const noKey = await runRunner({ ...base, MODE: 'scout', OPENROUTER_API_KEY: '' });
  assert.match(noKey.out, /__USERNODE_ERROR__ OPENROUTER_API_KEY required/);
  const noModel = await runRunner({ ...base, MODE: 'scout', AGENT_MODEL: '' });
  assert.match(noModel.out, /__USERNODE_ERROR__ AGENT_MODEL required/);
  const unknown = await runRunner({ ...base, MODE: 'scout', AGENT_PROVIDER: 'bedrock' });
  assert.match(unknown.out, /__USERNODE_ERROR__ unknown AGENT_PROVIDER: bedrock/);
  assert.ok(!fs.existsSync(fx.runtimeLog), 'claude never started');
  // An Anthropic build still requires the separate system context; an
  // OpenRouter build carries it inline like a Codex build does.
  const anthropicBuild = await runRunner({ ...base, MODE: 'build', AGENT_PROVIDER: 'anthropic' });
  assert.match(anthropicBuild.out, /__USERNODE_ERROR__ SYSTEM_PROMPT_FILE required for build mode/);
});

test('the worker image ships the adapter beside the runner', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'worker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY claude-openrouter-request\.js \/usr\/local\/bin\/claude-openrouter-request\.js/);
  const runner = fs.readFileSync(path.join(ROOT, 'worker', 'run-cc.sh'), 'utf8');
  assert.match(runner, /node "\$\(dirname "\$0"\)\/claude-openrouter-request\.js" "\$@"/);
  // Still no platform relay, for either harness.
  assert.ok(!/internal\/openrouter/.test(runner));
  const adapter = fs.readFileSync(path.join(ROOT, 'worker', 'claude-openrouter-request.js'), 'utf8');
  assert.ok(!/internal\/openrouter|PLATFORM_URL/.test(adapter));
});

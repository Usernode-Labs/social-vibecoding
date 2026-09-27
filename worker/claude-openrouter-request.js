#!/usr/bin/env node
'use strict';

// Claude Code over OpenRouter (#3296). Some OpenRouter models do better in
// Claude Code than in Codex, so the platform can run an OpenRouter turn with
// the `claude` CLI instead. OpenRouter serves Anthropic's Messages API, and
// Claude Code honours ANTHROPIC_BASE_URL, but pointing the CLI straight at
// OpenRouter would put the user's key in Claude Code's own environment, where
// every Bash command the agent runs inherits it.
//
// So this wrapper does what worker/codex-openrouter-request.js does for
// Codex: a listener on 127.0.0.1, alive for one invocation, holds the turn's
// key and forwards to the configured provider. There is no platform relay.
// Claude Code gets the listener's address and a random per-invocation token;
// the key is removed from its environment, and the key and the Homeroom
// grant are scrubbed from everything it prints.
//
// The listener also enforces what the platform chose for the turn: every
// request is pinned to the session's model (Claude Code's background calls
// ask for a Haiku alias, which would bill a different model to the user's
// key), a reply is capped at the model's catalog output limit, and images are
// replaced with a note, because the platform runs OpenRouter models on text.
//
//   node claude-openrouter-request.js <claude arguments...>
//
// Env: OPENROUTER_API_KEY, AGENT_MODEL (required); OPENROUTER_API_BASE,
// AGENT_MODEL_MAX_OUTPUT_TOKENS, HOMEROOM_MCP_TOKEN, MODE (optional).

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { constants: { signals } } = require('node:os');
const { performance } = require('node:perf_hooks');

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
// The only request headers that carry meaning upstream. Everything else
// Claude Code sends (its own client identity, the local token) stays here.
const FORWARDED_REQUEST_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta'];
const ROUTES = new Map([
  ['/v1/messages', '/messages'],
  ['/v1/messages/count_tokens', '/messages/count_tokens'],
]);

async function readBounded(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// Anthropic's error envelope, so Claude Code reports a refusal in its own
// words instead of failing to parse one.
function replyError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function sameSecret(presented, expected) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function presentedToken(headers) {
  if (typeof headers['x-api-key'] === 'string') return headers['x-api-key'];
  const auth = headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// The platform gives every OpenRouter model text only, as Codex's model
// catalog does (input_modalities: ['text']). Claude Code would otherwise send
// a screenshot or an image it Read as an image block, which a text-only model
// refuses and which fails the whole request. A PDF arrives the same way.
const NON_TEXT_BLOCKS = new Map([
  ['image', '[image omitted: this model reads text only]'],
  ['document', '[document omitted: this model reads text only]'],
]);

function textOnly(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (NON_TEXT_BLOCKS.has(block.type)) return { type: 'text', text: NON_TEXT_BLOCKS.get(block.type) };
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return { ...block, content: textOnly(block.content) };
    }
    return block;
  });
}

// Pin the model, cap the reply and keep the input text. Exported for tests:
// this is the policy.
function applyTurnPolicy(body, { model, maxOutputTokens, countTokens }) {
  body.model = model;
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => (message && Array.isArray(message.content)
      ? { ...message, content: textOnly(message.content) }
      : message));
  }
  if (countTokens) return body;
  if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) {
    const asked = body.max_tokens;
    body.max_tokens = Number.isSafeInteger(asked) && asked > 0
      ? Math.min(asked, maxOutputTokens)
      : maxOutputTokens;
  }
  // Anthropic's rule: the thinking budget must sit below max_tokens. A cap
  // that lands under it would turn every request into a 400, so drop the
  // explicit budget and let the model think at its own default instead.
  const budget = body.thinking?.budget_tokens;
  if (Number.isSafeInteger(budget) && Number.isSafeInteger(body.max_tokens)
      && budget >= body.max_tokens) {
    delete body.thinking;
  }
  return body;
}

async function startMessagesAdapter({
  baseUrl, apiKey, model, maxOutputTokens = null, localToken,
  onTiming = null, timingIntervalMs = 15_000, fetchImpl = fetch,
}) {
  const base = new URL(baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid_provider_url');
  }
  if (!apiKey || !model || !localToken) throw new Error('invalid_request_adapter_config');
  const upstreamBase = base.href.replace(/\/+$/, '');
  const active = new Set();
  let requestOrdinal = 0;
  const emitTiming = (event) => {
    if (!onTiming) return;
    try { onTiming(event); } catch { /* Telemetry cannot affect the provider request. */ }
  };

  const server = http.createServer(async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    const upstreamPath = ROUTES.get(pathname);
    if (req.method !== 'POST' || !upstreamPath) {
      replyError(res, 404, 'not_found_error', 'Unsupported OpenRouter adapter route');
      return;
    }
    if (!sameSecret(presentedToken(req.headers), localToken)) {
      replyError(res, 401, 'authentication_error', 'OpenRouter adapter authentication failed');
      return;
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      replyError(res, 415, 'invalid_request_error', 'Unsupported OpenRouter request encoding');
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => controller.abort());
    const countTokens = pathname.endsWith('/count_tokens');
    let timing = null;
    try {
      let body;
      try {
        body = JSON.parse((await readBounded(req, MAX_REQUEST_BYTES)).toString());
      } catch {
        replyError(res, 400, 'invalid_request_error', 'Invalid OpenRouter request body');
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        replyError(res, 400, 'invalid_request_error', 'Invalid OpenRouter request body');
        return;
      }
      applyTurnPolicy(body, { model, maxOutputTokens, countTokens });
      const serializedBody = JSON.stringify(body);
      if (onTiming && !countTokens) {
        // Sizes and counts only: the request's content never leaves here.
        const ordinal = ++requestOrdinal;
        const startedAt = performance.now();
        timing = { ordinal, startedAt, stage: 'await_headers', status: null,
          responseBytes: 0, chunks: 0, outcome: 'ok' };
        emitTiming({
          kind: 'provider_request_start', requestOrdinal: ordinal,
          payloadBytes: Buffer.byteLength(serializedBody),
          inputBytes: body.messages == null ? 0 : Buffer.byteLength(JSON.stringify(body.messages)),
          instructionBytes: body.system == null ? 0 : Buffer.byteLength(JSON.stringify(body.system)),
          inputItems: Array.isArray(body.messages) ? body.messages.length : null,
          previousResponseLinked: false,
          maxOutputTokens: body.max_tokens,
        });
        timing.interval = setInterval(() => emitTiming({
          kind: 'provider_request_pending', requestOrdinal: ordinal,
          stage: timing.stage,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          responseBytes: Math.min(timing.responseBytes, 10_000_000),
          chunkCount: Math.min(timing.chunks, 1000),
        }), timingIntervalMs);
        timing.interval.unref?.();
      }
      const headers = {
        'content-type': 'application/json',
        'accept-encoding': 'identity',
        authorization: `Bearer ${apiKey}`,
      };
      for (const name of FORWARDED_REQUEST_HEADERS) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      const response = await fetchImpl(`${upstreamBase}${upstreamPath}`, {
        method: 'POST', headers, body: serializedBody, redirect: 'error', signal: controller.signal,
      });
      if (timing) {
        timing.status = response.status;
        timing.stage = 'await_first_byte';
        timing.outcome = response.status >= 400 ? 'http_error' : 'ok';
        emitTiming({ kind: 'provider_response_headers', requestOrdinal: timing.ordinal,
          httpStatus: response.status,
          durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)) });
      }
      const responseHeaders = {};
      const responseConnectionHeaders = new Set(String(response.headers.get('connection') || '')
        .toLowerCase().split(',').map(s => s.trim()));
      for (const [name, value] of response.headers) {
        // fetch decodes compressed bodies; do not forward their old length or
        // encoding. Everything else, including provider request ids, survives.
        if (!HOP_HEADERS.has(name) && !responseConnectionHeaders.has(name) && name !== 'content-encoding') {
          responseHeaders[name] = value;
        }
      }
      res.writeHead(response.status, responseHeaders);
      if (!response.body) {
        res.end();
        return;
      }
      const bodyStream = Readable.fromWeb(response.body);
      if (timing) {
        async function* observeTransfer() {
          for await (const chunk of bodyStream) {
            timing.responseBytes += chunk.length;
            timing.chunks += 1;
            if (timing.stage === 'await_first_byte') {
              timing.stage = 'streaming';
              emitTiming({ kind: 'provider_response_first_byte', requestOrdinal: timing.ordinal,
                durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)) });
            }
            yield chunk;
          }
        }
        await pipeline(Readable.from(observeTransfer()), res);
      } else {
        await pipeline(bodyStream, res);
      }
    } catch {
      if (timing) timing.outcome = controller.signal.aborted ? 'cancelled'
        : timing.stage === 'await_headers' ? 'network_error' : 'stream_error';
      if (!res.headersSent && !res.destroyed) replyError(res, 502, 'api_error', 'OpenRouter request transport failed');
      else res.destroy();
    } finally {
      if (timing) {
        clearInterval(timing.interval);
        emitTiming({ kind: 'provider_request_end', requestOrdinal: timing.ordinal,
          outcome: timing.outcome, stage: timing.stage,
          ...(timing.status != null ? { httpStatus: timing.status } : {}),
          durationMs: Math.max(0, Math.round(performance.now() - timing.startedAt)),
          responseBytes: Math.min(timing.responseBytes, 10_000_000),
          chunkCount: Math.min(timing.chunks, 1000),
        });
      }
      active.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    activeRequestCount() { return active.size; },
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// Literal replacement (split/join, never a regex), so a secret containing
// regex metacharacters is scrubbed exactly. Short values are ignored rather
// than turning ordinary words into asterisks.
function makeRedactor(secrets) {
  const list = [...new Set(secrets.filter(v => typeof v === 'string' && v.length >= 8))];
  return line => list.reduce((out, secret) => out.split(secret).join('****'), line);
}

// The environment Claude Code runs with. Exported for tests: the key must not
// be in it, and every model alias must resolve to the session's model.
function claudeChildEnv(env, { baseUrl, localToken, model }) {
  const child = { ...env };
  delete child.OPENROUTER_API_KEY;
  delete child.ANTHROPIC_AUTH_TOKEN;
  Object.assign(child, {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: localToken,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    // Anthropic-only beta headers mean nothing to another provider and are
    // the usual reason a gateway rejects a Claude Code request.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  });
  return child;
}

async function runClaude(args, env = process.env) {
  const model = env.AGENT_MODEL;
  const maxOutputTokens = Number(env.AGENT_MODEL_MAX_OUTPUT_TOKENS);
  const localToken = crypto.randomBytes(32).toString('hex');
  const adapter = await startMessagesAdapter({
    baseUrl: env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY,
    model,
    maxOutputTokens: Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null,
    localToken,
    // The same content-free request timing a Codex turn reports, so a quiet
    // model call shows in the owner's progress log either way.
    onTiming: diagnostic => process.stdout.write(`__USERNODE_CODING_PROVIDER__ ${JSON.stringify(diagnostic)}\n`),
  });
  const redact = makeRedactor([env.OPENROUTER_API_KEY, env.HOMEROOM_MCP_TOKEN]);
  const child = spawn('claude', args, {
    env: claudeChildEnv(env, { baseUrl: adapter.baseUrl, localToken, model }),
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  // Serialize complete lines from both child streams and our diagnostics so
  // a diagnostic cannot land halfway through a large stream-json event.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Infinity })
      .on('line', line => process.stdout.write(`${redact(line)}\n`));
  }
  let killTimer;
  const stop = signal => {
    child.kill(signal);
    killTimer ||= setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signals[signal] ? 128 + signals[signal] : 1)));
    });
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    clearTimeout(killTimer);
    await adapter.close();
  }
}

if (require.main === module) {
  runClaude(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stdout.write('__USERNODE_ERROR__ Could not start the OpenRouter request adapter for Claude Code\n');
    process.exitCode = 1;
  });
}

module.exports = {
  startMessagesAdapter, applyTurnPolicy, makeRedactor, claudeChildEnv, runClaude,
};

#!/usr/bin/env node
'use strict';

// Codex 0.146.0 ignores max_output_tokens in its model catalog. Enforce it
// at the HTTP boundary until the CLI can serialize it itself. This listener
// lives only inside the worker, for one invocation, and talks to the configured
// provider using that turn's key, without a central platform relay.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');
const { constants: { signals } } = require('node:os');

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_KEY_RESPONSE_BYTES = 32 * 1024;
const MAX_ERROR_DIAGNOSTIC_BYTES = 64 * 1024;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
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

function replyError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, code: status } }));
}

function safeRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;
}

// Observe only small HTTP error envelopes while forwarding their bytes
// unchanged. Large/non-JSON bodies still reach Codex; diagnostics must never
// replace the refusal.
async function* observeErrorBody(body, recordError) {
  let chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes <= MAX_ERROR_DIAGNOSTIC_BYTES) chunks.push(Buffer.from(chunk));
    else chunks = [];
    yield chunk;
  }
  if (bytes > MAX_ERROR_DIAGNOSTIC_BYTES) return;
  try {
    const { error } = JSON.parse(Buffer.concat(chunks).toString());
    await recordError(error);
  } catch { /* Malformed provider diagnostics do not alter the response. */ }
}

async function* observeEventStream(body, recordError) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  for await (const chunk of body) {
    pending += decoder.write(Buffer.from(chunk));
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      if (!oversized && event.length <= MAX_ERROR_DIAGNOSTIC_BYTES) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        try {
          const parsed = JSON.parse(data);
          await recordError(parsed?.error || parsed?.response?.error || (parsed?.type === 'error' ? parsed : null));
        } catch { /* Non-JSON events, including [DONE], pass through. */ }
      }
      oversized = false;
    }
    // Long text/image events need no inspection. Retain only enough bytes
    // to recognize a split separator, then resume at the next event.
    if (pending.length > MAX_ERROR_DIAGNOSTIC_BYTES) {
      pending = pending.slice(-3);
      oversized = true;
    }
    yield chunk;
  }
}

async function readKeyAllowance(base, apiKey, fetchImpl, signal) {
  // /key describes this exact key. Account-wide /credits needs a management
  // key and is deliberately not called. An unlimited key is reported as null,
  // which says nothing about the account's remaining credit.
  try {
    const response = await fetchImpl(`${base}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { keyLookupStatus: response.status };
    }
    const { data } = JSON.parse((await readBounded(response.body, MAX_KEY_RESPONSE_BYTES)).toString());
    const money = (n) => typeof n === 'number' && Number.isFinite(n) ? n : null;
    return {
      keyLookupStatus: response.status,
      keyLimitUsd: money(data?.limit),
      keyRemainingUsd: money(data?.limit_remaining),
      keyLimitReset: ['daily', 'weekly', 'monthly'].includes(data?.limit_reset) ? data.limit_reset : null,
    };
  } catch {
    // Diagnostic failure must not replace the original provider rejection.
    return { keyLookupStatus: null };
  }
}

async function startRequestAdapter({ baseUrl, apiKey, model, maxOutputTokens, onRequest = () => {}, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid_provider_url');
  }
  if (!apiKey || !model || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error('invalid_request_adapter_config');
  }
  const upstreamBase = base.href.replace(/\/+$/, '');
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/responses') {
      replyError(res, 404, 'Unsupported OpenRouter adapter route');
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      replyError(res, 401, 'OpenRouter adapter authentication failed');
      return;
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      replyError(res, 415, 'Unsupported OpenRouter request encoding');
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => controller.abort());
    try {
      let body;
      try {
        body = JSON.parse((await readBounded(req, MAX_REQUEST_BYTES)).toString());
      } catch {
        replyError(res, 400, 'Invalid OpenRouter request body');
        return;
      }
      if (!body || Array.isArray(body) || body.model !== model) {
        replyError(res, 400, 'OpenRouter request model does not match the selected model');
        return;
      }
      const incomingCap = body.max_output_tokens;
      if (incomingCap != null && (!Number.isSafeInteger(incomingCap) || incomingCap < 1)) {
        replyError(res, 400, 'Invalid OpenRouter output limit');
        return;
      }
      body.max_output_tokens = Math.min(maxOutputTokens, incomingCap ?? maxOutputTokens);
      const headers = {};
      const connectionHeaders = new Set(String(req.headers.connection || '').toLowerCase().split(',').map(s => s.trim()));
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_HEADERS.has(name) && !connectionHeaders.has(name)) headers[name] = value;
      }
      headers['content-type'] = 'application/json';
      headers['accept-encoding'] = 'identity';
      const response = await fetchImpl(`${upstreamBase}/responses`, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal,
      });
      const diagnostic = {
        model, maxOutputTokens: body.max_output_tokens,
        inputBytes: Buffer.byteLength(JSON.stringify(body.input ?? [])),
        inputItems: Array.isArray(body.input) ? body.input.length : null,
        httpStatus: response.status,
        requestId: safeRequestId(response.headers.get('x-request-id') || response.headers.get('x-openrouter-request-id')),
      };
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && /^\d+$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))) {
        diagnostic.retryAfterSeconds = Number(retryAfter);
      }
      let keyAllowance;
      const getKeyAllowance = () => keyAllowance ||= readKeyAllowance(upstreamBase, apiKey, fetchImpl, controller.signal);
      const recordError = async error => {
        if (!error || typeof error !== 'object') return;
        const metadata = error.metadata;
        // https://openrouter.ai/docs/api_reference/limits documents these values.
        const limitSource = ['openrouter_credits', 'openrouter_key_limit', 'openrouter_in_flight_budget']
          .includes(metadata?.limit_source) ? metadata.limit_source : null;
        const paymentError = response.status === 402 || Number(error.code) === 402 || limitSource;
        if (!paymentError) return;
        diagnostic.providerErrorStatus = 402;
        if (limitSource) diagnostic.limitSource = limitSource;
        if (['in_flight_budget_exhausted', 'weight_exceeds_budget'].includes(metadata?.reason)) {
          diagnostic.limitReason = metadata.reason;
        }
        if (typeof metadata?.provider_name === 'string' && /^[a-zA-Z0-9 ._:/()-]{1,80}$/.test(metadata.provider_name)) {
          diagnostic.providerName = metadata.provider_name;
        }
        Object.assign(diagnostic, await getKeyAllowance());
        onRequest({ ...diagnostic });
      };
      if (response.status === 402) Object.assign(diagnostic, await getKeyAllowance());
      onRequest(diagnostic);
      const responseHeaders = {};
      const responseConnectionHeaders = new Set(String(response.headers.get('connection') || '').toLowerCase().split(',').map(s => s.trim()));
      for (const [name, value] of response.headers) {
        // fetch decodes compressed bodies; do not forward their old length or
        // encoding. Everything else, including provider request ids, survives.
        if (!HOP_HEADERS.has(name) && !responseConnectionHeaders.has(name) && name !== 'content-encoding') responseHeaders[name] = value;
      }
      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        const isEventStream = response.headers.get('content-type')?.includes('text/event-stream');
        const bodyStream = isEventStream
          ? Readable.from(observeEventStream(response.body, recordError))
          : response.status === 402
            ? Readable.from(observeErrorBody(response.body, recordError))
            : Readable.fromWeb(response.body);
        await pipeline(bodyStream, res);
      } else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) replyError(res, 502, 'OpenRouter request transport failed');
      else res.destroy();
    } finally {
      active.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function runCodex(args, env = process.env) {
  const catalog = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, 'openrouter-model-catalog.json'), 'utf8'));
  const selected = catalog.models?.find(m => m.slug === env.AGENT_MODEL);
  const adapter = await startRequestAdapter({
    baseUrl: env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY,
    model: env.AGENT_MODEL,
    maxOutputTokens: selected?.max_output_tokens,
    onRequest: diagnostic => process.stdout.write(`${JSON.stringify({ type: 'usernode.openrouter.request', diagnostic })}\n`),
  });
  // The override is process-local. Neither the key nor the ephemeral listener
  // is written to the persistent Codex configuration.
  const child = spawn('codex', [
    '-c', `model_providers.usernode_openrouter.base_url=${JSON.stringify(adapter.baseUrl)}`,
    ...args,
  ], { env, stdio: ['inherit', 'pipe', 'pipe'] });
  // Serialize complete lines from both child streams and our diagnostics so
  // a diagnostic cannot land halfway through a large Codex JSONL event.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => process.stdout.write(`${line}\n`));
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
  runCodex(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stdout.write(`${JSON.stringify({ type: 'error', message: 'Could not start the OpenRouter request adapter' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { startRequestAdapter, runCodex };

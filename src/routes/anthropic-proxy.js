'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { anthropicProxyAuth } = require('../middleware/anthropic-proxy-auth');
const log = require('../services/logger');

// Worker → platform Anthropic-proxy.
//
// Why this exists: the CC worker container runs `claude
// --dangerously-skip-permissions` against user prompts. If the worker
// holds the platform's real ANTHROPIC_API_KEY, any user can ask CC to
// `echo $ANTHROPIC_API_KEY` and exfiltrate the platform-wide key.
//
// Instead, the worker holds only its session-scoped WORKER_JWT (in
// ANTHROPIC_API_KEY env var, picked up by the SDK as x-api-key) and
// points ANTHROPIC_BASE_URL at /api/internal/anthropic on the platform.
// This proxy verifies the JWT, swaps the header for the real key, and
// forwards to api.anthropic.com. Exfiltrated JWTs are useless against
// Anthropic directly and expire with WORKER_JWT_TTL.
//
// The proxy is also the natural future home for atomic budget
// enforcement / TOCTOU mitigation (read llm_usage SUM, optionally
// pre-debit, return 429 when over cap). Today it is a transparent
// forwarder with auth + rate-limit only — keeping the structural piece
// minimal so the BYOK and host-process call paths stay untouched.

const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
const ROUTE_PREFIX = '/api/internal/anthropic/';

// Hop-by-hop headers (RFC 7230 §6.1) that must NEVER be forwarded
// through a proxy, plus a few Node/Express layer headers that would
// double-up if we passed them through.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length', // recomputed by fetch / Express
]);

function anthropicProxyRoutes(config) {
  const router = Router();

  if (!config.anthropicApiKey) {
    log.warn('anthropic-proxy', 'ANTHROPIC_API_KEY not set — proxy will 502 platform-key requests');
  }

  // Same shape as the push-proxy rate-limit in internal.js — bounds a
  // runaway CC turn (or a malicious prompt looping API calls) to
  // 60/min/session. Honest CC turns make a handful of API calls per
  // turn, well under this.
  const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('anthropic-proxy', 'Rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // Catch-all under the proxy prefix. Express 4 / path-to-regexp v0
  // matches `*` against the remainder, accessible as req.params[0].
  router.all(`${ROUTE_PREFIX}*`, anthropicProxyAuth, proxyLimiter, async (req, res) => {
    if (!config.anthropicApiKey) {
      return res.status(502).json({ ok: false, code: 'no_platform_key' });
    }

    const upstreamPath = req.params[0] ? `/${req.params[0]}` : '/';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const upstreamUrl = `${ANTHROPIC_UPSTREAM}${upstreamPath}${qs}`;

    // Build forwarded headers: drop hop-by-hop, drop the worker JWT,
    // inject the real key. Preserve `anthropic-version`,
    // `anthropic-beta`, `accept`, `content-type`, etc.
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === 'x-api-key') continue;
      if (Array.isArray(v)) fwdHeaders[k] = v.join(', ');
      else if (v != null) fwdHeaders[k] = String(v);
    }
    fwdHeaders['x-api-key'] = config.anthropicApiKey;

    // Body: express.json() already parsed it (the global json parser
    // runs before this router). Re-stringify for forwarding. Anthropic
    // endpoints we proxy (/v1/messages, /v1/messages/count_tokens) all
    // take JSON bodies, so this is safe; if/when we forward a binary
    // endpoint later we'd need a raw-body branch above.
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
      body = JSON.stringify(req.body);
      fwdHeaders['content-type'] = 'application/json';
    }

    // Abort upstream when the worker disconnects mid-stream so we
    // don't keep the Anthropic socket open after the client gives up.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: fwdHeaders,
        body,
        signal: abort.signal,
        // Disable any Node-side response decompression so the body
        // bytes flow through unchanged (matters for SSE).
        // Node 22 fetch doesn't auto-decompress unless we set
        // accept-encoding ourselves; we only forward whatever the
        // SDK asked for.
      });
    } catch (err) {
      if (err.name === 'AbortError') return; // client gave up; nothing to send
      log.error('anthropic-proxy', 'Upstream fetch failed', {
        sessionId: req.workerSession?.sessionId,
        upstreamPath,
        err: err.message,
      });
      if (!res.headersSent) {
        return res.status(502).json({ ok: false, code: 'upstream_unreachable', message: err.message });
      }
      return;
    }

    // Mirror status + headers (skip hop-by-hop on the way back).
    // Node 22 fetch (undici) auto-decompresses the response body but
    // keeps the original `content-encoding` header — if we forwarded
    // that header the client would try to gunzip plain bytes and fail
    // mid-stream ("terminated"). Strip both `content-encoding` and
    // `content-length` (the latter no longer matches the on-wire
    // length anyway, and Express handles chunking on its own).
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (HOP_BY_HOP.has(k)) return;
      if (k === 'content-length') return;
      if (k === 'content-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstream.body) {
      return res.end();
    }

    // Stream the body chunk-by-chunk. SSE responses
    // (`text/event-stream`) flow through naturally — Node's fetch
    // gives us a ReadableStream of Uint8Array chunks, we write them
    // as Buffers, and Express keeps the connection open until end().
    try {
      const reader = upstream.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          // res.write returns false on backpressure; ignore here —
          // the read loop is awaited so we naturally throttle.
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err) {
      if (err.name === 'AbortError') {
        // Worker disconnected mid-stream; nothing left to do.
        if (!res.writableEnded) res.end();
        return;
      }
      log.error('anthropic-proxy', 'Upstream stream error', {
        sessionId: req.workerSession?.sessionId,
        err: err.message,
      });
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

module.exports = anthropicProxyRoutes;

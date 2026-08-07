// Test-harness preload (loaded via --require in the npm test script; the
// node test runner spawns each test file with the parent's execArgv, so
// every test process gets this automatically). Two patches, one shared
// goal: kill the rare, random `TypeError: fetch failed` flakes that hit a
// different test file every few full-suite runs.
//
// ── Patch 1: test servers bind IPv4 loopback ──────────────────────────
//
// Root cause of the flakes (diagnosed Aug 2026): test files start their
// servers with `app.listen(0)` and no host, which binds IPv6-any (`::`).
// The kernel assigns an ephemeral port considering only that binding — it
// can and does hand out a port that some unrelated desktop app already
// holds as an IPv4 listener (observed live: Spotify on *:57621, Cursor's
// sandbox helper on 127.0.0.1:51332). The test then fetches
// `http://127.0.0.1:<port>` — IPv4 — and the connection routes to the
// third-party app instead of the test server. That app resets the
// unexpected HTTP traffic, so the test dies with ECONNRESET /
// UND_ERR_SOCKET no matter how often it retries, while the test's own
// server (listening only on `::`) never sees a byte. The same port number
// recurring across independent runs (51332 twice) is what gave it away.
//
// Forcing serverless `listen(port)` calls onto 127.0.0.1 makes the kernel
// assign only ports that are actually free on IPv4 loopback, which is
// where every test client connects. Explicit hosts, unix socket paths,
// and handle/fd listens are left untouched.
//
// ── Patch 2: retry fetch on transport errors to loopback ──────────────
//
// Defense in depth for whatever load-induced socket weirdness remains
// (ephemeral-port churn under ~1000 connections/sec, macOS being macOS).
// Only fires for (a) loopback URLs, i.e. servers the test itself just
// started, and (b) errors from BELOW HTTP — the request never reached the
// app, so no status/header/body assertion is affected. A test asserting
// "server refuses" still fails identically, just a bit later. Each retry
// dials a fresh connection (undici discards errored sockets). Every fire
// is logged so a systemic problem stays visible in TAP output instead of
// being silently absorbed.

'use strict';

const net = require('net');

// ── Patch 1 ─────────────────────────────────────────────────────────────
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function listenOnLoopback(...args) {
  if (typeof args[0] === 'number' && typeof args[1] !== 'string') {
    // listen(port[, backlog][, cb]) — no host given: pin to IPv4 loopback.
    return realListen.call(this, args[0], '127.0.0.1', ...args.slice(1));
  }
  if (
    args[0] && typeof args[0] === 'object'
    && args[0].port !== undefined && !args[0].host && !args[0].path
  ) {
    return realListen.call(this, { ...args[0], host: '127.0.0.1' }, ...args.slice(1));
  }
  return realListen.apply(this, args);
};

// ── Patch 2 ─────────────────────────────────────────────────────────────
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EADDRNOTAVAIL', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT',
]);

function transientCode(err) {
  const cause = err && err.cause;
  if (!cause) return null;
  if (TRANSIENT_CODES.has(String(cause.code))) return String(cause.code);
  // Happy-eyeballs connect failures surface as an AggregateError cause.
  for (const e of (Array.isArray(cause.errors) ? cause.errors : [])) {
    if (TRANSIENT_CODES.has(String(e && e.code))) return String(e.code);
  }
  return null;
}

const realFetch = globalThis.fetch;
const RETRY_DELAYS_MS = [75, 300];

globalThis.fetch = async function fetchWithLocalRetry(input, init) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await realFetch(input, init);
    } catch (err) {
      const url = typeof input === 'string' ? input
        : (input && typeof input.url === 'string') ? input.url : String(input || '');
      const code = transientCode(err);
      // Bodies given as streams can't be replayed; tests here pass strings /
      // Buffers / FormData, all of which re-send fine.
      const replayable = !init || init.body == null
        || typeof init.body === 'string'
        || Buffer.isBuffer(init.body)
        || init.body instanceof Uint8Array
        || (typeof FormData !== 'undefined' && init.body instanceof FormData)
        || (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams);
      if (!code || !LOCAL_URL.test(url) || !replayable || attempt >= RETRY_DELAYS_MS.length) throw err;
      process.stderr.write(`fetch-retry: retry ${attempt + 1} for ${url} after transport error ${code}\n`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
};

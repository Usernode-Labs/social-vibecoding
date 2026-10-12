// Test-harness preload (loaded via --require in the npm test script; the
// node test runner spawns each test file with the parent's execArgv, so
// every test process gets this automatically). The first two patches share
// one goal: kill the rare, random `TypeError: fetch failed` flakes that hit
// a different test file every few full-suite runs. The third keeps a
// worker's push from waiting out its retries in a test.
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
//
// ── Patch 3: a worker's push tries once ───────────────────────────────
//
// worker/usernode-push retries a failed push with pauses that come to
// about two minutes, because a push can land while the platform restarts.
// The unit suite runs in the worker image, where run-cc.sh and
// run-codex-agent.sh find the real /usr/local/bin/usernode-push, and most
// tests that run a runner point it at a platform that is not there
// (127.0.0.1:1, http://p). Each such run sat out every pause, about 110 s,
// and four files went past their 180 s limit (main paused, 12 Oct 2026).
// On a laptop the script is not installed, so the push failed at once and
// nothing showed. So every child a test starts gets USERNODE_PUSH_BACKOFF
// set and empty, which is one try, unless the test set it itself, as
// tests/usernode-push-retry.test.js does. Most of these tests build the
// child's env from scratch, so setting process.env alone would not reach
// them.

'use strict';

const childProcess = require('child_process');
const { syncBuiltinESMExports } = require('module');
const net = require('net');
const util = require('util');

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

// ── Patch 3 ─────────────────────────────────────────────────────────────
const PUSH_BACKOFF = 'USERNODE_PUSH_BACKOFF';
if (process.env[PUSH_BACKOFF] === undefined) process.env[PUSH_BACKOFF] = '';

// The options argument is the first plain object after the command, in
// every signature below (spawn(cmd, args, opts), exec(cmd, opts, cb), …).
function withOnePushTry(args) {
  const i = args.findIndex((a, n) => n > 0 && a && typeof a === 'object' && !Array.isArray(a));
  const env = i > 0 ? args[i].env : null;
  if (!env || typeof env !== 'object' || PUSH_BACKOFF in env) return args;
  const out = args.slice();
  out[i] = { ...args[i], env: { ...env, [PUSH_BACKOFF]: '' } };
  return out;
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = childProcess[name];
  const patched = function childWithOnePushTry(...args) {
    return real.apply(this, withOnePushTry(args));
  };
  // exec and execFile promisify to { stdout, stderr } through this.
  const custom = real[util.promisify.custom];
  if (custom) patched[util.promisify.custom] = (...args) => custom(...withOnePushTry(args));
  childProcess[name] = patched;
}
// `import { spawn } from 'node:child_process'` sees the patched functions too.
syncBuiltinESMExports();

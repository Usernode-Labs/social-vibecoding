// Test-harness preload (loaded via --require in the npm test script; the
// node test runner spawns each test file with the parent's execArgv, so
// every test process gets this automatically). Four patches: the first two
// kill the rare, random `TypeError: fetch failed` flakes that hit a
// different test file every few full-suite runs, the third keeps a
// Postgres connection dropped while idle from failing a whole test file,
// and the fourth stops the suite from racing itself over the shared
// Postgres cluster.
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

// ── Patch 4: no scheduled orphan-staging-DB sweep in test processes ─────
//
// The full suite runs every tests/*.test.js file in parallel against ONE
// Postgres at 127.0.0.1:5432. Files that boot the workflow runtime arm
// every clock job at startup with its first run due immediately, including
// `preview-orphan-dbs`: its sweep lists every `%_staging_%` database in the
// whole cluster and drops each one with no live session and no client —
// which is exactly a redaction/postgres test's freshly created copy between
// `CREATE DATABASE` and pg_restore's first connection (issue #5645: pg_restore
// died with `database "…_staging_s1_abcdef" does not exist … just been
// dropped`). 0 is already the interval's own kill switch, so arm the job
// off unless a developer sets the variable themselves. The sweep's unit
// tests call selectOrphanDbs / sweepOrphanDbs directly and keep working.
if (process.env.STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS === undefined) {
  process.env.STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS = '0';
}

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

// ── Patch 3: a pg Pool with no 'error' listener loses an idle client ───
//
// pg-pool emits 'error' on the pool when the server drops one of its idle
// clients (57P01: a test's own `DROP DATABASE ... WITH (FORCE)` can reach a
// connection `pool.end()` has handed its end but whose socket is still
// closing; a parallel file's pg_terminate_backend reaches one the same way).
// With no listener the EventEmitter throw becomes an uncaughtException,
// which node:test attributes to whichever test happens to be running (the
// flake behind issue #5421). 39 sibling postgres test files already carry
// `pool.on('error', () => {})` by hand (tests/username-invite-join-
// postgres.test.js:44-50 carries the note); this steps in for any that
// doesn't, writes one stderr line so the loss stays visible, and lets the
// run continue. A failing `pool.query` still rejects its promise, so no
// assertion changes. Pools that already listen are untouched.
try {
  // pg is pg-pool's only consumer, so npm hoists it; `pg`'s BoundPool is
  // this Pool's subclass, and the prototype is shared.
  const mod = require('pg-pool');
  const Pool = mod.Pool || mod; // 3.x exports the class directly.
  const realEmit = Pool.prototype.emit;
  Pool.prototype.emit = function emit(event, ...rest) {
    if (event === 'error' && this.listenerCount('error') === 0) {
      const err = rest[0];
      const message = err && err.message ? err.message : String(err);
      process.stderr.write(`pg-pool: idle connection lost with no 'error' listener: ${message}\n`);
      return false;
    }
    return realEmit.call(this, event, ...rest);
  };
} catch {
  // pg-pool not resolvable: nothing here constructs a real one. Skip.
}

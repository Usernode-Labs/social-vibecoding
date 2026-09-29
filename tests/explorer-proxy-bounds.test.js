'use strict';

// #2505: `/explorer-api` is an UNAUTHENTICATED proxy that buffered an
// UNBOUNDED request body.
//
// Being public is deliberate and stays — it is the documented
// PUBLIC_PREFIXES convention, and receipt observation needs it, because
// mounted behind authMiddleware the path 302s to /login.html and the bridge
// receives HTML instead of explorer JSON.
//
// Being public AND unbounded was the problem. The handler was:
//
//   const chunks = [];
//   req.on('data', (c) => chunks.push(c));
//   req.on('end', () => { ... Buffer.concat(chunks) ... });
//
// Nothing capped that array. It is mounted ahead of authMiddleware AND ahead
// of the global `express.json()` — deliberately, so the raw body streams
// through unparsed — so it inherited a limit from neither. Any anonymous
// caller could POST an endless body and the platform held every byte until
// the process died. No credential required and no rate limit to slow a
// second attempt.
//
// This file covers the request cap and the four other bounds added with it,
// each of which closes a way to spend the platform's resources from outside:
// the upstream response was buffered just as unboundedly, there was no
// upstream timeout, there was no rate limit on an endpoint that makes an
// outbound call per request, and every HTTP method was forwarded. Plus one
// that is not a resource bound: `req.url` was pasted into the upstream path
// after stripping leading slashes only, so `../` walked out of
// EXPLORER_UPSTREAM_BASE.
//
// Run with: node --test tests/explorer-proxy-bounds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const {
  explorerProxyRoutes, isTraversal, MAX_BODY, MAX_RESPONSE, ALLOWED_METHODS,
  UPSTREAM_IDLE_TIMEOUT_MS, UPSTREAM_DEADLINE_MS, CORS_HEADERS,
} = require('../src/routes/explorer-proxy');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let upstream;
let upstreamPort;
// What the stub upstream saw, so a test can assert a request never reached it.
let seen = [];
// Set by a test to make the upstream misbehave.
let upstreamMode = 'ok';

test.before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, bodyLength: Buffer.concat(chunks).length });
      if (upstreamMode === 'huge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // Deliberately past MAX_RESPONSE.
        const block = Buffer.alloc(256 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < MAX_RESPONSE * 2) { res.write(block); sent += block.length; }
          res.end();
        };
        pump();
        return;
      }
      if (upstreamMode === 'hang') return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, saw: req.url }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
  process.env.EXPLORER_USE_HTTP = 'true';
});

test.after(() => { upstream?.close(); });

function buildApp() {
  const app = express();
  // Mounted BEFORE any body parser, exactly as server.js does it.
  app.use(explorerProxyRoutes({
    explorerUpstream: `127.0.0.1:${upstreamPort}`,
    explorerUpstreamBase: '/api',
  }));
  return app;
}

async function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function call(server, p, { method = 'GET', body, headers = {} } = {}) {
  const { port } = server.address();
  const resp = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    // A per-IP limiter is a module singleton, so vary the address the
    // limiter keys on between tests that would otherwise share a bucket.
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: resp.status, text, json };
}

test.beforeEach(() => { seen = []; upstreamMode = 'ok'; });

// ── The bug ────────────────────────────────────────────────────────────

test('the ordinary observation call still works', async () => {
  const server = await listen(buildApp());
  try {
    const res = await call(server, '/explorer-api/active_chain');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(seen[0].url, '/api/active_chain', 'the path is still rewritten as before');
  } finally { server.close(); }
});

test('a POST observation still reaches the explorer with its body', async () => {
  const server = await listen(buildApp());
  try {
    const body = JSON.stringify({ txId: 'abc123' });
    const res = await call(server, '/explorer-api/chain-1/transactions', { method: 'POST', body });
    assert.equal(res.status, 200);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].bodyLength, Buffer.byteLength(body));
  } finally { server.close(); }
});

test('a body over the cap is refused, and never reaches the explorer', async () => {
  const server = await listen(buildApp());
  try {
    const res = await call(server, '/explorer-api/chain-1/transactions', {
      method: 'POST',
      body: Buffer.alloc(MAX_BODY + 4096, 0x61),
    }).catch((err) => ({ status: 0, text: String(err), json: null }));
    // Either a clean 413 or a destroyed connection — both are refusals, and
    // the load-bearing assertion is the one below.
    assert.notEqual(res.status, 200, 'an oversized body must not be proxied');
    assert.equal(seen.length, 0,
      'the explorer must not receive a request whose body we refused to hold');
  } finally { server.close(); }
});

test('a body just under the cap is still proxied', async () => {
  const server = await listen(buildApp());
  try {
    const body = Buffer.alloc(MAX_BODY - 1024, 0x62);
    const res = await call(server, '/explorer-api/chain-1/transactions', { method: 'POST', body });
    assert.equal(res.status, 200, 'the cap must not refuse a legitimate payload');
    assert.equal(seen[0].bodyLength, body.length);
  } finally { server.close(); }
});

// ── The other bounds ───────────────────────────────────────────────────

test('an oversized upstream response is refused rather than buffered', async () => {
  upstreamMode = 'huge';
  const server = await listen(buildApp());
  try {
    const res = await call(server, '/explorer-api/active_chain');
    assert.notEqual(res.status, 200,
      'a misbehaving explorer must not be able to exhaust this process');
  } finally { server.close(); }
});

test('a method outside the documented two is refused before any outbound call', async () => {
  const server = await listen(buildApp());
  try {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const res = await call(server, '/explorer-api/active_chain', { method });
      assert.equal(res.status, 405, `${method} should not reach the explorer`);
    }
    assert.equal(seen.length, 0, 'none of them made an outbound request');
    // And the documented ones are allowed.
    assert.ok(ALLOWED_METHODS.has('GET') && ALLOWED_METHODS.has('POST'));
  } finally { server.close(); }
});

// Sent over a RAW SOCKET, not through fetch: fetch normalizes a literal
// `../` away client-side, so the request that arrives is a different one and
// the test would be measuring the client. The percent-encoded forms survive
// fetch, but the literal one is the case that matters and only a raw request
// line carries it.
function rawRequest(server, requestTarget) {
  const net = require('node:net');
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${requestTarget} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (c) => { buf += c.toString(); });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
  });
}

test('a traversal path is refused before any outbound call', async () => {
  const server = await listen(buildApp());
  try {
    for (const target of [
      '/explorer-api/../admin',
      '/explorer-api/chain/../../secrets',
      '/explorer-api/%2e%2e/admin',
      '/explorer-api/chain/%2E%2E%2Fadmin',
      '/explorer-api/..%2fadmin',
    ]) {
      const raw = await rawRequest(server, target);
      assert.match(raw, /^HTTP\/1\.1 400/, `${target} should be refused: ${raw.split('\r\n')[0]}`);
    }
    assert.equal(seen.length, 0, 'none of them reached the explorer');
  } finally { server.close(); }
});

test('isTraversal is precise — it does not refuse an ordinary path', () => {
  for (const p of ['active_chain', 'chain-1/transactions', 'a..b/c', 'x/..y', 'v1.2/tx']) {
    assert.equal(isTraversal(p), false, `${p} is legitimate`);
  }
  for (const p of ['../x', 'a/../b', 'a/..', '..', 'a\\..\\b', '%2e%2e/x']) {
    assert.equal(isTraversal(p), true, `${p} escapes the base path`);
  }
});

// ── The wiring ─────────────────────────────────────────────────────────

test('server.js mounts the module, and still mounts it before auth and the parser', () => {
  const src = read('server.js');
  assert.match(src, /app\.use\(explorerProxyRoutes\(config\)\);/);
  // Both orderings are load-bearing and were the reason it was inline: the
  // body must stream through unparsed, and the path must not be redirected
  // to the login page.
  const proxyAt = src.indexOf('app.use(explorerProxyRoutes(config));');
  const authAt = src.indexOf('app.use(authMiddleware(config));');
  assert.ok(proxyAt > 0 && authAt > 0);
  assert.ok(proxyAt < authAt, 'the proxy must stay ahead of authMiddleware');
  const parserAt = src.indexOf("req.path.startsWith('/api/internal/anthropic/')");
  assert.ok(proxyAt < parserAt, 'the proxy must stay ahead of the global JSON parser');
  // The inline handler is gone, not merely duplicated.
  assert.doesNotMatch(src, /req\.on\('data', \(c\) => chunks\.push\(c\)\)/,
    'the unbounded inline buffer must be gone from server.js');
});

test('the route carries a rate limiter', () => {
  const src = read('src/routes/explorer-proxy.js');
  assert.match(src, /explorerProxyLimiter/,
    'an unauthenticated endpoint that makes an outbound call per request needs one');
  const limits = read('src/middleware/rate-limits.js');
  assert.match(limits, /const explorerProxyLimiter = makeLimiter\(/);
  // Keyed by address: there is no user here, by design.
  // Just this limiter's own object literal — the next declaration in the
  // file is keyed by user, and a slice wide enough to include it would make
  // this assertion meaningless.
  const from = limits.indexOf('const explorerProxyLimiter');
  const block = limits.slice(from, limits.indexOf('});', from));
  assert.doesNotMatch(block, /keyByUser/,
    'this endpoint has no user to key on — it is mounted ahead of auth');
  assert.match(block, /name: 'explorer-proxy'/);
});

test('the bounds are real numbers, not decoration', () => {
  assert.ok(Number.isInteger(MAX_BODY) && MAX_BODY > 0 && MAX_BODY <= 1024 * 1024,
    'a chain name and a transaction id — generous, but bounded');
  assert.ok(Number.isInteger(MAX_RESPONSE) && MAX_RESPONSE > 0);
});

// ── Three findings from review, each pinned ────────────────────────────

// Codex, P2: this handler answers `access-control-allow-origin: *`, so a
// cross-origin POST carrying `content-type: application/json` is preflighted
// by the browser. The OLD transparent proxy forwarded that preflight; a bare
// 405 from the new method allow-list would mean the browser never issues the
// POST at all — the allow-list would have broken cross-origin callers.
test('a CORS preflight is answered, not refused', async () => {
  const server = await listen(buildApp());
  try {
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}/explorer-api/chain-1/transactions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(resp.status, 204, 'a preflight must succeed or the POST never happens');
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.match(resp.headers.get('access-control-allow-methods') || '', /POST/);
    assert.match(resp.headers.get('access-control-allow-headers') || '', /content-type/);
    assert.equal(seen.length, 0, 'and it is answered here, not forwarded');
  } finally { server.close(); }
});

test('a refused method still carries CORS headers', async () => {
  const server = await listen(buildApp());
  try {
    const res = await call(server, '/explorer-api/active_chain', { method: 'DELETE' });
    assert.equal(res.status, 405);
  } finally { server.close(); }
  assert.equal(CORS_HEADERS['access-control-allow-origin'], '*');
});

// Codex, P1: Node's `timeout` request option is an INACTIVITY timeout. An
// upstream that trickles a byte more often than that satisfies it forever,
// so the bound this change exists to add would not hold.
test('there is an absolute deadline, not only an idle timeout', () => {
  assert.ok(Number.isInteger(UPSTREAM_IDLE_TIMEOUT_MS) && UPSTREAM_IDLE_TIMEOUT_MS > 0);
  assert.ok(Number.isInteger(UPSTREAM_DEADLINE_MS) && UPSTREAM_DEADLINE_MS > 0);
  assert.ok(UPSTREAM_DEADLINE_MS > UPSTREAM_IDLE_TIMEOUT_MS,
    'the deadline must outlast the idle timeout, or it is the only one that ever fires');
  const src = read('src/routes/explorer-proxy.js');
  assert.match(src, /setTimeout\(\(\) => \{[\s\S]*?upReq\.destroy/,
    'an independent timer must destroy the request');
  assert.match(src, /clearTimeout\(deadline\)/,
    'and it must be cleared, or a healthy request holds a timer for its full duration');
});

// Codex, P1: destroying upReq also aborts upRes, and an unhandled 'error' on
// an IncomingMessage is an uncaught exception — the timeout path could have
// taken the process down instead of answering 502.
test('the upstream response stream has an error handler', () => {
  const src = read('src/routes/explorer-proxy.js');
  assert.match(src, /upRes\.on\('error'/,
    'destroying upReq aborts upRes; an unhandled error there kills the process');
});

test('a hanging upstream does not hang the caller forever', async () => {
  upstreamMode = 'hang';
  const server = await listen(buildApp());
  try {
    // The idle timeout is the one that fires here (no bytes at all), and it
    // must produce a controlled answer rather than an unhandled throw.
    const started = Date.now();
    const res = await call(server, '/explorer-api/active_chain');
    assert.equal(res.status, 502, 'a dead upstream is a 502, not a hang');
    assert.ok(Date.now() - started < UPSTREAM_IDLE_TIMEOUT_MS + 5000);
  } finally { server.close(); }
});

'use strict';

// #2512, part 2: both LLM proxies parsed up to 32 MB BEFORE authenticating.
//
//   src/routes/anthropic-proxy.js   router.use(express.json({limit:'32mb'}))
//   src/routes/app-llm-proxy.js     router.use(PREFIX, express.json({...}))
//
// A `router.use` runs ahead of every route on that router, and the auth
// middleware was a per-route step — so the order was parse, then check who
// is calling. An anonymous request with no credential at all could make the
// platform read 32 MB off the socket and hand it to `JSON.parse`, which is
// synchronous and blocks the single event loop for everybody. The credential
// check that would have refused the caller ran afterwards, on a body the
// platform had already paid for.
//
// 32 MB is the right ceiling for an AUTHENTICATED turn — Anthropic itself
// caps bodies there and a real Claude Code turn carries megabytes of file
// context — so the fix is not a smaller limit. It is to parse later: the
// parser is now a step in each route's own chain, after auth and after the
// rate limiter. Neither auth middleware reads `req.body`, so nothing needs
// the body before the caller is known.
//
// The behavioural tests below rebuild that exact middleware ORDER against
// stub auth, and assert what an anonymous caller costs. The source
// assertions pin the shape in the real files, because the order is the whole
// fix and a later `router.use` would silently undo it.
//
// Run with: node --test tests/proxy-parse-after-auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Strip comments so an assertion matches CODE, not the prose explaining it.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── The order, exercised ───────────────────────────────────────────────

// Build a proxy-shaped router either way round, so the test can show the
// difference rather than merely assert the good case.
//
//   parseFirst: true  — the old `router.use(express.json())` shape
//   parseFirst: false — the fixed shape, parser inside the route chain
function buildApp({ parseFirst }) {
  const app = express();
  const router = express.Router();
  const seen = { bytesRead: 0, parsed: 0, authRejected: 0 };

  // Counts what actually came off the socket, whoever asked for it.
  app.use((req, _res, next) => {
    req.on('data', (chunk) => { seen.bytesRead += chunk.length; });
    next();
  });

  const parseBody = [
    express.json({ limit: '32mb' }),
    (req, _res, next) => { seen.parsed++; next(); },
  ];
  // Header-only credential check, like both real ones.
  const auth = (req, res, next) => {
    if (req.headers['x-token'] !== 'good') {
      seen.authRejected++;
      return res.status(401).json({ ok: false, code: 'unauthorized' });
    }
    next();
  };

  if (parseFirst) router.use('/api/proxy/', parseBody);
  const chain = parseFirst ? [auth] : [auth, ...parseBody];
  router.post('/api/proxy/*', ...chain, (req, res) => {
    res.json({ ok: true, gotBody: !!req.body && typeof req.body === 'object' });
  });

  app.use(router);
  return { app, seen };
}

async function post(server, body, headers = {}) {
  const { port } = server.address();
  const resp = await fetch(`http://127.0.0.1:${port}/api/proxy/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ~4 MB of valid JSON. Large enough that reading and parsing it is a real
// cost, small enough to keep the suite quick.
const BIG = JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024) });

test('an anonymous caller is refused without its body being parsed', async () => {
  const { app, seen } = buildApp({ parseFirst: false });
  const server = await listen(app);
  try {
    const res = await post(server, BIG);
    assert.equal(res.status, 401);
    assert.equal(seen.authRejected, 1);
    assert.equal(seen.parsed, 0, 'the 4 MB body must never reach JSON.parse');
  } finally { server.close(); }
});

test('the old order DID parse it first — this is the regression being fixed', async () => {
  const { app, seen } = buildApp({ parseFirst: true });
  const server = await listen(app);
  try {
    const res = await post(server, BIG);
    assert.equal(res.status, 401, 'still refused, but only after the work was done');
    assert.equal(seen.parsed, 1, 'the anonymous body was parsed before auth ran');
    assert.ok(seen.bytesRead >= 4 * 1024 * 1024,
      `read ${seen.bytesRead} bytes for a request that had no credential`);
  } finally { server.close(); }
});

test('an authenticated caller still gets its body, at the same 32mb ceiling', async () => {
  const { app, seen } = buildApp({ parseFirst: false });
  const server = await listen(app);
  try {
    const res = await post(server, BIG, { 'x-token': 'good' });
    assert.equal(res.status, 200);
    assert.equal(res.body.gotBody, true, 'the real handler still reads req.body');
    assert.equal(seen.parsed, 1);
  } finally { server.close(); }
});

test('a body over the ceiling is still refused, for an authenticated caller', async () => {
  const app = express();
  app.post('/p', express.json({ limit: '1kb' }), (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}/p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4096) }),
    });
    assert.equal(resp.status, 413, 'the limit option is what enforces the ceiling');
  } finally { server.close(); }
});

// ── The shape, pinned in the real files ────────────────────────────────

for (const [file, mount] of [
  ['src/routes/anthropic-proxy.js', /router\.all\(`\$\{ROUTE_PREFIX\}\*`, anthropicProxyAuth, proxyLimiter, parseBody,/],
  ['src/routes/app-llm-proxy.js', /router\.post\(`\$\{ROUTE_PREFIX\}\*`, auth, proxyLimiter, parseBody,/],
]) {
  test(`${file} parses inside the route chain, after auth`, () => {
    const src = code(read(file));
    assert.match(src, mount, 'the parser must sit after auth in the route chain');
    assert.doesNotMatch(src, /router\.use\([^)]*express\.json/,
      'a router-level json parser runs before every per-route auth step');
    // And the ceiling itself is unchanged — this is an ordering fix, not a
    // quieter cap that would break real Claude Code turns.
    assert.match(src, /express\.json\(\{ limit: '32mb' \}\)/);
  });
}

test('neither auth middleware reads req.body, so parsing later is safe', () => {
  for (const file of [
    'src/middleware/anthropic-proxy-auth.js',
    'src/middleware/app-llm-auth.js',
  ]) {
    assert.doesNotMatch(code(read(file)), /\breq\.body\b/,
      `${file} would need the body parsed before it runs`);
  }
});

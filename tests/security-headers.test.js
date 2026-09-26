// #2507: the platform's own responses carry baseline security headers.
//
// Before this, nothing in server.js set X-Content-Type-Options,
// Referrer-Policy or any framing policy, so the shell — which carries the
// session cookie and hosts one-click destructive actions — could be framed
// by any origin (clickjacking), and responses could be MIME-sniffed.
//
// What is pinned here, and why each is shaped the way it is:
//
//   1. Every platform response (the SPA shell, a static asset, an API call,
//      a 404) carries nosniff, strict-origin-when-cross-origin and a
//      `frame-ancestors` CSP.
//   2. The framing policy allows 'self' AND the platform's own public origin
//      (https://<USERNODE_DOMAIN>) — never a wildcard. The platform
//      legitimately frames ITSELF from other origins: a staging preview of
//      the platform (`usernode-2d5619--s<N>.<apps domain>`) is shown inside
//      the production shell's staging overlay, and the app-origin fallback
//      pages (/__app_unavailable, the access gate) render inside the app
//      iframe. A plain 'self' or X-Frame-Options: SAMEORIGIN would blank
//      all of those, which is why there is deliberately NO X-Frame-Options.
//   3. The centrally hosted app assets (/usernode-bridge, /usernode-native,
//      /usernode-tailwind) are served on every APP's own origin, so they get
//      nosniff (their types are exact) but not the platform's CSP or
//      referrer policy — those would reach into a hosted app's documents.
//   4. A route that sets its own CSP (the sandboxed chat attachment, the CLI
//      approval page) keeps it: the middleware runs first and the route's
//      own `res.set` replaces the header.
//
// Run with: node --test tests/security-headers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..');
const {
  securityHeaders,
  frameAncestorsPolicy,
  REFERRER_POLICY,
} = require('../src/middleware/security-headers');

function buildApp(options) {
  const app = express();
  app.use(securityHeaders(options));
  app.get('/api/apps', (_req, res) => res.json({ apps: [] }));
  // Stands in for the sandboxed attachment routes (chat.js, conversations.js).
  app.get('/api/chat/attachments/1/view', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Security-Policy', 'sandbox allow-scripts');
    res.set('Referrer-Policy', 'no-referrer');
    res.send('<p>user html</p>');
  });
  app.get('/usernode-bridge/v1/bridge.js', (_req, res) => res.type('js').send('/* bridge */'));
  app.get('/usernode-native/v1/native.css', (_req, res) => res.type('css').send('/* kit */'));
  app.get('/usernode-tailwind/v1/tailwind.js', (_req, res) => res.type('js').send('/* tw */'));
  app.get('/usernode-bridge.js', (_req, res) => res.type('js').send('/* legacy */'));
  app.get('*', (req, res) => {
    if (req.accepts('html')) return res.type('html').send('<!doctype html><title>shell</title>');
    return res.status(404).json({ error: 'Not found' });
  });
  return app;
}

async function get(app, reqPath, headers = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: reqPath, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const PROD = { platformDomain: 'my.onhomeroom.com' };

test('the shell document carries nosniff, the referrer policy and frame-ancestors', async () => {
  const res = await get(buildApp(PROD), '/', { Accept: 'text/html' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(res.headers['content-security-policy'],
    "frame-ancestors 'self' https://my.onhomeroom.com");
});

test('API responses and 404s carry the same headers', async () => {
  for (const reqPath of ['/api/apps', '/api/does-not-exist']) {
    const res = await get(buildApp(PROD), reqPath, { Accept: 'application/json' });
    assert.equal(res.headers['x-content-type-options'], 'nosniff', reqPath);
    assert.equal(res.headers['referrer-policy'], REFERRER_POLICY, reqPath);
    assert.match(res.headers['content-security-policy'], /^frame-ancestors 'self'/, reqPath);
  }
});

test('no X-Frame-Options: it cannot express the platform framing its own previews', async () => {
  const res = await get(buildApp(PROD), '/', { Accept: 'text/html' });
  assert.equal(res.headers['x-frame-options'], undefined);
});

test('the framing allow-list is self + the platform origin, never a wildcard', () => {
  assert.equal(frameAncestorsPolicy(PROD), "frame-ancestors 'self' https://my.onhomeroom.com");
  // No domain configured (tests, a bare local run): same-origin only.
  assert.equal(frameAncestorsPolicy({}), "frame-ancestors 'self'");
  // A malformed or hostile value is dropped rather than spliced into a header.
  for (const bad of ['*', '*.example.com', "evil.com 'unsafe-inline'", 'a.com;script-src *', 'https://x.com', '']) {
    assert.equal(frameAncestorsPolicy({ platformDomain: bad }), "frame-ancestors 'self'", bad);
  }
  // Local dev: previews are http://localhost:<hostport>, framed by the
  // platform on another port of the same host.
  assert.equal(
    frameAncestorsPolicy({ platformDomain: 'usernode.example.com', localDev: true }),
    "frame-ancestors 'self' https://usernode.example.com http://localhost:* http://127.0.0.1:*",
  );
  assert.doesNotMatch(frameAncestorsPolicy(PROD), /\*/);
});

test('hosted app assets get nosniff only — no platform CSP or referrer policy on app origins', async () => {
  for (const reqPath of [
    '/usernode-bridge/v1/bridge.js',
    '/usernode-native/v1/native.css',
    '/usernode-tailwind/v1/tailwind.js',
    '/usernode-bridge.js',
  ]) {
    const res = await get(buildApp(PROD), reqPath);
    assert.equal(res.status, 200, reqPath);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', reqPath);
    assert.equal(res.headers['content-security-policy'], undefined, reqPath);
    assert.equal(res.headers['referrer-policy'], undefined, reqPath);
  }
});

test('a route that sets its own CSP keeps it', async () => {
  const res = await get(buildApp(PROD), '/api/chat/attachments/1/view');
  assert.equal(res.headers['content-security-policy'], 'sandbox allow-scripts');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

// ── The wiring, pinned ─────────────────────────────────────────────────

test('server.js mounts the middleware ahead of every route and the static handler', () => {
  const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const mount = src.indexOf('app.use(securityHeaders(');
  assert.ok(mount > 0, 'server.js must mount securityHeaders');
  // Ahead of the first other middleware/route, so early answers (the public
  // CORS preflight, the CLI/MCP gates, the explorer passthrough) carry it.
  for (const later of ['app.use(publicApiCors())', 'app.use(cliAuthGate(', 'app.use(express.static(', "app.get('*'"]) {
    const at = src.indexOf(later);
    assert.ok(at > mount, `securityHeaders must be mounted before ${later}`);
  }
  // Configured from the platform's public domain and the local-dev switch.
  assert.match(src, /securityHeaders\(\{[\s\S]*?platformDomain: process\.env\.USERNODE_DOMAIN/);
});

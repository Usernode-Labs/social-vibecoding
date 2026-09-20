'use strict';

// #2507: the shell shipped no security response headers.
//
// No `helmet`, no header middleware before the routers. `applyShellDocumentHeaders`
// set only a build id, `frontend/src/head.html` carried no CSP meta, and the
// Caddyfile sets headers only inside its 502/503 stub. Two concrete
// consequences:
//
//   - CLICKJACKING. The shell was frameable by ANY origin while carrying the
//     session cookie, and it hosts one-click destructive actions — vote and
//     merge, the admin console, the secrets dialogs, app delete.
//   - REFERER LEAK. With no `Referrer-Policy` the full URL travels on every
//     cross-origin navigation, including `?token=<JWT>` on a staging link.
//
// The fix has two tiers, and the split is the point:
//
//   - `baseSecurityHeaders` (nosniff + Referrer-Policy) is safe on EVERY
//     response and is mounted globally.
//   - the FRAMING headers are not, and go on the shell document only. The
//     platform also serves APP content, and the shell frames apps
//     CROSS-ORIGIN from their own domains — a blanket `frame-ancestors
//     'self'` would forbid exactly the embedding the product is built on and
//     every app would go blank. That is the regression this file exists to
//     prevent.
//
// Run with: node --test tests/security-headers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  baseSecurityHeaders, applyShellFramingHeaders, shellFrameAncestors,
  REFERRER_POLICY, SHELL_FRAME_ANCESTORS, PRODUCTION_ORIGIN, LOCAL_PREVIEW_ANCESTOR,
} = require('../src/middleware/security-headers');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

async function get(server, p = '/') {
  const { port } = server.address();
  const resp = await fetch(`http://127.0.0.1:${port}${p}`);
  await resp.text();
  return resp;
}

// A miniature of server.js's shape: the global middleware first, then
// routes, one of which is the shell document and one of which is app content.
function buildApp() {
  const app = express();
  app.use(baseSecurityHeaders());
  app.get('/shell', (_req, res) => {
    applyShellFramingHeaders(res);
    res.type('html').send('<!doctype html><title>shell</title>');
  });
  app.get('/app-file', (_req, res) => res.type('html').send('<p>an app</p>'));
  app.get('/api/thing', (_req, res) => res.json({ ok: true }));
  // A route with its own policy, like the sandboxed attachment renderers.
  app.get('/sandboxed', (_req, res) => {
    res.set('Content-Security-Policy', 'sandbox allow-scripts');
    res.type('html').send('<p>attachment</p>');
  });
  return app;
}

// ── The floor, on everything ───────────────────────────────────────────

test('every response carries nosniff and a Referrer-Policy', async () => {
  const server = await listen(buildApp());
  try {
    for (const p of ['/shell', '/app-file', '/api/thing']) {
      const res = await get(server, p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(res.headers.get('referrer-policy'), REFERRER_POLICY, p);
    }
  } finally { server.close(); }
});

// The leak this closes: a cross-origin navigation must send the ORIGIN only,
// never the path or query, or `?token=<JWT>` rides the Referer.
test('the Referrer-Policy is one that withholds the query cross-origin', () => {
  assert.equal(REFERRER_POLICY, 'strict-origin-when-cross-origin');
  for (const weak of ['unsafe-url', 'no-referrer-when-downgrade', 'origin-when-cross-origin']) {
    assert.notEqual(REFERRER_POLICY, weak, `${weak} still sends the full URL somewhere`);
  }
});

// ── The framing headers, on the shell and NOWHERE else ─────────────────

test('the shell document refuses third-party framing', async () => {
  const server = await listen(buildApp());
  try {
    const res = await get(server, '/shell');
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  } finally { server.close(); }
});

// THE REGRESSION THIS FILE EXISTS FOR. Apps are framed by the shell from
// their own origins. If the framing headers ever go global, every app frame
// breaks and the failure looks like "apps are blank", not like a header
// change.
test('app content carries NO framing restriction', async () => {
  const server = await listen(buildApp());
  try {
    const res = await get(server, '/app-file');
    assert.equal(res.headers.get('x-frame-options'), null,
      'the shell frames apps cross-origin; restricting them breaks every app');
    const csp = res.headers.get('content-security-policy');
    assert.ok(!csp || !/frame-ancestors/.test(csp),
      `app content must not be given a frame-ancestors policy (got ${csp})`);
  } finally { server.close(); }
});

test("'self' is the chosen value, not 'none'", () => {
  // The platform frames its own pages — app-error renders inside the shell's
  // app iframe as well as in a direct tab — so 'none' would block that too.
  assert.equal(SHELL_FRAME_ANCESTORS, "frame-ancestors 'self'");
});

// ── Routes that have thought about their own policy still win ──────────

test('a route that sets its own CSP is not overridden', async () => {
  const server = await listen(buildApp());
  try {
    const res = await get(server, '/sandboxed');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts',
      'the sandboxed attachment renderers must keep their own policy');
    // ...and still get the floor.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally { server.close(); }
});

test('applyShellFramingHeaders appends rather than clobbering an existing CSP', () => {
  const headers = {};
  const res = {
    getHeader: (k) => headers[k.toLowerCase()],
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
  };
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  applyShellFramingHeaders(res);
  assert.match(headers['content-security-policy'], /default-src 'self'/,
    'an existing directive must survive');
  assert.match(headers['content-security-policy'], /frame-ancestors 'self'/);
});

// ── The wiring in server.js ────────────────────────────────────────────

test('server.js mounts the base headers globally, ahead of the routers', () => {
  // Raw source, not comment-stripped: server.js contains `/*` inside string
  // and regex literals, and a naive block-comment strip swallows a span of
  // real code with it. These three lines cannot appear in a comment anyway.
  const src = read('server.js');
  assert.match(src, /app\.use\(baseSecurityHeaders\(\)\);/);
  const at = src.indexOf('app.use(baseSecurityHeaders());');
  const cors = src.indexOf('app.use(publicApiCors());');
  const auth = src.indexOf('app.use(authMiddleware(config));');
  assert.ok(at > 0 && at < cors, 'it must precede the CORS tier');
  assert.ok(at < auth, 'and every gate and router after it');
});

test('both shell-document seams get the framing headers', () => {
  const src = read('server.js');
  // The static handler's index.html branch, and the SPA fallback. Two
  // different routes serve the same document; missing one leaves the shell
  // frameable by whichever path a browser happens to take.
  const hits = (src.match(/applyShellFramingHeaders\(res\)/g) || []).length;
  assert.equal(hits, 2, `expected both seams, found ${hits}`);
});

// It is called from server.js rather than from inside
// applyShellDocumentHeaders because that function returns early when there is
// no build id — and whether a deployment happens to be a built image must not
// decide whether the shell can be framed.
test('the framing call does not depend on a build id', () => {
  const staticCache = code(read('src/services/static-cache.js'));
  assert.doesNotMatch(staticCache, /applyShellFramingHeaders/,
    'applyShellDocumentHeaders returns early without a build id — do not hide the '
    + 'framing rule behind that');
});

test('no full script-src CSP was added without evidence', () => {
  // Deliberately out of scope: the shell carries inline bootstrap script, the
  // legacy public/js tags, a compiled Tailwind sheet and vendored libraries.
  // A policy that merely looks right breaks the app on a route nobody tested.
  const src = read('src/middleware/security-headers.js');
  assert.doesNotMatch(code(src), /script-src/,
    'a script-src policy belongs in its own change, report-only first');
});

// ── The staging exception, found in review ─────────────────────────────
//
// The platform is ITS OWN APP, so a proposal on this repository gets a
// staging container whose shell is loaded inside the PRODUCTION platform's
// staging iframe — cross-origin. src/middleware/auth.js documents the chain
// and ends with "app-view.js sets `iframe.src = stagingUrl + '?token=' + jwt`".
//
// A flat `frame-ancestors 'self'` would make every self-app proposal preview
// render a browser refusal instead of the staged shell — breaking the review
// surface that gates this repository's own merges, and doing it ONLY on
// staging, where nobody would look for a header bug.

function headerBag() {
  const headers = {};
  return {
    headers,
    getHeader: (k) => headers[k.toLowerCase()],
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
  };
}

test('on staging the production parent may frame the shell', () => {
  const res = headerBag();
  applyShellFramingHeaders(res, true);
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /frame-ancestors 'self'/);
  assert.ok(csp.includes(PRODUCTION_ORIGIN),
    `the production parent must be allowed on staging, got ${csp}`);
});

test('on staging X-Frame-Options is omitted, not set to SAMEORIGIN', () => {
  // Its vocabulary is DENY / SAMEORIGIN only — ALLOW-FROM is dead — so a
  // SAMEORIGIN it cannot qualify would contradict the CSP, and a browser
  // honouring the older header would refuse the preview anyway.
  const res = headerBag();
  applyShellFramingHeaders(res, true);
  assert.equal(res.headers['x-frame-options'], undefined,
    'a SAMEORIGIN here would refuse the cross-origin preview the CSP allows');
});

test('production is unchanged by the staging exception', () => {
  const res = headerBag();
  applyShellFramingHeaders(res, false);
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'",
    'production must not inherit the staging allowance');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.ok(!res.headers['content-security-policy'].includes(PRODUCTION_ORIGIN));
});

test('the allowance names explicit origins, never a bare wildcard', () => {
  const staging = shellFrameAncestors(true);
  assert.match(staging, /https:\/\//, 'an explicit https production origin');
  assert.doesNotMatch(staging, /(^|\s)\*(\s|$)/, 'never a bare `*` framer');
  assert.doesNotMatch(staging, /https:\/\/\*/, 'and no wildcard host');
  assert.equal(SHELL_FRAME_ANCESTORS, shellFrameAncestors(),
    'the exported constant tracks the running environment');
});

// The second half of the same flow, also from review: in local Docker
// development the preview is `http://localhost:<random port>` while the
// parent shell is on a DIFFERENT localhost port. A staging container cannot
// infer that port, and cannot key on NODE_ENV either — it inherits
// `NODE_ENV=production` from the image and staging-env.js does not override
// it. The port wildcard is what CSP offers, and it is confined to staging.
test('a local cross-port parent can frame a staging preview', () => {
  const staging = shellFrameAncestors(true);
  assert.ok(staging.includes(LOCAL_PREVIEW_ANCESTOR),
    `local previews are published on a random localhost port, got ${staging}`);
});

test('the localhost allowance never reaches production', () => {
  const production = shellFrameAncestors(false);
  assert.doesNotMatch(production, /localhost/,
    'production must not admit a localhost framer');
  assert.equal(production, "frame-ancestors 'self'");
});

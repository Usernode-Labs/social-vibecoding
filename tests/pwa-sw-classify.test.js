// Unit tests for the service worker's pure request classifier
// (public/sw.js → classifyRequest). This pins the offline-mode fetch
// contract: what is bypassed (writes, SSE, credentials, auth), what is
// cached network-first (shell, API), what is cache-first (immutable
// images), and which navigations may fall back to the cached SPA shell.
//
// sw.js detects Node via module.exports and skips all self.* wiring, so
// requiring it here is safe.
//
// Run with: node --test tests/pwa-sw-classify.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyRequest, NO_FALLBACK_PAGES } = require('../public/sw.js');

const ORIGIN = 'https://social-vibecoding.example';
const classify = (method, path, accept = null, mode = 'no-cors') =>
  classifyRequest(method, ORIGIN + path, accept, mode, ORIGIN);

test('non-GET requests are never intercepted', () => {
  assert.equal(classify('POST', '/api/apps/foo/messages'), 'bypass');
  assert.equal(classify('DELETE', '/api/apps/foo'), 'bypass');
  assert.equal(classify('POST', '/api/auth/logout'), 'bypass');
  assert.equal(classify('PUT', '/js/app.js'), 'bypass');
});

test('SSE streams are bypassed by accept header and by path', () => {
  assert.equal(classify('GET', '/api/sessions/42/events', 'text/event-stream'), 'bypass');
  // Known SSE path even without the header (e.g. EventSource polyfills).
  assert.equal(classify('GET', '/api/sessions/42/events'), 'bypass');
  // Any endpoint asked for as an event stream is bypassed.
  assert.equal(classify('GET', '/api/apps/foo/whatever', 'text/event-stream'), 'bypass');
});

test('credential and auth endpoints are bypassed — except /api/auth/me', () => {
  assert.equal(classify('GET', '/api/iframe-token'), 'bypass');
  assert.equal(classify('GET', '/api/auth/logout'), 'bypass');
  assert.equal(classify('GET', '/api/auth/wallet-challenge'), 'bypass');
  assert.equal(classify('GET', '/api/auth/me'), 'api');
  assert.equal(classify('GET', '/api/cli/token/status'), 'bypass');
  assert.equal(classify('GET', '/api/cli/device/approval?user_code=ABCD-EFGH'), 'bypass');
  assert.equal(classify('GET', '/api/me/cli-tokens'), 'bypass');
  assert.equal(classify('GET', '/api/me/cli-tokens/42?x=1'), 'bypass');
});

test('the mock namespace and the /health probe hit the network directly', () => {
  assert.equal(classify('GET', '/__mock/enabled'), 'bypass');
  assert.equal(classify('GET', '/health'), 'bypass');
});

test('GET /api/* JSON is network-first-with-cache', () => {
  assert.equal(classify('GET', '/api/apps'), 'api');
  assert.equal(classify('GET', '/api/apps?demo=1'), 'api');
  assert.equal(classify('GET', '/api/apps/foo/messages?limit=50'), 'api');
  assert.equal(classify('GET', '/api/me/proposals'), 'api');
  assert.equal(classify('GET', '/api/version'), 'api');
});

test('shell assets classify as shell', () => {
  assert.equal(classify('GET', '/js/app.js'), 'shell');
  assert.equal(classify('GET', '/css/app.css'), 'shell');
  // Compiled Tailwind + the vendored libs that replaced the CDN tags.
  assert.equal(classify('GET', '/css/tailwind.css'), 'shell');
  assert.equal(classify('GET', '/vendor/marked-15.0.12.min.js'), 'shell');
  assert.equal(classify('GET', '/vendor/qrcode-1.0.0.min.js'), 'shell');
  assert.equal(classify('GET', '/usernode-bridge.js'), 'shell');
  assert.equal(classify('GET', '/usernode-bridge/v1/bridge.js'), 'shell');
  assert.equal(classify('GET', '/manifest.webmanifest'), 'shell');
  assert.equal(classify('GET', '/icons/icon-192.png'), 'shell');
});

test('content-addressed images are cache-first', () => {
  assert.equal(classify('GET', `/app-icons/${'a'.repeat(32)}`), 'immutable');
  assert.equal(classify('GET', `/visuals/${'b'.repeat(32)}`), 'immutable');
});

// ALL cross-origin traffic is bypassed now: the shell compiles Tailwind into
// /css/tailwind.css and vendors marked/DOMPurify/qrcodejs under /vendor/, so
// there is no third-party asset left to cache. The URLs that used to be
// special-cased are asserted explicitly, so a partial revert can't quietly
// leave the SW half-wired to a CDN it no longer loads.
test('all cross-origin requests are bypassed', () => {
  assert.equal(classifyRequest('GET', 'https://cdn.tailwindcss.com/', null, 'no-cors', ORIGIN), 'bypass');
  assert.equal(classifyRequest('GET',
    'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', null, 'cors', ORIGIN), 'bypass');
  assert.equal(classifyRequest('GET',
    'https://cdn.jsdelivr.net/npm/dompurify@3.4.4/dist/purify.min.js', null, 'cors', ORIGIN), 'bypass');
  assert.equal(classifyRequest('GET',
    'https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js', null, 'no-cors', ORIGIN), 'bypass');
  // Arbitrary third-party hosts (and child-app subdomains) are untouched.
  assert.equal(classifyRequest('GET', 'https://evil.example/x.js', null, 'no-cors', ORIGIN), 'bypass');
  assert.equal(classifyRequest('GET',
    'https://myapp.social-vibecoding.example/', null, 'navigate', ORIGIN), 'bypass');
});

test('SPA navigations may fall back to the cached shell', () => {
  assert.equal(classify('GET', '/', 'text/html', 'navigate'), 'navigate');
  // The old standalone auth pages are redirect stubs into the SPA's hash
  // routes (fold-auth-pages-into-SPA), so falling back to the cached
  // shell offline is correct for them too.
  assert.equal(classify('GET', '/login.html', 'text/html', 'navigate'), 'navigate');
  assert.equal(classify('GET', '/register.html', 'text/html', 'navigate'), 'navigate');
  assert.equal(classify('GET', '/landing.html', 'text/html', 'navigate'), 'navigate');
  assert.equal(classify('GET', '/waiting.html', 'text/html', 'navigate'), 'navigate');
  assert.equal(classify('GET', '/some/spa/route', 'text/html', 'navigate'), 'navigate');
});

// #860: the seven standalone admin pages became #admin console sections and
// their old URLs are redirect stubs into the SPA — exactly the shape the
// auth pages already had, so the cached shell is the right offline
// fallback for them now. This is the regression that matters: leaving them
// in NO_FALLBACK_PAGES would make every old bookmark a hard failure offline
// rather than a stub that resolves from cache.
test('the folded-in admin pages fall back to the cached shell', () => {
  const folded = [
    '/admin', '/admin.html',
    '/admin-features', '/admin-features.html',
    '/dashboard', '/dashboard.html',
    '/debug', '/debug.html',
    '/gallery', '/gallery.html',
    '/status', '/status.html',
    '/node-status', '/node-status.html',
  ];
  for (const page of folded) {
    assert.ok(!NO_FALLBACK_PAGES.includes(page),
      `${page} is a redirect stub into the SPA now — it must NOT be in NO_FALLBACK_PAGES`);
    assert.equal(classify('GET', page, 'text/html', 'navigate'), 'navigate');
  }
});

test('standalone server pages never fall back to the SPA shell', () => {
  // The two genuine standalone server pages, both pre-auth consent flows
  // deliberately outside the app shell with their own stylesheets:
  //   /cli/authorize     — the CLI / local coding-agent device flow
  //   /connect/authorize — the hosted MCP connector (Claude.ai, ChatGPT)
  // Serving either from the cached SPA shell would show a page that looks
  // signed in but cannot approve anything.
  assert.deepEqual(NO_FALLBACK_PAGES, ['/cli/authorize', '/connect/authorize']);
  assert.equal(classify('GET', '/cli/authorize', 'text/html', 'navigate'), 'bypass');
  assert.equal(classify('GET', '/connect/authorize', 'text/html', 'navigate'), 'bypass');
});

test('unparseable URLs are bypassed', () => {
  assert.equal(classifyRequest('GET', 'not a url', null, 'no-cors', undefined), 'bypass');
});

test('eviction-immune paths are paths the worker actually caches', () => {
  // Immunity is meaningless for a bypassed path — the entry would never
  // exist to be protected. This keeps IMMUNE_API_PATHS and the classifier
  // from drifting apart (#1021).
  const { IMMUNE_API_PATHS } = require('../public/sw.js');
  for (const p of IMMUNE_API_PATHS) {
    assert.equal(classify('GET', p), 'api', `${p} is immune but never cached`);
  }
});

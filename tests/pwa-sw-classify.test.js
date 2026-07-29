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

const { classifyRequest, isStaleLegacyCache, NO_FALLBACK_PAGES } = require('../public/sw.js');

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
  assert.equal(classify('GET', '/usernode-bridge.js'), 'shell');
  assert.equal(classify('GET', '/usernode-bridge/v1/bridge.js'), 'shell');
  assert.equal(classify('GET', '/manifest.webmanifest'), 'shell');
  assert.equal(classify('GET', '/icons/icon-192.png'), 'shell');
});

test('content-addressed images are cache-first', () => {
  assert.equal(classify('GET', `/app-icons/${'a'.repeat(32)}`), 'immutable');
  assert.equal(classify('GET', `/visuals/${'b'.repeat(32)}`), 'immutable');
});

test('known CDN scripts classify as cdn; other cross-origin is bypassed', () => {
  assert.equal(classifyRequest('GET', 'https://cdn.tailwindcss.com/', null, 'no-cors', ORIGIN), 'cdn');
  assert.equal(classifyRequest('GET',
    'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', null, 'cors', ORIGIN), 'cdn');
  assert.equal(classifyRequest('GET',
    'https://cdn.jsdelivr.net/npm/dompurify@3.4.4/dist/purify.min.js', null, 'cors', ORIGIN), 'cdn');
  assert.equal(classifyRequest('GET',
    'https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js', null, 'no-cors', ORIGIN), 'cdn');
  // Arbitrary third-party hosts (and child-app subdomains) are untouched.
  assert.equal(classifyRequest('GET', 'https://evil.example/x.js', null, 'no-cors', ORIGIN), 'bypass');
  assert.equal(classifyRequest('GET',
    'https://myapp.social-vibecoding.example/', null, 'navigate', ORIGIN), 'bypass');
});

test('SPA navigations may fall back to the cached shell', () => {
  assert.equal(classify('GET', '/', 'text/html', 'navigate'), 'navigate');
  assert.equal(classify('GET', '/login.html', 'text/html', 'navigate'), 'navigate');
  assert.equal(classify('GET', '/some/spa/route', 'text/html', 'navigate'), 'navigate');
});

test('standalone server pages never fall back to the SPA shell', () => {
  for (const page of ['/admin', '/admin-features', '/dashboard', '/debug', '/node-status', '/status', '/register.html']) {
    assert.ok(NO_FALLBACK_PAGES.includes(page), `${page} missing from NO_FALLBACK_PAGES`);
    assert.equal(classify('GET', page, 'text/html', 'navigate'), 'bypass');
  }
});

test('unparseable URLs are bypassed', () => {
  assert.equal(classifyRequest('GET', 'not a url', null, 'no-cors', undefined), 'bypass');
});

test('legacy cleanup retires only legacy-owned cache families', () => {
  assert.equal(isStaleLegacyCache('usernode-api-v0'), true);
  assert.equal(isStaleLegacyCache('usernode-shell-v0'), true);
  assert.equal(isStaleLegacyCache('usernode-api-v1'), false);
  assert.equal(isStaleLegacyCache('usernode-react-shell-v1'), false);
  assert.equal(isStaleLegacyCache('usernode-unrelated-v1'), false);
});

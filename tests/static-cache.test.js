// Tests for the shell static-asset cache policy.
//
// Root cause of "the Members & visibility fix had no effect / same as
// before": the platform shell's own /js/app.js (and the rest of public/)
// was served by plain express.static with send's default `max-age=0`.
// Mobile WebViews on a PR's stable staging URL cached it and kept running
// the pre-fix code across redeploys, so corrected JS never actually ran.
// shellAssetCacheControl() forces HTML/JS/CSS to revalidate every load
// (like the centrally-hosted bridge), and server.js wires it into both the
// static handler and the SPA fallback. These tests would have caught a
// missing/again-default cache policy.
//
// Run with: node --test tests/static-cache.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { shellAssetCacheControl, REVALIDATE } = require('../src/services/static-cache');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('shell assets (html/js/css) revalidate every load', () => {
  for (const p of ['/js/app.js', '/js/app-view.js', '/css/app.css', '/index.html', '/ADMIN.HTML']) {
    assert.equal(shellAssetCacheControl(p), REVALIDATE, `${p} must revalidate`);
  }
  assert.equal(REVALIDATE, 'no-cache, must-revalidate');
});

test('non-shell assets are left to the default (null → no override)', () => {
  for (const p of ['/img/logo.png', '/fonts/x.woff2', '/data.json', '/usernode-bridge/v1/bridge.js'.replace('.js', '.map'), '/x.svg']) {
    assert.equal(shellAssetCacheControl(p), null, `${p} should not be forced`);
  }
});

test('the policy overrides send\'s default max-age header', () => {
  // Simulate what express.static(setHeaders) does: send has already set its
  // default Cache-Control, then our callback runs and must win.
  const headers = { 'Cache-Control': 'public, max-age=0' };
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  const cc = shellAssetCacheControl('/js/app.js');
  if (cc) res.setHeader('Cache-Control', cc);
  assert.equal(headers['Cache-Control'], 'no-cache, must-revalidate', 'no-cache wins over max-age=0');
});

test('server.js wires the policy into express.static setHeaders', () => {
  assert.match(SERVER_SRC, /shellAssetCacheControl/, 'helper imported/used in server.js');
  assert.match(
    SERVER_SRC,
    /express\.static[\s\S]{0,200}setHeaders[\s\S]{0,200}shellAssetCacheControl/,
    'express.static is configured with a setHeaders that consults the policy',
  );
});

test('server.js applies the policy to the SPA html fallback too', () => {
  // The app.get('*') fallback serves index.html for client-side routes; it
  // must not be pinnable in a WebView cache either.
  const fallback = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('*'"));
  assert.match(fallback, /shellAssetCacheControl\('index\.html'\)/, 'fallback sets no-cache on index.html');
});

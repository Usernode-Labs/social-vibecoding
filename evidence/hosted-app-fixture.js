#!/usr/bin/env node
'use strict';

// A deliberately small, dependency-free hosted app for platform visual
// evidence. It is deployed through the ordinary app runtime and HTTPS edge,
// then opened in Homeroom's real managed iframe. It never calls an external
// service, writes browser storage, or logs the token-bearing launch URL.

const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);
const NONCE = 'homeroom-evidence-bridge-v1';
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Homeroom evidence app</title>
  <style nonce="${NONCE}">
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#18181b;padding:24px}
    main{width:min(560px,100%);border:1px solid #d4d4d8;border-radius:20px;background:#fff;padding:28px;box-shadow:0 16px 40px rgba(24,24,27,.08)}
    .eyebrow{margin:0 0 8px;color:#2563eb;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    h1{margin:0 0 10px;font-size:28px;line-height:1.15}
    .summary{margin:0 0 22px;color:#52525b;line-height:1.5}
    .status{display:flex;align-items:center;gap:10px;margin:0 0 18px;padding:12px 14px;border-radius:12px;background:#f4f4f5;font-weight:650}
    .dot{width:10px;height:10px;border-radius:50%;background:#a1a1aa}
    .ready .dot{background:#16a34a;box-shadow:0 0 0 4px rgba(22,163,74,.14)}
    dl{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;margin:0;font-size:14px}
    dt{color:#71717a}dd{margin:0;font-weight:600;overflow-wrap:anywhere}
    @media(prefers-color-scheme:dark){body{background:#18181b;color:#fafafa}main{background:#27272a;border-color:#3f3f46}.summary,dt{color:#a1a1aa}.status{background:#3f3f46}}
  </style>
</head>
<body>
  <main data-testid="evidence-hosted-app">
    <p class="eyebrow">Platform test app</p>
    <h1>Hosted app frame</h1>
    <p class="summary">This isolated app verifies Homeroom's real cross-origin frame and bridge.</p>
    <div id="bridge-status" class="status" role="status"><span class="dot" aria-hidden="true"></span><span>Waiting for Homeroom bridge…</span></div>
    <dl>
      <dt>Bridge SDK</dt><dd id="sdk-value">Waiting…</dd>
      <dt>Locale</dt><dd id="locale-value">Waiting…</dd>
      <dt>Safe area</dt><dd id="safe-area-value">Waiting…</dd>
    </dl>
  </main>
  <script src="/usernode-bridge/v1/bridge.js"></script>
  <script nonce="${NONCE}">
    (() => {
      const state = { sdk: false, locale: false, safeArea: false };
      const parentOrigin = (() => { try { return new URL(document.referrer).origin; } catch { return '*'; } })();
      const localeId = 'evidence-locale';
      const safeAreaId = 'evidence-safe-area';
      const render = () => {
        if (!state.sdk || !state.locale || !state.safeArea) return;
        const status = document.getElementById('bridge-status');
        status.classList.add('ready');
        status.querySelector('span:last-child').textContent = 'Bridge ready';
      };
      if (window.usernode && typeof window.usernode.getUserLocale === 'function') {
        document.getElementById('sdk-value').textContent = 'Loaded';
        state.sdk = true;
        // Exercise the public API as a normal hosted app does. The explicit
        // requests below remain the readiness signal because this API has a
        // documented fallback when an older shell does not answer.
        window.usernode.getUserLocale().catch(() => {});
      }
      addEventListener('message', (event) => {
        if (event.source !== parent) return;
        if (parentOrigin !== '*' && event.origin !== parentOrigin) return;
        const data = event.data || {};
        if (data.__usernode_locale === 'response' && data.id === localeId) {
          document.getElementById('locale-value').textContent = data.value?.locale || 'Platform default';
          state.locale = true;
          render();
        }
        if (data.__usernode_safe_area === 'response' && data.id === safeAreaId) {
          const value = data.value || {};
          document.getElementById('safe-area-value').textContent = [value.top,value.right,value.bottom,value.left].map((item) => Number(item) || 0).join(' / ');
          state.safeArea = true;
          render();
        }
      });
      const request = () => {
        parent.postMessage({ __usernode_locale: 'get', id: localeId }, parentOrigin);
        parent.postMessage({ __usernode_safe_area: 'get', id: safeAreaId }, parentOrigin);
      };
      request();
      const retry = setInterval(() => {
        if (state.locale && state.safeArea) clearInterval(retry); else request();
      }, 250);
      setTimeout(() => clearInterval(retry), 10000);
    })();
  </script>
</body>
</html>`;

function createServer() {
  return http.createServer((req, res) => {
    const path = String(req.url || '/').split('?', 1)[0];
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{"ok":true}');
    }
    if (path === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      return res.end();
    }
    if (path !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${NONCE}'; style-src 'nonce-${NONCE}'; frame-ancestors *; base-uri 'none'; form-action 'none'`,
      // The bridge uses only the parent's origin. Never expose the path or
      // token-bearing query, but keep the origin so replies can be fenced.
      'referrer-policy': 'origin',
      'x-content-type-options': 'nosniff',
    });
    return res.end(HTML);
  });
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid fixture port.');
  const server = createServer();
  server.listen(PORT, '0.0.0.0');
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { HTML, NONCE, createServer };

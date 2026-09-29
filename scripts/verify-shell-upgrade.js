#!/usr/bin/env node
'use strict';

// Real browser companion to the required VM lifecycle suite. Uses an isolated
// loopback fixture and browser profile; no platform database or server access.
// PUPPETEER_MODULE / BROWSER_EXECUTABLE can select existing local installs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer');
const { fixture } = require('../tests/lib/shell-release-fixture');

(async () => {
  const cleanups = [];
  const t = { after: fn => cleanups.push(fn) };
  const a = fixture(t, 'a');
  const b = fixture(t, 'b');
  const c = fixture(t, 'c', { '/js/app.js': b.read('/js/app.js'), '/css/app.css': 'body { color: rgb(40, 50, 60); }' });
  const d = fixture(t, 'd');
  let serving = a;
  let failed = null;
  const requests = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(pathname);
    const file = pathname === '/' ? '/index.html' : pathname === '/sw.js' ? '/shell/worker.js'
      : pathname.replace(/^\/b\/[a-f0-9]{40}/, '');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('X-Platform-Build', serving.revision);
    res.setHeader('X-Platform-Build-Time', String(serving.revision.charCodeAt(0) * 1000));
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html');
    if (file === failed) { res.writeHead(503); res.end('controlled failure'); return; }
    try { res.end(serving.read(file)); }
    catch { res.writeHead(404); res.end('missing'); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const old = await browser.newPage();
    await old.goto(origin);
    await old.evaluate(async () => { await navigator.serviceWorker.ready; });
    await old.waitForFunction(() => !!navigator.serviceWorker.controller);
    await old.type('#draft', 'Keep this unsaved draft');
    await old.evaluate(async () => {
      await (await caches.open('usernode-api')).put('/api/auth/me', new Response('{"id":3}'));
      await import('/b/' + 'a'.repeat(40) + '/shell/assets/shell-lazy.js');
    });

    serving = b; requests.length = 0;
    const page = await browser.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#version').textContent === 'b');
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
    assert.equal(await old.$eval('#draft', el => el.value), 'Keep this unsaved draft');
    assert.ok(!requests.some(url => url.endsWith('/css/app.css')), 'unchanged stylesheet must be reused');
    assert.equal(await old.evaluate(async () => (await (await caches.open('usernode-api')).match('/api/auth/me')).text()), '{"id":3}');
    console.log('PASS: same-profile update, unchanged-asset reuse, sign-in and unsaved old tab');

    serving = c; requests.length = 0;
    await page.reload();
    await page.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(40, 50, 60)');
    assert.ok(!requests.some(url => url.endsWith('/js/app.js')), 'CSS-only update must reuse JavaScript');
    assert.equal(await page.evaluate(async () => (await window.loadLazy()).version), 'c',
      'reused module bytes must resolve relative imports under the requesting build');
    console.log('PASS: CSS-only update without a worker source edit or a JavaScript download');

    await page.setOfflineMode(true);
    await page.reload();
    assert.equal(await page.$eval('#version', el => el.textContent), 'b');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(40, 50, 60)');
    await page.setOfflineMode(false);
    console.log('PASS: complete updated shell remains usable offline');

    serving = d; failed = '/js/app.js';
    await page.reload();
    assert.equal(await page.$eval('#version', el => el.textContent), 'b');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(40, 50, 60)');
    failed = null;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#version').textContent === 'd');
    assert.equal(await old.$eval('#draft', el => el.value), 'Keep this unsaved draft');
    assert.equal(await old.evaluate(async () => (await import('/b/' + 'a'.repeat(40) + '/shell/assets/shell-lazy.js')).version), 'a');
    console.log('PASS: failed release retains old shell, retry succeeds, old cached lazy chunk survives');

    serving = b;
    // Rollbacks use the existing /api/version -> explicit prefetch flow.
    // A lone older HTML response during a mixed rollout cannot downgrade us.
    await page.evaluate(async expected => {
      await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => event.data.ok ? resolve() : reject(new Error('Rollback prefetch failed'));
        navigator.serviceWorker.controller.postMessage({ type: 'prefetch-shell', sha: expected }, [channel.port2]);
      });
    }, b.revision);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#version').textContent === 'b');
    console.log('PASS: rollback in the same browser profile');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    for (const cleanup of cleanups) cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

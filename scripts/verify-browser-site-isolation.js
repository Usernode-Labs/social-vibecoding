#!/usr/bin/env node
'use strict';

// Local synthetic acceptance, never a production probe. Requires openssl,
// Chrome, and capture's pinned puppeteer-core (or an installation on NODE_PATH).
// CHROME_EXECUTABLE may select a local Chromium binary. No credentials needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

async function main() {
  const root = path.join(__dirname, '..');
  const { launch } = require(require.resolve('puppeteer-core', { paths: [path.join(root, 'capture')] }));
  const { buildSync } = require(require.resolve('esbuild', { paths: [path.join(root, 'frontend')] }));
  process.env.NODE_ENV = 'production';
  process.env.BROWSER_SITE_ISOLATION = 'strict';
  const express = require('express');
  const { readSessionCookie, setSessionCookie } = require('../src/services/browser-session-cookies');
  const { setSessionCacheCookie, stampApiIdentity, sessionCacheScope,
    browserApiCachePolicy } = require('../src/services/browser-api-cache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-isolation-'));
  let server, browser;
  try {
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=platform.sec13.test',
      '-addext', 'subjectAltName=DNS:platform.sec13.test,DNS:sibling.sec13.test,DNS:app.other.test'],
    { stdio: 'ignore' });
    const bundled = buildSync({ entryPoints: [path.join(root, 'frontend/src/lib/api-cache-identity.ts')],
      bundle: true, write: false, format: 'iife', globalName: 'CookieIdentity' }).outputFiles[0].text;
    const app = express(), observations = [];
    let offline = false;
    const expiry = new Date(Date.now() + 3600e3);
    app.use(browserApiCachePolicy);
    app.get('/sw.js', (_req, res) => res.type('js').send(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8')));
    app.get('/seed', (req, res) => {
      const who = req.query.who === 'B' ? 'B' : 'A';
      setSessionCookie(res, who, expiry);
      setSessionCacheCookie(res, who, expiry);
      res.type('html').send(pageHtml());
    });
    app.get('/toss', (_req, res) => {
      res.setHeader('Set-Cookie', [
        `usernode_api_scope=${sessionCacheScope('B')}; Domain=sec13.test; Path=/; Secure`,
        'session=B; Domain=sec13.test; Path=/; Secure',
        '__Host-usernode_session=B; Domain=sec13.test; Path=/; Secure; HttpOnly',
        `__Host-usernode_api_scope=${sessionCacheScope('B')}; Domain=sec13.test; Path=/; Secure`,
        `__Host-usernode_api_scope=${sessionCacheScope('B')}; Path=/narrow; Secure`,
      ]);
      res.type('html').send('Synthetic sibling');
    });
    app.post('/observe', (req, res) => {
      observations.push({ site: req.get('Sec-Fetch-Site'), authenticated: readSessionCookie(req) === 'A' });
      res.sendStatus(204);
    });
    app.get('/api/private-fixture', (req, res) => {
      // Chrome's page-level offline emulation does not cover every worker
      // network target. Fail at the local server too, so an offline assertion
      // cannot accidentally pass from a worker's successful network request.
      if (offline) { req.socket.destroy(); return; }
      const who = readSessionCookie(req);
      if (!['A', 'B'].includes(who)) return res.status(401).json({ error: 'synthetic refusal' });
      stampApiIdentity(req, res, who, expiry);
      return res.json({ synthetic: who });
    });
    function pageHtml() {
      return `<html><head><title>Synthetic cookie acceptance</title></head><body><script>${bundled}\nCookieIdentity.installApiCacheIdentity(window);</script></body></html>`;
    }
    app.get('*', (_req, res) => res.type('html').send(pageHtml()));
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const platform = `https://platform.sec13.test:${port}`;
    const sibling = `https://sibling.sec13.test:${port}`;
    const isolated = `https://app.other.test:${port}`;
    browser = await launch({
      executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, acceptInsecureCerts: true,
      args: ['--ignore-certificate-errors', '--no-proxy-server',
        '--host-resolver-rules=MAP platform.sec13.test 127.0.0.1,MAP sibling.sec13.test 127.0.0.1,MAP app.other.test 127.0.0.1'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(platform + '/seed?who=A');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    const read = () => page.evaluate(async () => (await fetch('/api/private-fixture')).json());
    assert.deepEqual(await read(), { synthetic: 'A' });
    await page.waitForFunction(async () => (await (await caches.open('usernode-api')).keys()).length > 0);
    const attacker = await browser.newPage();
    await attacker.goto(sibling + '/toss');
    await attacker.evaluate(async origin => {
      await fetch(origin + '/observe', { method: 'POST', mode: 'no-cors', credentials: 'include', body: 'synthetic' });
    }, platform);
    await attacker.goto(isolated + '/');
    await attacker.evaluate(async origin => {
      await fetch(origin + '/observe', { method: 'POST', mode: 'no-cors', credentials: 'include', body: 'synthetic' });
    }, platform);
    assert.deepEqual(observations, [
      { site: 'same-site', authenticated: true }, { site: 'cross-site', authenticated: false },
    ]);
    assert.equal(await page.evaluate(() => CookieIdentity.readApiCacheScope(document)), sessionCacheScope('A'));
    assert.deepEqual(await read(), { synthetic: 'A' });
    offline = true;
    await page.setOfflineMode(true);
    assert.deepEqual(await read(), { synthetic: 'A' });
    offline = false;
    await page.setOfflineMode(false);
    await page.evaluate(label => {
      document.cookie = `usernode_api_scope=${label}; Path=/; Secure; SameSite=Lax`;
    }, sessionCacheScope('A'));
    await page.goto(platform + '/seed?who=B');
    assert.equal(await page.evaluate(() => CookieIdentity.readApiCacheScope(document)), sessionCacheScope('B'));
    assert.equal((await browser.defaultBrowserContext().cookies()).some(cookie =>
      cookie.name === 'usernode_api_scope' && cookie.domain === 'platform.sec13.test'),
    false, 'login retires the host-local old tab hint; a parent-domain forgery stays ignored');
    offline = true;
    await page.setOfflineMode(true);
    const refused = await page.evaluate(async () => {
      try { await (await fetch('/api/private-fixture')).json(); return false; } catch { return true; }
    });
    assert.equal(refused, true, 'B never receives A from the same offline URL');
    console.log(JSON.stringify({ browser: await browser.version(),
      siblingCookieInjection: 'refused', strictLegacyOverride: 'refused',
      sameSessionOffline: 'passed', differentSessionOffline: 'refused',
      observedAppSite: 'cross-site', crossSiteAmbientSession: 'absent' }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

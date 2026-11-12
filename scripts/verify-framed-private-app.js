#!/usr/bin/env node
'use strict';

// Local synthetic acceptance for a PRIVATE app inside Homeroom's app frame,
// never a production probe (docs/plans/browser-site-isolation.md, step 4).
//
// It stands up, on one local HTTPS port:
//   * a synthetic platform shell at https://platform.127.0.0.1.nip.io that
//     signs a synthetic member in, mints /api/iframe-token with the real
//     platform-jwt, loads the real public/js/app-view.js (whose message relays
//     answer the frame) and frames the app the way the shell does;
//   * the real app-host gate: scripts/app-gate.js in front of a synthetic
//     app, asking the real edge-gate.handleAccess over a private HTTP port,
//     with a stubbed database;
//   * a probe host on the apps' site that sets an unpartitioned and a
//     partitioned SameSite=None cookie from inside the frame, which says what
//     the browser itself does with third-party cookies.
//
// Layouts: `--layout cross` puts the apps on 127.0.0.1.sslip.io, a different
// registrable domain from the platform's 127.0.0.1.nip.io (the
// onhomeroom.com / onhomeroom.app split); `--layout same` puts them on
// apps.127.0.0.1.nip.io, today's shared site. Both names resolve to
// 127.0.0.1 in public DNS, so a phone simulator can reach them too; Chrome
// is pointed at 127.0.0.1 directly and asks no DNS at all.
//
// Scenarios, each in a fresh browser profile:
//   token      the shell frames `/?token=…` (an ordinary app)
//   tokenless  the shell frames `/?un-build=…#un-token=…` (an offline app's
//              one address: the token never reaches the gate)
// In each, the app's own page loads a stylesheet, an image and a script,
// fetches with and without the token header, opens a WebSocket without a
// token, then navigates its frame to a second page and does it all again.
//
//   node scripts/verify-framed-private-app.js --browser chrome [--layout cross|same] [--expect pass]
//   node scripts/verify-framed-private-app.js --browser chrome --no-frame-cookies --expect blocked
//   node scripts/verify-framed-private-app.js --serve [--layout cross] [--port 8443] [--dir <dir>]
//
// --no-frame-cookies blocks every cookie for the apps' site, partitioned
// ones too, which is what Safari 18.5 to 26.1 does in a cross-site frame:
// the frame must end on the page saying the app cannot open there, with no
// redirect loop.
//
// --serve keeps the servers up and prints the shell's address, for a browser
// driven by hand (iOS Simulator Safari: add <dir>/ca.pem with
// `xcrun simctl keychain booted add-root-cert <dir>/ca.pem`, then open the
// address). The shell posts what it saw to /observe; GET /results reads it.
// Chrome third-party cookie blocking is switched on in its profile and
// confirmed by the probe, not assumed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MEMBER_ID = 10;
const APP_ID = 7;
const SLUG = 'privapp';
const SESSION_TOKEN = 'c'.repeat(64);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function args() {
  const out = { layout: 'cross', browser: null, serve: false, port: 0, dir: null, expect: null, scenarios: ['token', 'tokenless'], noFrameCookies: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--layout') out.layout = argv[++i];
    else if (a === '--browser') out.browser = argv[++i];
    else if (a === '--serve') out.serve = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--expect') out.expect = argv[++i];
    else if (a === '--scenario') out.scenarios = [argv[++i]];
    else if (a === '--no-frame-cookies') out.noFrameCookies = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['cross', 'same'].includes(out.layout)) throw new Error('--layout is cross or same');
  if (!out.serve && out.browser !== 'chrome') throw new Error('pass --browser chrome or --serve');
  return out;
}

function hostsFor(layout) {
  const platform = 'platform.127.0.0.1.nip.io';
  const apps = layout === 'cross' ? '127.0.0.1.sslip.io' : 'apps.127.0.0.1.nip.io';
  return { platform, apps, app: `${SLUG}.${apps}`, probe: `probe.${apps}` };
}

// A throwaway CA and a leaf for both layouts' names, so a simulator can be
// told to trust the CA once.
function certificates(dir) {
  const ca = path.join(dir, 'ca.pem');
  const caKey = path.join(dir, 'ca-key.pem');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (fs.existsSync(cert) && fs.existsSync(key) && fs.existsSync(ca)) return { ca, key, cert };
  const names = [...new Set(['cross', 'same'].flatMap((l) => {
    const h = hostsFor(l);
    return [h.platform, h.app, h.probe];
  }))];
  const run = (argv) => execFileSync('openssl', argv, { stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '30',
    '-subj', '/CN=Homeroom framed-app synthetic CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const csr = path.join(dir, 'leaf.csr');
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${names[0]}`]);
  const ext = path.join(dir, 'leaf.ext');
  fs.writeFileSync(ext, [
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
    `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`,
  ].join('\n'));
  run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '30', '-extfile', ext]);
  return { ca, key, cert };
}

// ── The synthetic app behind the gate ──────────────────────────────────────

function appPage(name) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic private app</title>
<link rel="stylesheet" href="/app.css?p=${name}"></head><body>
<p>Synthetic private app, page ${name}.</p><img id="px" alt="" src="/pixel.png?p=${name}">
<script>window.__page = ${JSON.stringify(name)};</script>
<script src="/app.js?p=${name}"></script>
<script>setTimeout(function () { if (!window.__appJsRan) parent.postMessage({ __harness: { page: window.__page, script: false } }, '*'); }, 4000);</script>
</body></html>`;
}

const APP_JS = `(async function () {
  window.__appJsRan = true;
  var q = new URLSearchParams(location.search);
  var h = new URLSearchParams(location.hash.slice(1));
  var token = q.get('token') || h.get('un-token') || sessionStorage.getItem('harness-token');
  if (token) sessionStorage.setItem('harness-token', token);
  var r = { page: window.__page, script: true, href: location.pathname + location.search.replace(/token=[^&]+/, 'token=…') };
  r.css = getComputedStyle(document.body).color === 'rgb(1, 2, 3)';
  var img = document.getElementById('px');
  if (!img.complete) await new Promise(function (ok) { img.onload = img.onerror = ok; });
  r.image = img.naturalWidth === 1;
  async function status(url, init) {
    try { var res = await fetch(url, init); return res.status + (res.redirected ? ' redirected' : ''); } catch (e) { return 'network error'; }
  }
  r.fetchCookieOnly = await status('/api/plain');
  r.fetchWithToken = token ? await status('/api/me', { headers: { 'x-usernode-token': token } }) : 'no token';
  r.ws = await new Promise(function (done) {
    var ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { return done('refused'); }
    var t = setTimeout(function () { done('timeout'); try { ws.close(); } catch (e) {} }, 5000);
    ws.onmessage = function (e) { clearTimeout(t); done(String(e.data)); ws.close(); };
    ws.onerror = function () { clearTimeout(t); done('error'); };
  });
  parent.postMessage({ __harness: r }, '*');
  if (window.__page === 'home') setTimeout(function () { location.href = '/page2'; }, 50);
})();`;

function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, token: !!req.headers['x-usernode-token'] });
    if (url.pathname === '/' || url.pathname === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(appPage(url.pathname === '/' ? 'home' : 'page2'));
    }
    if (url.pathname === '/app.css') { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); return res.end('body { color: rgb(1, 2, 3); }'); }
    if (url.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end(APP_JS); }
    if (url.pathname === '/pixel.png') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(PIXEL); }
    if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    res.writeHead(404); return res.end();
  });
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ path: 'ws', token: !!req.headers['x-usernode-token'] });
    wss.handleUpgrade(req, socket, head, (ws) => { ws.send('hello'); });
  });
  return { server, seen };
}

// ── The stubbed database the gate and the apex read ───────────────────────

function fakePool() {
  const redeemed = new Set();
  const sid = crypto.createHash('sha256').update(SESSION_TOKEN).digest('hex');
  return {
    async query(sql, params = []) {
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (/SELECT id, view_visibility, moderation_suspended_at FROM apps WHERE slug/.test(sql)) {
        return { rows: params[0] === SLUG ? [{ id: APP_ID, view_visibility: 'private' }] : [] };
      }
      if (/SELECT view_visibility, moderation_suspended_at FROM apps WHERE id/.test(sql)) {
        return { rows: Number(params[0]) === APP_ID ? [{ view_visibility: 'private' }] : [] };
      }
      if (/FROM apps WHERE slug = \$1/.test(sql)) {
        return { rows: params[0] === SLUG ? [{ id: APP_ID, slug: SLUG, view_visibility: 'private', collab_visibility: 'private', created_by: 1, self_hosted: false, moderation_suspended_at: null }] : [] };
      }
      if (/FROM app_collaborators WHERE app_id = \$1 AND status = 'member'/.test(sql)) return { rows: [{ user_id: MEMBER_ID }] };
      if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(sql)) {
        return { rows: params[1] === MEMBER_ID ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT is_admin FROM users WHERE id/.test(sql)) return { rows: [{ is_admin: false }] };
      if (/FROM sessions\s+WHERE encode\(sha256\(token::bytea\), 'hex'\) = \$1/.test(sql)) {
        return { rows: params[0] === sid && params[1] === MEMBER_ID ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO edge_grant_redemptions/.test(sql)) {
        if (redeemed.has(params[0])) return { rows: [] };
        redeemed.add(params[0]);
        return { rows: [{ jti: params[0] }] };
      }
      if (/FROM users WHERE id/.test(sql)) {
        return { rows: [{ id: params[0], username: 'synthetic-member', usernode_pubkey: null, locale: 'en', is_synthetic: false }] };
      }
      if (/SELECT id FROM users WHERE username = \$1/.test(sql)) return { rows: [] };
      if (/SELECT runtime_name FROM apps WHERE id/.test(sql)) return { rows: [{ runtime_name: 'sv-app-7-privapp' }] };
      if (/FROM app_domains/.test(sql)) return { rows: [] };
      if (/offline_cache|app_runtime_sleep|chat_sessions/.test(sql)) return { rows: [] };
      throw new Error(`framed-app harness: unexpected query: ${sql.slice(0, 120)}`);
    },
  };
}

// ── The synthetic shell ───────────────────────────────────────────────────

function shellPage({ app, probe, scenario }) {
  const sandbox = 'allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-downloads';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Framed private app</title>
<style>body{font:14px system-ui;margin:12px} iframe{width:100%;height:160px;border:1px solid #888} pre{white-space:pre-wrap;font-size:11px}</style></head>
<body><h1>${scenario}</h1><pre id="out">waiting…</pre>
<iframe id="app-iframe" sandbox="" title="app"></iframe>
<iframe id="probe" title="probe"></iframe>
<script src="/js/app-view.js"></script>
<script>
(async function () {
  // What the rest of the shell would supply: the frame bridge's slug and the
  // signed-in user, which AppView._bridgeRequest reads.
  window.App = { user: { id: ${MEMBER_ID} } };
  window.UsernodeReact = { appFrame: { slug: function () { return ${JSON.stringify(SLUG)}; } } };
  var results = window.__results = { scenario: ${JSON.stringify(scenario)}, probe: null, pages: {} };
  function show() {
    document.getElementById('out').textContent = JSON.stringify(results, null, 1);
    fetch('/observe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(results) }).catch(function () {});
  }
  addEventListener('message', function (e) {
    var d = e.data && e.data.__harness;
    if (!d) return;
    if (d.page === 'probe') results.probe = d; else results.pages[d.page] = d;
    show();
  });
  document.getElementById('probe').src = ${JSON.stringify(`${probe}/set`)};
  var res = await fetch('/api/iframe-token?app=${SLUG}');
  var token = (await res.json()).token;
  var frame = document.getElementById('app-iframe');
  frame.setAttribute('sandbox', ${JSON.stringify(sandbox)});
  frame.src = ${JSON.stringify(scenario)} === 'tokenless'
    ? ${JSON.stringify(`${app}/?un-build=synthetic#un-token=`)} + encodeURIComponent(token)
    : ${JSON.stringify(`${app}/?token=`)} + encodeURIComponent(token) + '&un-theme=light';
  show();
})();
</script></body></html>`;
}

function probeRoutes(req, res) {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/set') {
    res.setHeader('Set-Cookie', [
      'probe_unpartitioned=1; Path=/; Secure; SameSite=None',
      '__Host-probe_partitioned=1; Path=/; Secure; SameSite=None; Partitioned',
    ]);
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end('<!doctype html><script>location.replace("/read")</script>');
  }
  const names = String(req.headers.cookie || '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  return res.end(`<!doctype html><script>parent.postMessage({ __harness: { page: 'probe', cookies: ${JSON.stringify(names)} } }, '*')</script>`);
}

async function main() {
  const opts = args();
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'framed-private-app-'));
  fs.mkdirSync(dir, { recursive: true });
  const tls = certificates(dir);
  const hosts = hostsFor(opts.layout);

  // The public port has to be known before the platform modules load:
  // USERNODE_DOMAIN carries it, as the browser sees it.
  let dispatch = (_req, res) => { res.writeHead(503); res.end(); };
  let dispatchUpgrade = (_req, socket) => socket.destroy();
  const front = https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert) }, (req, res) => dispatch(req, res));
  front.on('upgrade', (req, socket, head) => dispatchUpgrade(req, socket, head));
  await new Promise((resolve) => front.listen(opts.port || 0, '127.0.0.1', resolve));
  const port = front.address().port;
  // Chrome reaches every host through a CONNECT proxy here, so its addresses
  // carry the default port, as in production (the gate's sign-in callback
  // and its same-origin checks build `https://<host>` with no port). A hand-
  // driven browser has no such proxy and uses the listening port.
  const publicPort = opts.serve ? port : 443;
  const at = (host) => `https://${host}${publicPort === 443 ? '' : `:${publicPort}`}`;

  const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  Object.assign(process.env, {
    NODE_ENV: 'production',
    USERNODE_DOMAIN: at(hosts.platform).slice('https://'.length),
    USERNODE_APPS_DOMAIN: hosts.apps,
    IFRAME_JWT_PRIVATE_KEY: keys.privateKey,
    IFRAME_JWT_PUBLIC_KEY: keys.publicKey,
    EDGE_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    APP_HOST_SIGNIN: 'on',
  });
  delete process.env.APP_RUNTIME;

  const pool = fakePool();
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => pool } };
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const edgeGate = require('../src/services/edge-gate');
  const platformJwt = require('../src/services/platform-jwt');
  const { readSessionCookie, setSessionCookie } = require('../src/services/browser-session-cookies');
  const { createGate } = require('./app-gate');

  // What the gate decided, request by request.
  const decisions = [];
  const observations = [];
  const platform = express();
  platform.use(cookieParser());
  platform.use(express.json());
  const signedIn = (req) => readSessionCookie(req) === SESSION_TOKEN;
  platform.get('/__caddy/access', (req, res) => {
    res.on('finish', () => {
      decisions.push({
        uri: String(req.headers['x-forwarded-uri'] || '').replace(/(token|frame|code)=[^&#]+/g, '$1=…'),
        dest: req.headers['sec-fetch-dest'] || '', site: req.headers['sec-fetch-site'] || '',
        cookie: /usernode_access=/.test(String(req.headers.cookie || '')),
        status: res.statusCode, location: String(res.getHeader('location') || '').replace(/(token|frame|code|state)=[^&#]+/g, '$1=…').slice(0, 160),
        setCookie: [].concat(res.getHeader('set-cookie') || []).map((c) => c.replace(/=[^;]*/, '=…')),
      });
    });
    edgeGate.handleAccess(pool, req, res).catch((err) => { res.status(500).send(err.message); });
  });
  platform.get('/__access/authorize', (req, res) => {
    req.user = signedIn(req) ? { id: MEMBER_ID } : undefined;
    edgeGate.handleAuthorize(pool, req, res).catch((err) => { res.status(500).send(err.message); });
  });
  platform.get('/api/iframe-token', (req, res) => {
    if (!signedIn(req) || req.query.app !== SLUG) return res.status(404).json({ error: 'Not found' });
    const token = platformJwt.signAppIdentityToken({ appId: APP_ID,
      user: { id: MEMBER_ID, username: 'synthetic-member', usernode_pubkey: null, locale: 'en' } });
    return res.set('cache-control', 'no-store').json({ token, permissions: [] });
  });
  platform.get('/js/app-view.js', (_req, res) => res.type('js').sendFile(path.join(ROOT, 'public/js/app-view.js')));
  platform.post('/observe', (req, res) => { observations.push({ at: Date.now(), ...req.body }); res.sendStatus(204); });
  platform.get('/results', (_req, res) => res.json({ observations, decisions }));
  platform.get('/', (req, res) => {
    if (!signedIn(req)) setSessionCookie(res, SESSION_TOKEN, new Date(Date.now() + 3600e3));
    res.set('cache-control', 'no-store').type('html').send(shellPage({
      app: at(hosts.app), probe: at(hosts.probe), scenario: req.query.scenario === 'tokenless' ? 'tokenless' : 'token',
    }));
  });
  const internal = http.createServer(platform);
  await new Promise((resolve) => internal.listen(0, '127.0.0.1', resolve));

  const upstream = startUpstream();
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  const gate = createGate({
    platformUrl: `http://127.0.0.1:${internal.address().port}`,
    resolveUpstream: () => ({ host: '127.0.0.1', port: upstream.server.address().port }),
    anonCacheMs: 0,
    log: { error() {}, warn() {} },
  });

  const hostOf = (req) => String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  dispatch = (req, res) => {
    const host = hostOf(req);
    if (host === hosts.platform) return platform(req, res);
    if (host === hosts.probe) return probeRoutes(req, res);
    req.headers['x-forwarded-proto'] = 'https';
    return gate.emit('request', req, res);
  };
  dispatchUpgrade = (req, socket, head) => {
    if (hostOf(req) === hosts.app) return gate.emit('upgrade', req, socket, head);
    return socket.destroy();
  };

  const shellUrl = (scenario) => `${at(hosts.platform)}/?scenario=${scenario}`;
  const reset = () => { decisions.length = 0; upstream.seen.length = 0; observations.length = 0; };

  if (opts.serve) {
    console.log(JSON.stringify({ layout: opts.layout, ca: tls.ca, shell: opts.scenarios.map(shellUrl), results: `${at(hosts.platform)}/results` }, null, 2));
    return;
  }

  const { launch } = require(require.resolve('puppeteer-core', { paths: [path.join(ROOT, 'capture')] }));
  const ours = new Set([hosts.platform, hosts.app, hosts.probe].map((h) => `${h}:443`));
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  proxy.on('connect', (req, client, head) => {
    client.on('error', () => client.destroy());
    if (!ours.has(String(req.url).toLowerCase())) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const tunnel = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) tunnel.write(head);
      tunnel.pipe(client); client.pipe(tunnel);
    });
    tunnel.on('error', () => client.destroy());
    client.on('close', () => tunnel.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const report = { layout: opts.layout, hosts, scenarios: {} };
  for (const scenario of opts.scenarios) {
    reset();
    const profile = fs.mkdtempSync(path.join(dir, 'profile-'));
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    // Settings › Privacy › Third-party cookies › Block third-party cookies.
    const exceptions = opts.noFrameCookies ? { cookies: { [`[*.]${hosts.apps},*`]: { setting: 2 } } } : {};
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
      profile: { cookie_controls_mode: 1, block_third_party_cookies: true, content_settings: { exceptions } },
    }));
    const browser = await launch({
      executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, acceptInsecureCerts: true, userDataDir: profile,
      args: ['--ignore-certificate-errors', '--no-first-run',
        `--proxy-server=http://127.0.0.1:${proxy.address().port}`],
    });
    try {
      const page = await browser.newPage();
      await page.goto(shellUrl(scenario));
      const deadline = Date.now() + 45000;
      let results = null;
      while (Date.now() < deadline) {
        results = await page.evaluate(() => window.__results).catch(() => null);
        if (results && results.probe && results.pages.page2 && results.pages.home) break;
        if (opts.noFrameCookies && results && results.probe && Date.now() > deadline - 33000) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const appFrame = page.frames().find((f) => f.url().includes(hosts.app));
      const frameUrl = appFrame ? appFrame.url() : null;
      const frameDocument = appFrame ? await appFrame.evaluate(() => {
        const blocked = document.getElementById('blocked');
        return { title: document.title, blockedShown: !!blocked && !blocked.hidden };
      }).catch((e) => ({ error: e.message })) : null;
      report.browser = await browser.version();
      report.scenarios[scenario] = {
        probe: results && results.probe,
        pages: results ? results.pages : {},
        frameUrl: frameUrl && frameUrl.replace(/(token|frame)=[^&#]+/g, '$1=…'),
        frameDocument,
        reachedApp: upstream.seen.map((s) => s.path + (s.token ? ' +token' : '')),
        gate: decisions.slice(0, 40),
      };
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify(report, null, 2));

  if (opts.expect === 'pass') {
    for (const [name, s] of Object.entries(report.scenarios)) {
      if (opts.layout === 'cross') {
        assert.ok(s.probe, `${name}: the probe frame reported`);
        assert.ok(!s.probe.cookies.includes('probe_unpartitioned'), `${name}: third-party cookies are blocked`);
      }
      for (const page of ['home', 'page2']) {
        const r = s.pages[page];
        assert.ok(r, `${name}: ${page} reported`);
        assert.deepEqual({ script: r.script, css: r.css, image: r.image, fetchCookieOnly: r.fetchCookieOnly, ws: r.ws },
          { script: true, css: true, image: true, fetchCookieOnly: '200', ws: 'hello' }, `${name}: ${page}`);
        assert.equal(r.fetchWithToken, '200', `${name}: ${page} token fetch`);
      }
    }
    console.log('framed private app: all checks passed');
  }
  if (opts.expect === 'blocked') {
    for (const [name, s] of Object.entries(report.scenarios)) {
      assert.ok(s.probe && !s.probe.cookies.length, `${name}: the browser keeps no cookie in the frame`);
      assert.equal(s.frameDocument && s.frameDocument.blockedShown, true, `${name}: the frame says the app cannot open here`);
      assert.ok(s.gate.length <= 6, `${name}: no redirect loop (${s.gate.length} gate answers)`);
      assert.deepEqual(s.reachedApp, [], `${name}: nothing reached the app`);
    }
    console.log('framed private app: a frame that keeps no cookie is told so, without a loop');
  }
  front.close(); internal.close(); upstream.server.close();
  if (!opts.dir) fs.rmSync(dir, { recursive: true, force: true });
}

main().then(() => {
  if (!process.argv.includes('--serve')) process.exit(process.exitCode || 0);
}, (error) => { console.error(error.stack || error.message); process.exit(1); });

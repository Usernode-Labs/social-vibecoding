// Project apps that open offline from the browser's own cache
// (src/services/offline-cache.js, docs/plans/project-apps-offline.md).
//
// The browser half was measured by hand (iOS app web view, Safari, Android
// Chrome; the doc has the tables). What runs here is everything Homeroom
// does to get there: the gate's rule over real sockets, the platform's
// access answer, the shared files' headers, the bridge block in a vm, and
// the shell's AppView methods against a stub document and storage.
//
// Run with: node --test tests/offline-apps-cache.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const offlineCache = require('../src/services/offline-cache');

function withEnv(t, value) {
  const prev = process.env.APP_OFFLINE_CACHE;
  if (value == null) delete process.env.APP_OFFLINE_CACHE; else process.env.APP_OFFLINE_CACHE = value;
  t.after(() => {
    if (prev == null) delete process.env.APP_OFFLINE_CACHE; else process.env.APP_OFFLINE_CACHE = prev;
  });
}

// ── The rule ─────────────────────────────────────────────────────────────

test('the switch is off unless it says on', () => {
  assert.equal(offlineCache.enabled({}), false);
  assert.equal(offlineCache.enabled({ APP_OFFLINE_CACHE: 'off' }), false);
  assert.equal(offlineCache.enabled({ APP_OFFLINE_CACHE: 'yes' }), false);
  assert.equal(offlineCache.enabled({ APP_OFFLINE_CACHE: ' ON ' }), true);
});

test('only a literal "offline": false opts an app out, and the platform is never one', () => {
  assert.equal(offlineCache.optedOut({ offline: false }), true);
  for (const m of [null, {}, { offline: true }, { offline: 'false' }, { offline: 0 }, []]) {
    assert.equal(offlineCache.optedOut(m), false, JSON.stringify(m));
  }
  const on = { APP_OFFLINE_CACHE: 'on' };
  assert.equal(offlineCache.forApp({ manifest_snapshot: {} }, on), true);
  assert.equal(offlineCache.forApp({ manifest_snapshot: { offline: false } }, on), false);
  assert.equal(offlineCache.forApp({ self_hosted: true, manifest_snapshot: {} }, on), false);
  // A view-private app's `/` needs its token, which never reaches the gate
  // from the address after `#`; framing it there nested the shell (#6226).
  assert.equal(offlineCache.forApp({ view_visibility: 'private', manifest_snapshot: {} }, on), false);
  assert.equal(offlineCache.forApp({ view_visibility: 'public', manifest_snapshot: {} }, on), true);
  assert.equal(offlineCache.forApp({ manifest_snapshot: {} }, {}), false, 'switch off');
  assert.equal(offlineCache.forApp(null, on), false);
});

const FRESH = offlineCache.APP_CACHE_CONTROL;
const RULE_TABLE = [
  // [what, input, expected]
  ['a page with express\'s default', { method: 'GET', url: '/', status: 200, cacheControl: 'public, max-age=0' }, FRESH],
  ['a file with no header', { method: 'GET', url: '/app.js', status: 200 }, FRESH],
  ['revalidate-always', { method: 'GET', url: '/a.css', status: 200, cacheControl: 'no-cache, must-revalidate' }, FRESH],
  ['HEAD', { method: 'HEAD', url: '/', status: 200 }, FRESH],
  ['the shell\'s address with a theme', { method: 'GET', url: '/?un-theme=dark', status: 200 }, FRESH],
  ['an app query that is not the token', { method: 'GET', url: '/list?tokens=3', status: 200 }, FRESH],
  ['data', { method: 'GET', url: '/api/chores', status: 200 }, null],
  ['the gate\'s own paths', { method: 'GET', url: '/__usernode_access?x=1', status: 200 }, null],
  ['the token in the query', { method: 'GET', url: '/?un-theme=dark&token=abc', status: 200 }, null],
  ['the token first', { method: 'GET', url: '/?token=abc', status: 200 }, null],
  ['a write', { method: 'POST', url: '/', status: 200 }, null],
  // A 304 answers the bridge's check of a kept copy: the browser takes its
  // Cache-Control onto that copy, so it keeps the copy's 30 days.
  ['a 304, with express\'s default', { method: 'GET', url: '/app.js', status: 304, cacheControl: 'public, max-age=0' }, FRESH],
  ['a 304 for data', { method: 'GET', url: '/api/chores', status: 304 }, null],
  ['a 304 at the token address', { method: 'GET', url: '/?token=abc', status: 304 }, null],
  ['not found', { method: 'GET', url: '/gone.js', status: 404 }, null],
  ['a redirect', { method: 'GET', url: '/', status: 302 }, null],
  ['a 401 page', { method: 'GET', url: '/', status: 401 }, null],
  ['sets a cookie', { method: 'GET', url: '/', status: 200, setCookie: ['a=1'] }, null],
  ['no-store', { method: 'GET', url: '/', status: 200, cacheControl: 'no-store' }, null],
  ['private', { method: 'GET', url: '/', status: 200, cacheControl: 'private, max-age=0' }, null],
  ['the app chose a lifetime', { method: 'GET', url: '/x.js', status: 200, cacheControl: 'public, max-age=600' }, null],
  ['immutable', { method: 'GET', url: '/x.js', status: 200, cacheControl: 'public, immutable' }, null],
];

test('the gate\'s rule: pages and files fresh, never data, a person\'s answer, or the token address', () => {
  for (const [what, input, want] of RULE_TABLE) {
    assert.equal(offlineCache.appCacheControl(input), want, what);
  }
});

test('the shared files are kept stale-while-revalidate only while the switch is on', () => {
  const on = { APP_OFFLINE_CACHE: 'on' };
  const swr = offlineCache.SHARED_CACHE_CONTROL;
  assert.match(swr, /max-age=0/);
  assert.match(swr, /stale-while-revalidate=\d+/);
  assert.equal(offlineCache.sharedFileCacheControl('/usernode-bridge/v1/bridge.js', 'X', on), swr);
  assert.equal(offlineCache.sharedFileCacheControl('/srv/public/usernode-native/v1/native.css', 'X', on), swr);
  assert.equal(offlineCache.sharedFileCacheControl('/usernode-tailwind/v1/tailwind.js', 'X', on), swr);
  assert.equal(offlineCache.sharedFileCacheControl('/js/app.js', 'X', on), 'X', 'the shell\'s own files keep theirs');
  assert.equal(offlineCache.sharedFileCacheControl('/usernode-bridge/v1/bridge.js', 'X', {}), 'X', 'switch off');
});

// ── The gate, over real sockets ──────────────────────────────────────────

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => {
  server.close(() => resolve());
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
});

function get(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'GET', headers: { host: 'a.apps.example', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the gate applies the rule only when the platform\'s answer asks for it', async (t) => {
  const { createGate } = require('../scripts/app-gate');
  const platform = http.createServer((req, res) => {
    const uri = req.headers['x-forwarded-uri'] || '/';
    const headers = { 'x-usernode-upstream': 'app-a' };
    if (!uri.startsWith('/plain')) headers['x-usernode-cache'] = 'app';
    res.writeHead(200, headers);
    res.end('ok');
  });
  const app = http.createServer((req, res) => {
    const headers = { 'content-type': 'text/plain', 'cache-control': 'public, max-age=0', expires: '0', etag: 'W/"4-1"' };
    if (req.url.startsWith('/mine')) headers['cache-control'] = 'no-store';
    if (req.url.startsWith('/cookie')) headers['set-cookie'] = ['x=1; Path=/'];
    // An app cannot hand the visitor a platform-only header.
    headers['x-usernode-cache'] = 'app';
    // The bridge's check: a conditional request for an unchanged file.
    if (req.headers['if-none-match'] === 'W/"4-1"') {
      delete headers['content-type'];
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end('page');
  });
  const platformPort = await listen(platform);
  const appPort = await listen(app);
  const gate = createGate({
    platformUrl: `http://127.0.0.1:${platformPort}`,
    resolveUpstream: () => ({ host: '127.0.0.1', port: appPort }),
    anonCacheMs: 0,
    log: { error() {}, warn() {} },
  });
  const gatePort = await listen(gate);
  t.after(async () => { await close(gate); await close(app); await close(platform); });

  const page = await get(gatePort, '/');
  assert.equal(page.headers['cache-control'], FRESH);
  assert.equal(page.headers.expires, undefined, 'an Expires from the app would contradict it');
  assert.equal(page.headers['x-usernode-cache'], undefined, 'the decision header never reaches the visitor');

  assert.equal((await get(gatePort, '/api/list')).headers['cache-control'], 'public, max-age=0', 'data');
  assert.equal((await get(gatePort, '/?token=abc')).headers['cache-control'], 'public, max-age=0', 'the refresh address');
  assert.equal((await get(gatePort, '/mine')).headers['cache-control'], 'no-store', 'the app\'s own no-store');
  assert.equal((await get(gatePort, '/cookie')).headers['cache-control'], 'public, max-age=0', 'a cookie-setting answer');
  assert.equal((await get(gatePort, '/plain')).headers['cache-control'], 'public, max-age=0', 'the platform did not ask');

  // The bridge's check of a kept copy reaches the app as a conditional
  // request, and its 304 keeps the copy's 30 days.
  const unchanged = await get(gatePort, '/app.js', { 'if-none-match': 'W/"4-1"' });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.headers.etag, 'W/"4-1"', 'the validator crosses the gate both ways');
  assert.equal(unchanged.headers['cache-control'], FRESH);
  assert.equal(unchanged.headers.expires, undefined);
  const unchangedData = await get(gatePort, '/api/list', { 'if-none-match': 'W/"4-1"' });
  assert.equal(unchangedData.statusCode, 304);
  assert.equal(unchangedData.headers['cache-control'], 'public, max-age=0', 'data keeps the app\'s own header');
});

// ── Each build's files at addresses of their own (25 Nov 2026) ──────────
//
// The bridge's file check could not heal Firefox, which keeps a page's own
// <link>/<script> loads apart from the bridge's fetches: the check compared
// its own current copies and the page drew the old CSS and JS forever. Now
// the gate puts the app's live build on the addresses of its pages' files,
// so no browser asks for a kept copy of an older build's file again.

const V = 'abcdef123456';
const REWRITE_TABLE = [
  // [what, html, expected]
  ['a stylesheet', '<link rel="stylesheet" href="/screens.css">', `<link rel="stylesheet" href="/screens.css?un-v=${V}">`],
  ['attributes in any order, bare rel', '<link href="/a.css" rel=stylesheet>', `<link href="/a.css?un-v=${V}" rel=stylesheet>`],
  ['upper-case tag and attributes', '<LINK REL="Stylesheet" HREF="/a.css">', `<LINK REL="Stylesheet" HREF="/a.css?un-v=${V}">`],
  ['a query and a fragment kept', '<link rel="stylesheet" href="/a.css?x=1#f">', `<link rel="stylesheet" href="/a.css?x=1&un-v=${V}#f">`],
  ['single quotes', "<script src='/app.js'></script>", `<script src='/app.js?un-v=${V}'></script>`],
  ['a bare relative script', '<script type=module src=app.js></script>', `<script type=module src="app.js?un-v=${V}"></script>`],
  // A bare value runs to whitespace or `>`, `=` included, as browsers read it.
  ['a bare address with = in its query', '<link rel=stylesheet href=/a.css?x=1#f>', `<link rel=stylesheet href="/a.css?x=1&un-v=${V}#f">`],
  ['a bare address right before >', '<script src=/app.js></script>', `<script src="/app.js?un-v=${V}"></script>`],
  ['preload and modulepreload', '<link rel="preload" as="script" href="/a.js"><link rel="modulepreload" href="./m.js">',
    `<link rel="preload" as="script" href="/a.js?un-v=${V}"><link rel="modulepreload" href="./m.js?un-v=${V}">`],
  ['an older version replaced', `<script src="/app.js?q=2&un-v=000000000000"></script>`, `<script src="/app.js?q=2&un-v=${V}"></script>`],
  ['an icon is not a file the page runs on', '<link rel="icon" href="/i.png">', '<link rel="icon" href="/i.png">'],
  ['another site', '<script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="//cdn.example/a.css">',
    '<script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="//cdn.example/a.css">'],
  ['data: and blob:', '<script src="data:text/javascript,1"></script><link rel="stylesheet" href="blob:x">',
    '<script src="data:text/javascript,1"></script><link rel="stylesheet" href="blob:x">'],
  ['the platform\'s shared files', '<script src="/usernode-bridge/v1/bridge.js"></script><link rel="stylesheet" href="/usernode-native/v1/native.css">',
    '<script src="/usernode-bridge/v1/bridge.js"></script><link rel="stylesheet" href="/usernode-native/v1/native.css">'],
  ['data and the gate\'s paths', '<script src="/api/config.js"></script><script src="/__usernode_x.js"></script>',
    '<script src="/api/config.js"></script><script src="/__usernode_x.js"></script>'],
  ['a data-src is not a src', '<script data-src="/x.js"></script>', '<script data-src="/x.js"></script>'],
  ['an inline script\'s text is not markup', '<script>var s = "<script src=/x.js>";</script>', '<script>var s = "<script src=/x.js>";</script>'],
  ['nor a style\'s or a comment\'s', '<style>/* <link rel=stylesheet href=/x.css> */</style><!-- <script src="/c.js"></script> -->',
    '<style>/* <link rel=stylesheet href=/x.css> */</style><!-- <script src="/c.js"></script> -->'],
];

test('the page rewrite: each same-site file the page loads gets the build, and nothing else changes', () => {
  for (const [what, html, want] of REWRITE_TABLE) {
    assert.equal(offlineCache.versionAssetUrls(html, V), want, what);
  }
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Café — list</title>
<link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/screens.css">
<script src="/usernode-bridge/v1/bridge.js"></script></head>
<body><div id="t" class="toggle">Table</div><script src="/app.js"></script></body></html>`;
  const once = offlineCache.versionAssetUrls(page, V);
  assert.equal(once.replace(new RegExp(`\\?un-v=${V}`, 'g'), ''), page, 'only the addresses change');
  assert.equal((once.match(/un-v=/g) || []).length, 3);
  assert.equal(offlineCache.versionAssetUrls(offlineCache.versionAssetUrls(page, '000000000000'), V), once, 'run again, it replaces its own');
  assert.equal(offlineCache.versionAssetUrls(page, ''), page, 'no version, no change');
  assert.equal(offlineCache.versionAssetUrls(page, '"><script>'), page, 'nothing but a short build is ever written');
  assert.equal(offlineCache.assetVersion('ABCDEF1234567890abcdef'), V);
  assert.equal(offlineCache.assetVersion('x y'), '');
});

test('a page request is a document or a frame, or a GET that asks for HTML', () => {
  const is = (method, headers) => offlineCache.isPageRequest({ method, headers });
  assert.equal(is('GET', { 'sec-fetch-dest': 'document' }), true);
  assert.equal(is('GET', { 'sec-fetch-dest': 'iframe' }), true);
  assert.equal(is('GET', { accept: 'text/html,application/xhtml+xml' }), true);
  assert.equal(is('GET', { 'sec-fetch-dest': 'style', accept: 'text/css,*/*' }), false);
  assert.equal(is('GET', { 'sec-fetch-dest': 'script', accept: '*/*' }), false);
  assert.equal(is('HEAD', { 'sec-fetch-dest': 'document' }), false);
  assert.equal(is('POST', { accept: 'text/html' }), false);
});

test('the gate versions an app page\'s file addresses by the build the platform names', async (t) => {
  const zlib = require('node:zlib');
  const { createGate } = require('../scripts/app-gate');
  const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="/screens.css"><script src="/usernode-bridge/v1/bridge.js"></script></head><body><script src="/app.js"></script></body></html>';
  const WANT = PAGE.replace('/screens.css', `/screens.css?un-v=${V}`).replace('/app.js', `/app.js?un-v=${V}`);
  const platform = http.createServer((req, res) => {
    const uri = req.headers['x-forwarded-uri'] || '/';
    const headers = { 'x-usernode-upstream': 'app-a', 'x-usernode-cache': 'app' };
    if (!uri.startsWith('/plain')) headers['x-usernode-asset-version'] = 'ABCDEF1234567890';
    res.writeHead(200, headers);
    res.end('ok');
  });
  const seen = [];
  const app = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } });
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0', etag: 'W/"page-1"', 'last-modified': 'Wed, 25 Nov 2026 10:00:00 GMT' };
    // An app cannot hand the visitor the platform's version header.
    headers['x-usernode-asset-version'] = 'evil';
    if (req.headers['if-none-match'] === 'W/"page-1"') { res.writeHead(304, headers); return res.end(); }
    if (req.url.startsWith('/screens.css')) {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=0' });
      return res.end('.t{color:red}');
    }
    let body = Buffer.from(PAGE);
    if (req.url.startsWith('/big')) body = Buffer.from(PAGE + ' '.repeat(2 * 1024 * 1024 + 10));
    if (req.url.startsWith('/gz')) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
    if (req.url.startsWith('/br')) { body = zlib.brotliCompressSync(body); headers['content-encoding'] = 'br'; }
    if (req.url.startsWith('/zz')) headers['content-encoding'] = 'compress';
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    return res.end(body);
  });
  const platformPort = await listen(platform);
  const appPort = await listen(app);
  const gate = createGate({
    platformUrl: `http://127.0.0.1:${platformPort}`,
    resolveUpstream: () => ({ host: '127.0.0.1', port: appPort }),
    anonCacheMs: 0,
    log: { error() {}, warn() {} },
  });
  const gatePort = await listen(gate);
  t.after(async () => { await close(gate); await close(app); await close(platform); });

  const fetchPage = (url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, path: url, method: 'GET',
      headers: { host: 'a.apps.example', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const doc = { 'sec-fetch-dest': 'iframe', 'if-none-match': 'W/"page-1"', 'if-modified-since': 'Wed, 25 Nov 2026 10:00:00 GMT',
    'accept-encoding': 'gzip, br', 'x-usernode-asset-version': 'forged' };

  const page = await fetchPage('/?token=abc', doc);
  assert.equal(page.res.statusCode, 200, 'asked for whole, never a 304 that brings back a kept page');
  assert.equal(page.body.toString(), WANT);
  assert.equal(page.res.headers['content-length'], String(Buffer.byteLength(WANT)));
  assert.equal(page.res.headers.etag, undefined, 'the app\'s validators named other bytes');
  assert.equal(page.res.headers['last-modified'], undefined);
  assert.equal(page.res.headers['x-usernode-asset-version'], undefined, 'never reaches the visitor');
  const asked = seen.at(-1).headers;
  assert.equal(asked['if-none-match'], undefined);
  assert.equal(asked['if-modified-since'], undefined);
  assert.equal(asked['accept-encoding'], 'identity');
  assert.equal(asked['x-usernode-asset-version'], undefined, 'never forwarded to the app');

  for (const enc of ['gz', 'br']) {
    const packed = await fetchPage(`/${enc}`, doc);
    assert.equal(packed.body.toString(), WANT, `${enc}: unpacked and rewritten`);
    assert.equal(packed.res.headers['content-encoding'], undefined, `${enc}: sent plain`);
  }
  const odd = await fetchPage('/zz', doc);
  assert.equal(odd.body.toString(), PAGE, 'an encoding it cannot unpack goes out as the app sent it');
  assert.equal(odd.res.headers['content-encoding'], 'compress');
  const big = await fetchPage('/big', doc);
  assert.equal(big.body.length, Buffer.byteLength(PAGE) + 2 * 1024 * 1024 + 10, 'too big: passed through whole');
  assert.ok(!big.body.toString().includes('un-v='));

  const css = await fetchPage('/screens.css?un-v=abcdef123456', { 'sec-fetch-dest': 'style', 'if-none-match': 'x' });
  assert.equal(css.body.toString(), '.t{color:red}', 'a file is never rewritten');
  assert.equal(seen.at(-1).headers['if-none-match'], 'x', 'and keeps its conditional request');
  assert.equal(css.res.headers['cache-control'], offlineCache.APP_CACHE_CONTROL, 'a versioned address keeps the 30 days');

  const plain = await fetchPage('/plain', doc);
  assert.equal(plain.res.statusCode, 304, 'no version from the platform: the page and its 304 as before');
  assert.equal(seen.at(-1).headers['if-none-match'], 'W/"page-1"');
});

// ── The platform's access answer ─────────────────────────────────────────

// Hosts under the apps domain parse with no database work (app-access.parseAppHost).
const DOMAIN = require('../src/services/caddy').USERNODE_APPS_DOMAIN;
const ACCESS_APPS = {
  offapp: { id: 301, runtime_name: 'sv-app-301-offapp', offline: true, main_sha: 'ABCDEF1234567890abcdef1234567890abcdef12' },
  optout: { id: 302, runtime_name: 'sv-app-302-optout', offline: false, main_sha: '1111111111111111111111111111111111111111' },
  // Two people's frames found its page did not open at the cacheable address
  // on its live build: the shell frames it the old way until it deploys again.
  refused: { id: 303, runtime_name: 'sv-app-303-refused', offline: true, refused: true, main_sha: '2222222222222222222222222222222222222222' },
  // Never deployed yet: no live build to version its files by.
  fresh: { id: 304, runtime_name: 'sv-app-304-fresh', offline: true, main_sha: null },
};
const accessPool = {
  queries: [],
  async query(sql, params = []) {
    this.queries.push(sql);
    if (/SELECT id, view_visibility, moderation_suspended_at,[\s\S]*?FROM apps WHERE slug/.test(sql)) {
      const app = ACCESS_APPS[params[0]];
      return { rows: app ? [{ id: app.id, view_visibility: 'public', moderation_suspended_at: null }] : [] };
    }
    if (/SELECT runtime_name FROM apps WHERE id/.test(sql)) {
      const app = Object.values(ACCESS_APPS).find((a) => a.id === params[0]);
      return { rows: [{ runtime_name: app ? app.runtime_name : null }] };
    }
    if (/SELECT staging_runtime_name FROM chat_sessions/.test(sql)) {
      return { rows: [{ staging_runtime_name: 'sv-preview-301-s42' }] };
    }
    if (/\(manifest_snapshot -> 'offline'\) = 'false'::jsonb AS off,[\s\S]*offline_cache_off_sha[\s\S]*AS refused,\s*main_sha, self_hosted\s+FROM apps WHERE id = \$1/.test(sql)) {
      const app = Object.values(ACCESS_APPS).find((a) => a.id === params[0]);
      return { rows: [{ off: app ? app.offline === false : null, refused: app ? app.refused === true : null,
        main_sha: app ? app.main_sha : null, self_hosted: false }] };
    }
    throw new Error(`offline-apps-cache stub: unexpected query: ${sql}`);
  },
};

async function accessServer(t) {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const poolPath = require.resolve('../src/db/pool');
  const prevPool = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => accessPool } };
  for (const m of ['../src/services/app-access', '../src/services/app-domains', '../src/services/edge-gate', '../src/routes/internal']) {
    delete require.cache[require.resolve(m)];
  }
  const { internalRoutes } = require('../src/routes/internal');
  const edgeGate = require('../src/services/edge-gate');
  const app = express();
  app.use(cookieParser());
  app.use(internalRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await close(server);
    if (prevPool) require.cache[poolPath] = prevPool; else delete require.cache[poolPath];
  });
  const ask = async (host, uri = '/') => {
    edgeGate._resetCachesForTest();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/__caddy/access`, {
      headers: { 'x-forwarded-host': host, 'x-forwarded-uri': uri, 'x-forwarded-method': 'GET', 'x-usernode-gate': 'kubernetes' },
      redirect: 'manual',
    });
    return res;
  };
  return { ask };
}

test('the access answer asks the gate to cache a production app, only with the switch on', async (t) => {
  const prevSignin = process.env.APP_HOST_SIGNIN;
  process.env.APP_HOST_SIGNIN = 'off';
  t.after(() => { if (prevSignin == null) delete process.env.APP_HOST_SIGNIN; else process.env.APP_HOST_SIGNIN = prevSignin; });
  const { ask } = await accessServer(t);

  withEnv(t, null);
  let res = await ask(`offapp.${DOMAIN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-usernode-cache'), null, 'switch off: nothing changes');
  assert.ok(!accessPool.queries.some((q) => /'offline'/.test(q)), 'and the opt-out is not even read');

  process.env.APP_OFFLINE_CACHE = 'on';
  res = await ask(`offapp.${DOMAIN}`);
  assert.equal(res.headers.get('x-usernode-cache'), 'app');
  assert.equal(res.headers.get('x-usernode-upstream'), 'sv-app-301-offapp');

  res = await ask(`optout.${DOMAIN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-usernode-cache'), null, '"offline": false');

  res = await ask(`offapp--s42.${DOMAIN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-usernode-cache'), null, 'a preview runs unmerged code');

  // Framed the old way on its live build, where the bridge's refresh never
  // runs: its files keep the app's own headers.
  res = await ask(`refused.${DOMAIN}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-usernode-cache'), null, 'the cacheable address is off on its live build');
});

// 25 Nov 2026: each build's files at addresses of their own. The answer
// names the app's live build for the gate to version its pages' file
// addresses by: every production app while the switch is on, the opted-out
// and the old-way ones included (a version is harmless where nothing is kept
// long, and heals a copy kept before), never a preview or an app not yet
// deployed.
test('the access answer names a production app\'s live build for its file addresses', async (t) => {
  const prevSignin = process.env.APP_HOST_SIGNIN;
  process.env.APP_HOST_SIGNIN = 'off';
  t.after(() => { if (prevSignin == null) delete process.env.APP_HOST_SIGNIN; else process.env.APP_HOST_SIGNIN = prevSignin; });
  const { ask } = await accessServer(t);
  const VERSION = offlineCache.VERSION_HEADER;

  withEnv(t, null);
  assert.equal((await ask(`offapp.${DOMAIN}`)).headers.get(VERSION), null, 'switch off: no version');

  process.env.APP_OFFLINE_CACHE = 'on';
  assert.equal((await ask(`offapp.${DOMAIN}`)).headers.get(VERSION), 'abcdef123456', 'its main_sha, short and lower-case');
  assert.equal((await ask(`optout.${DOMAIN}`)).headers.get(VERSION), '111111111111', 'an opted-out app too');
  assert.equal((await ask(`refused.${DOMAIN}`)).headers.get(VERSION), '222222222222', 'one framed the old way too');
  assert.equal((await ask(`fresh.${DOMAIN}`)).headers.get(VERSION), null, 'no live build yet');
  assert.equal((await ask(`offapp--s42.${DOMAIN}`)).headers.get(VERSION), null, 'a preview runs unmerged code');
});

// 25 Nov 2026: a private project showed its new page over its old
// screens.css after every change. The shell frames a view-private app with
// the token in its address (forApp is false for it), where the bridge's
// refresh never runs, yet the gate kept its files 30 days. The gate now
// asks forApp's question: the view-private half is read off the host's
// visibility, which a request the gate lets through for a private app
// already carries.
test('the gate never keeps a view-private app\'s files, nor one framed the old way on its build', () => {
  const gate = read('src/services/edge-gate.js');
  const decision = gate.slice(gate.indexOf('offlineCache.DECISION_HEADER, offlineCache.DECISION_APP') - 700,
    gate.indexOf('offlineCache.DECISION_HEADER, offlineCache.DECISION_APP'));
  assert.match(decision, /isProduction && offlineCache\.enabled\(\)/);
  assert.match(decision, /appAccess\.offlineCacheFacts\(pool, vis\.appId\)/);
  assert.match(decision, /cacheApp && !vis\.viewPrivate && !facts\.off/);
  const access = read('src/services/app-access.js');
  assert.match(access, /offline_cache_off_sha IS NOT NULL AND lower\(offline_cache_off_sha\) = lower\(main_sha\)\) AS refused/,
    'switched off on its live build, as offlineCache.refusedOnThisBuild reads it');
  assert.equal(offlineCache.forApp({ view_visibility: 'private', manifest_snapshot: {} }, { APP_OFFLINE_CACHE: 'on' }), false,
    'the shell\'s side of the same rule');
});

// ── The shared files ─────────────────────────────────────────────────────

test('the asset server and the platform\'s own copies follow the switch', (t) => {
  const staticCache = require('../src/services/static-cache');
  withEnv(t, null);
  assert.equal(staticCache.shellAssetCacheControl('/srv/public/usernode-bridge/v1/bridge.js'), 'no-cache, must-revalidate');
  process.env.APP_OFFLINE_CACHE = 'on';
  assert.equal(staticCache.shellAssetCacheControl('/srv/public/usernode-bridge/v1/bridge.js'), offlineCache.SHARED_CACHE_CONTROL);
  assert.equal(staticCache.shellAssetCacheControl('/srv/public/js/app.js'), 'no-cache, must-revalidate');

  const assets = read('scripts/serve-platform-assets.js');
  assert.match(assets, /require\('\.\.\/src\/services\/offline-cache'\)/);
  assert.match(assets, /offlineCache\.sharedFileCacheControl\(pathname, 'public, max-age=0, must-revalidate'\)/);
  const compressed = read('src/middleware/precompressed-assets.js');
  assert.match(compressed, /offlineCache\.sharedFileCacheControl\(asset, REVALIDATE, env\)/);
  const k8s = read('src/services/kubernetes.js');
  assert.match(k8s, /name: 'APP_OFFLINE_CACHE', value: require\('\.\/offline-cache'\)\.enabled\(\) \? 'on' : 'off'/,
    'the asset server is told, as it holds none of the platform\'s configuration');
});

test('the chart turns it on by default, with the gate it needs', () => {
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /\n {2}appOfflineCache: "on"\n/);
  assert.match(values, /\n {2}appGate: "on"\n/, 'app pages are cached by the gate');
  const platform = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(platform, /\{name: APP_OFFLINE_CACHE, value: \{\{ \.Values\.config\.appOfflineCache \| default "on" \| quote \}\}\}/);
  assert.match(platform, /\{name: APP_GATE, value: \{\{ \.Values\.config\.appGate \| default "on" \| quote \}\}\}/);
  // Outside the chart (a local or standalone run) both stay off unless set.
  assert.equal(offlineCache.enabled({}), false);
  assert.equal(require('../src/services/kubernetes').appGateMode({ kubernetes: {} }), 'off');
});

// ── The bridge ───────────────────────────────────────────────────────────

const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BLOCK = BRIDGE.slice(
  BRIDGE.indexOf('/* __USERNODE_OFFLINE_CACHE_BEGIN__ */'),
  BRIDGE.indexOf('/* __USERNODE_OFFLINE_CACHE_END__ */'),
);

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

// `resources`: what Resource Timing lists for this load ({ name,
// initiatorType }), or null for a browser without it. `served`: per file,
// the validator of the copy kept (`kept`, what `cache: "force-cache"` reads)
// and of the app's current one (`now`, what `cache: "no-cache"` answers);
// null for none, 'fail' for a request that fails. `checked`: the stored
// record of the last check. `script`: the address this bridge was loaded
// from (the apps' copy by default; null for none). `storageBroken`: storage
// refuses every write. The load event and its timer run on fireLoad().
function runBridge({
  href, standalone = false, files = null, pageOk = true, entries = [],
  resources = null, served = {}, online = true, checked = null, script, storageBroken = false,
}) {
  const url = new URL(href);
  const posted = [];
  const fetched = [];
  const replaced = [];
  const reloads = [];
  const listeners = {};
  const timers = [];
  const style = { visibility: '' };
  const parent = { postMessage(msg, origin) { posted.push({ msg, origin }); } };
  const location = {
    href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash,
    replace(to) { replaced.push(to); },
    reload() { reloads.push(location.href); },
  };
  const scriptSrc = script === undefined ? `${url.origin}/usernode-bridge/v1/bridge.js` : script;
  const history = {
    state: null,
    replaceState(_s, _t, to) {
      const next = new URL(to, url.origin);
      location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
      location.href = next.href;
    },
  };
  const stored = {};
  if (files) stored['usernode:offline-files'] = JSON.stringify(files);
  if (checked) stored['usernode:offline-checked'] = JSON.stringify(checked);
  const storage = memoryStorage(stored);
  if (storageBroken) storage.setItem = () => { throw new Error('QuotaExceededError'); };
  let observer = null;
  const win = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  win.parent = standalone ? win : parent;
  const context = {
    window: win, location, history, localStorage: storage, URL, URLSearchParams, JSON, Promise, String, Array,
    document: { documentElement: { style }, currentScript: scriptSrc === null ? null : { src: scriptSrc } },
    navigator: { onLine: online },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    PerformanceObserver: class {
      constructor(fn) { this.fn = fn; observer = this; }
      observe() { this.fn({ getEntries: () => entries.map((name) => ({ name })) }); }
    },
    fetch: (u, opts) => {
      fetched.push({ u, opts });
      if (u === url.href.split('#')[0]) return Promise.resolve({ ok: pageOk });
      const file = served[u];
      if (file) {
        const v = opts && opts.cache === 'no-cache' ? file.now : file.kept;
        if (v === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: true, headers: { get: (h) => (h === 'etag' ? v : null) } });
      }
      return Promise.resolve({ ok: true });
    },
  };
  if (resources) context.performance = { getEntriesByType: (type) => (type === 'resource' ? resources : []) };
  vm.runInNewContext(BLOCK, context);
  // The page's load event, then the timer it sets, then the checks' answers.
  const fireLoad = async () => {
    for (const fn of listeners.load || []) fn();
    for (const t of timers.splice(0)) t.fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { location, posted, fetched, replaced, reloads, style, storage, observer, listeners, timers, fireLoad };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
// Values built inside the vm have its realm's prototypes: compare as JSON.
const msgs = (b) => JSON.stringify(b.posted.map((p) => p.msg));

test('the block is delimited, first in the bridge, and both bridge copies carry it', () => {
  assert.ok(BLOCK.length > 500);
  assert.ok(BRIDGE.indexOf('/* __USERNODE_OFFLINE_CACHE_BEGIN__ */') < BRIDGE.indexOf('location.search'),
    'before anything in the bridge reads the address');
  assert.equal(read('public/usernode-bridge.js'), BRIDGE, 'the unversioned mirror matches');
});

test('it moves the token and theme into the query, remembers files, and says it opened fresh', async () => {
  const b = runBridge({
    href: 'https://chores.apps.example/?view=week#un-token=tok1&un-theme=dark',
    entries: [
      'https://chores.apps.example/app.js',
      'https://chores.apps.example/tailwind.css?v=2',
      'https://chores.apps.example/api/chores',
      'https://chores.apps.example/?token=tok1',
      'https://chores.apps.example/__usernode_access',
      'https://elsewhere.example/x.js',
    ],
  });
  const q = new URLSearchParams(b.location.search);
  assert.equal(q.get('token'), 'tok1');
  assert.equal(q.get('un-theme'), 'dark');
  assert.equal(q.get('view'), 'week', 'the app\'s own query is kept');
  assert.equal(b.location.hash, '', 'the platform\'s parameters leave the address');
  assert.deepEqual(JSON.parse(b.storage.getItem('usernode:offline-files')).sort(), [
    'https://chores.apps.example/app.js',
    'https://chores.apps.example/tailwind.css?v=2',
  ]);
  assert.equal(msgs(b), JSON.stringify([{ __usernode_offline_cache: 'open', fresh: true }]));
  await flush();
  assert.equal(b.fetched.length, 0);
  assert.equal(b.replaced.length, 0);
});

test('un-refresh fetches the page and the remembered files past the cache, then reloads without it', async () => {
  const files = ['https://chores.apps.example/app.js'];
  const b = runBridge({ href: 'https://chores.apps.example/#un-token=tok1&un-theme=light&un-refresh=1', files });
  assert.equal(msgs(b), JSON.stringify([{ __usernode_offline_cache: 'open', fresh: false }]),
    'alive, so the shell keeps the new address; not fresh, so it records nothing yet');
  assert.equal(b.style.visibility, 'hidden', 'the old copy is not shown while it runs');
  await flush(); await flush();
  assert.deepEqual(b.fetched.map((f) => f.u).sort(), ['https://chores.apps.example/', 'https://chores.apps.example/app.js']);
  assert.ok(b.fetched.every((f) => f.opts.cache === 'reload'), 'past the cache');
  assert.deepEqual(b.replaced, ['https://chores.apps.example/#un-token=tok1&un-theme=light'],
    'the same address without the flag: the reload is the next, fresh open');
});

test('a refresh that cannot fetch the page runs on the copy there is', async () => {
  const b = runBridge({ href: 'https://chores.apps.example/#un-theme=light&un-refresh=1', pageOk: false });
  await flush(); await flush();
  assert.equal(b.replaced.length, 0);
  assert.equal(b.style.visibility, '', 'shown again');
  assert.equal(msgs(b), JSON.stringify([{ __usernode_offline_cache: 'open', fresh: false }]),
    'never fresh: the shell asks again on the next open');
});

test('it does nothing outside the shell or at an ordinary address', () => {
  const standalone = runBridge({ href: 'https://chores.apps.example/#un-token=t', standalone: true });
  assert.equal(standalone.posted.length, 0);
  assert.equal(standalone.location.search, '');
  const ordinary = runBridge({ href: 'https://chores.apps.example/?token=t&un-theme=dark#/route' });
  assert.equal(ordinary.posted.length, 0);
  assert.equal(ordinary.location.hash, '#/route', 'an app\'s own # route is left alone');
});

// ── The check of the files a load ran on (25 Nov 2026) ───────────────────
//
// A device showed a project's new page over the screens.css it kept from
// before the change, for good: the refresh on a new build is the only thing
// that replaced a file, and it fetches only what it remembered. Online, once
// the app has loaded, the bridge now asks the app for each file this load
// used, with the kept copy's validator, and reloads once onto any that moved.

const SITE = 'https://chores.apps.example';
const PAGE = `${SITE}/?un-build=abc123`;
const RAN_ON = [
  { name: `${SITE}/app.js`, initiatorType: 'script' },
  { name: `${SITE}/screens.css`, initiatorType: 'link' },
  { name: `${SITE}/api/chores`, initiatorType: 'fetch' },
  { name: `${SITE}/chores.json`, initiatorType: 'xmlhttprequest' },
  { name: `${SITE}/usernode-bridge/v1/bridge.js`, initiatorType: 'script' },
  { name: `${SITE}/usernode-native/v1/native.css`, initiatorType: 'link' },
  { name: 'https://fonts.example/a.woff2', initiatorType: 'css' },
  { name: `${SITE}/logo.png`, initiatorType: 'img' },
];
const STALE_CSS = {
  [`${SITE}/app.js`]: { kept: 'W/"10-a"', now: 'W/"10-a"' },
  [`${SITE}/screens.css`]: { kept: 'W/"20-old"', now: 'W/"24-new"' },
  [`${SITE}/logo.png`]: { kept: 'W/"30-a"', now: 'W/"30-a"' },
};
const checks = (b) => b.fetched.filter((f) => f.opts && (f.opts.cache === 'force-cache' || f.opts.cache === 'no-cache'));
const checkedFiles = (b) => [...new Set(checks(b).map((f) => f.u))].sort();

test('online, after load, a file the app now serves differently brings one reload that checks nothing', async () => {
  const b = runBridge({ href: `${PAGE}#un-token=tok1&un-theme=light`, resources: RAN_ON, served: STALE_CSS });
  assert.equal(msgs(b), JSON.stringify([{ __usernode_offline_cache: 'open', fresh: true }]));
  await flush();
  assert.equal(checks(b).length, 0, 'nothing is asked for while the app is still loading');
  assert.equal((b.listeners.load || []).length, 1);
  await b.fireLoad();
  assert.ok(b.timers.length === 0, 'the timer ran');
  assert.deepEqual(checkedFiles(b), [`${SITE}/app.js`, `${SITE}/logo.png`, `${SITE}/screens.css`],
    'the app\'s own files: no data reads, no shared platform files, nothing from another site');
  for (const u of checkedFiles(b)) {
    const modes = checks(b).filter((f) => f.u === u).map((f) => f.opts.cache);
    assert.deepEqual(modes, ['force-cache', 'no-cache'], `${u}: the kept copy, then the app's, once each`);
  }
  assert.deepEqual(b.replaced, [`${PAGE}#un-token=tok1&un-theme=light&un-checked=1`],
    'one reload of the same address, marked so the reload checks nothing');
  assert.equal(b.style.visibility, 'hidden', 'the old styling is not shown while it reloads');
  const last = JSON.parse(b.storage.getItem('usernode:offline-checked'));
  assert.equal(last.page, PAGE);
  assert.equal(typeof last.at, 'number');
});

test('nothing changed, nothing reloads', async () => {
  const same = {
    [`${SITE}/app.js`]: { kept: 'W/"10-a"', now: 'W/"10-a"' },
    [`${SITE}/screens.css`]: { kept: 'W/"24-new"', now: 'W/"24-new"' },
  };
  const b = runBridge({ href: `${PAGE}#un-token=tok1`, resources: RAN_ON, served: same });
  await b.fireLoad();
  assert.ok(checks(b).length > 0);
  assert.equal(b.replaced.length, 0);
  assert.equal(b.style.visibility, '');
});

test('the reload it made, an open offline, and a second open within ten minutes check nothing', async () => {
  const again = runBridge({ href: `${PAGE}#un-token=tok1&un-checked=1`, resources: RAN_ON, served: STALE_CSS });
  await again.fireLoad();
  assert.equal((again.listeners.load || []).length, 0, 'the reload it made');
  assert.equal(checks(again).length, 0);
  assert.equal(again.replaced.length, 0);

  const offline = runBridge({ href: `${PAGE}#un-token=tok1`, resources: RAN_ON, served: STALE_CSS, online: false });
  await offline.fireLoad();
  assert.equal(checks(offline).length, 0, 'offline');

  const soon = runBridge({
    href: `${PAGE}#un-token=tok1`, resources: RAN_ON, served: STALE_CSS, checked: { page: PAGE, at: Date.now() - 60_000 },
  });
  await soon.fireLoad();
  assert.equal(checks(soon).length, 0, 'this address was checked a minute ago');

  const later = runBridge({
    href: `${PAGE}#un-token=tok1`, resources: RAN_ON, served: STALE_CSS, checked: { page: PAGE, at: Date.now() - 11 * 60_000 },
  });
  await later.fireLoad();
  assert.equal(later.replaced.length, 1, 'eleven minutes later it checks again');

  const newBuild = runBridge({
    href: `${PAGE}#un-token=tok1`, resources: RAN_ON, served: STALE_CSS,
    checked: { page: `${SITE}/?un-build=old999`, at: Date.now() - 60_000 },
  });
  await newBuild.fireLoad();
  assert.equal(newBuild.replaced.length, 1, 'a new build\'s page is its own address, checked at once');
});

test('a file with no validator, or a check that fails, counts as unchanged', async () => {
  const unknown = {
    [`${SITE}/app.js`]: { kept: null, now: 'W/"11-b"' },
    [`${SITE}/screens.css`]: { kept: 'W/"20-old"', now: 'fail' },
    [`${SITE}/logo.png`]: { kept: 'fail', now: 'W/"31-b"' },
  };
  const b = runBridge({ href: `${PAGE}#un-token=tok1`, resources: RAN_ON, served: unknown });
  await b.fireLoad();
  assert.equal(b.replaced.length, 0);
  assert.equal(b.style.visibility, '');
});

test('a refresh does not also check, and the open after it does', async () => {
  const refreshing = runBridge({
    href: `${PAGE}#un-token=tok1&un-refresh=1`, resources: RAN_ON, served: STALE_CSS, files: [`${SITE}/app.js`],
  });
  await flush(); await flush();
  assert.equal((refreshing.listeners.load || []).length, 0);
  assert.deepEqual(refreshing.replaced, [`${PAGE}#un-token=tok1`], 'the refresh reloads as before');
  // That reload is an ordinary open: it checks, and catches the file the
  // refresh never remembered.
  const after = runBridge({ href: refreshing.replaced[0], resources: RAN_ON, served: STALE_CSS, files: [`${SITE}/app.js`] });
  await after.fireLoad();
  assert.deepEqual(after.replaced, [`${PAGE}#un-token=tok1&un-checked=1`]);
});

test('without Resource Timing it checks the files it remembered', async () => {
  const b = runBridge({
    href: `${PAGE}#un-token=tok1`,
    files: [`${SITE}/screens.css`, `${SITE}/usernode-bridge/v1/bridge.js`, `${SITE}/app.js`],
    served: STALE_CSS,
  });
  await b.fireLoad();
  assert.deepEqual(checkedFiles(b), [`${SITE}/app.js`, `${SITE}/screens.css`]);
  assert.equal(b.replaced.length, 1);
});

// ── The same check anywhere else an app loads the bridge (25 Nov 2026) ───
//
// A private project is framed with the token in its address, where steps 1
// to 4 never run, and the gate kept its files 30 days anyway: its new page
// showed over its old screens.css after every change. The gate no longer
// keeps them, and a browser still holding such a copy heals on its next
// open: step 5 runs in a frame opened the old way and on the app's own
// domain too, reloading in place.

const OLD_WAY = `${SITE}/?token=tok1&__ua=1&un-theme=dark`;

test('a frame opened the old way checks the files it ran on and reloads once in place', async () => {
  const b = runBridge({ href: OLD_WAY, resources: RAN_ON, served: STALE_CSS });
  assert.equal(b.posted.length, 0, 'it says nothing to the shell: that is the cacheable address\'s');
  assert.equal(b.location.search, '?token=tok1&__ua=1&un-theme=dark', 'the address is left as it is');
  assert.equal(b.observer, null, 'nothing is remembered for a refresh');
  await b.fireLoad();
  assert.deepEqual(checkedFiles(b), [`${SITE}/app.js`, `${SITE}/logo.png`, `${SITE}/screens.css`]);
  assert.equal(b.reloads.length, 1, 'one reload, of the same address');
  assert.equal(b.replaced.length, 0);
  assert.equal(b.style.visibility, 'hidden');
  assert.equal(JSON.parse(b.storage.getItem('usernode:offline-checked')).page, `${SITE}/`,
    'recorded without the token, the retry marker or the theme');
});

test('the app on its own domain is checked the same way', async () => {
  const b = runBridge({ href: `${SITE}/list?view=week`, standalone: true, resources: RAN_ON, served: STALE_CSS });
  await b.fireLoad();
  assert.equal(b.reloads.length, 1);
  assert.equal(JSON.parse(b.storage.getItem('usernode:offline-checked')).page, `${SITE}/list?view=week`);
  const same = runBridge({
    href: `${SITE}/list?view=week`, standalone: true, resources: RAN_ON,
    served: { [`${SITE}/app.js`]: { kept: 'W/"10-a"', now: 'W/"10-a"' } },
  });
  await same.fireLoad();
  assert.ok(checks(same).length > 0);
  assert.equal(same.reloads.length, 0, 'nothing changed, nothing reloads');
});

test('the reload it made checks nothing, whatever new token it carries', async () => {
  const again = runBridge({
    href: `${SITE}/?token=tok2&un-theme=dark`, resources: RAN_ON, served: STALE_CSS,
    checked: { page: `${SITE}/`, at: Date.now() - 5_000 },
  });
  await again.fireLoad();
  assert.equal(checks(again).length, 0);
  assert.equal(again.reloads.length, 0);
});

test('outside the cacheable address, no storage means no check rather than a reload loop', async () => {
  const b = runBridge({ href: OLD_WAY, resources: RAN_ON, served: STALE_CSS, storageBroken: true });
  await b.fireLoad();
  assert.equal(checks(b).length, 0);
  assert.equal(b.reloads.length, 0);
});

test('Homeroom\'s own pages, which load the unversioned copy, are never checked', async () => {
  for (const href of [`${SITE}/`, OLD_WAY]) {
    const b = runBridge({ href, standalone: href === `${SITE}/`, resources: RAN_ON, served: STALE_CSS, script: `${SITE}/usernode-bridge.js` });
    await b.fireLoad();
    assert.equal((b.listeners.load || []).length, 0, href);
    assert.equal(checks(b).length, 0, href);
    assert.equal(b.reloads.length + b.replaced.length, 0, href);
  }
  const unknown = runBridge({ href: OLD_WAY, resources: RAN_ON, served: STALE_CSS, script: null });
  await unknown.fireLoad();
  assert.equal(checks(unknown).length, 0, 'a bridge that cannot tell where it was loaded from checks nothing');
});

// ── The shell ────────────────────────────────────────────────────────────

const AppView = require('../public/js/app-view.js');

function shell(t, { offline = false, builds = {}, stored = {}, frame = null } = {}) {
  const saved = {
    appData: AppView.appData, pendingInnerPath: AppView.pendingInnerPath, tokenForSlug: AppView.tokenForSlug,
    buildFor: AppView.buildFor, renderAppTab: AppView.renderAppTab, _offlineCacheWatch: AppView._offlineCacheWatch,
  };
  const prev = {
    window: global.window, document: global.document, localStorage: global.localStorage,
    Offline: global.Offline, resolveDevHost: global.resolveDevHost, location: global.location,
  };
  const storage = memoryStorage({ 'usernode:offline-cache': JSON.stringify(stored) });
  const Offline = { isOffline: () => offline };
  global.Offline = Offline;
  global.window = { Offline };
  global.localStorage = storage;
  global.resolveDevHost = (u) => u;
  global.location = { origin: 'https://platform.example' };
  global.document = {
    documentElement: { classList: { contains: () => false } },
    getElementById: (id) => (id === 'app-iframe' ? frame : null),
  };
  AppView.tokenForSlug = () => 'tok';
  AppView.buildFor = (slug) => builds[slug] || '';
  const renders = [];
  AppView.renderAppTab = () => { renders.push(AppView.appData && AppView.appData.slug); };
  AppView.pendingInnerPath = null;
  AppView._offlineCacheWatch = null;
  t.after(() => {
    Object.assign(AppView, saved);
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete global[k]; else global[k] = v; }
  });
  return { storage, renders, stored: () => JSON.parse(storage.getItem('usernode:offline-cache') || '{}') };
}

const CHORES = { slug: 'chores', url: 'https://chores.apps.example', offline_cache: true };

test('an offline app is framed at one address per build: token and theme after #', (t) => {
  shell(t, { builds: { chores: 'b1' }, stored: { chores: { at: Date.now(), build: 'b1', addressed: true } } });
  AppView.appData = CHORES;
  const src = new URL(AppView.buildAppIframeSrc());
  assert.equal(src.search, '?un-build=b1', 'only the build in the query: the browser keeps each build\'s page apart');
  const own = new URLSearchParams(src.hash.slice(1));
  assert.equal(own.get('un-token'), 'tok');
  assert.equal(own.get('un-theme'), 'light');
  assert.equal(own.get('un-refresh'), null, 'the copy this device keeps is of the live build');

  AppView.appData = { ...CHORES, offline_cache: false };
  const old = new URL(AppView.buildAppIframeSrc());
  assert.equal(old.searchParams.get('token'), 'tok', 'switch off for this app: today\'s address');
  assert.equal(old.hash, '');
});

test('a new build, or none kept yet, asks the bridge to refresh; offline never does', (t) => {
  const s = shell(t, { builds: { chores: 'b2' }, stored: { chores: { at: Date.now(), build: 'b1', addressed: true } } });
  AppView.appData = CHORES;
  const next = new URL(AppView.buildAppIframeSrc());
  assert.equal(next.searchParams.get('un-build'), 'b2', 'the new build is a new address, with no copy kept');
  assert.equal(new URLSearchParams(next.hash.slice(1)).get('un-refresh'), '1', 'and its files are fetched again');
  localStorage.removeItem('usernode:offline-cache');
  assert.equal(new URLSearchParams(new URL(AppView.buildAppIframeSrc()).hash.slice(1)).get('un-refresh'), '1');
  global.Offline.isOffline = () => true;
  assert.equal(new URLSearchParams(new URL(AppView.buildAppIframeSrc()).hash.slice(1)).get('un-refresh'), null);
  assert.ok(s);
});

test('a deep link that is an app\'s own # route keeps today\'s address', (t) => {
  shell(t, { builds: { chores: 'b1' } });
  AppView.appData = CHORES;
  AppView.pendingInnerPath = '/#/week/3';
  const src = new URL(AppView.buildAppIframeSrc());
  assert.equal(src.searchParams.get('token'), 'tok');
  assert.equal(src.hash, '#/week/3');
});

test('a copy kept at the bare address, before addresses named a build, is refreshed once', (t) => {
  // The bug this guards: a page kept fresh for 30 days at `/` survived every
  // merge after it, because the shell had recorded the live build against it.
  const s = shell(t, { builds: { chores: 'b2' }, stored: { chores: { at: Date.now(), build: 'b2' } } });
  AppView.appData = CHORES;
  const src = new URL(AppView.buildAppIframeSrc());
  assert.equal(src.searchParams.get('un-build'), 'b2');
  assert.equal(new URLSearchParams(src.hash.slice(1)).get('un-refresh'), '1');
  s.storage.setItem('usernode:offline-cache', JSON.stringify({ chores: { at: Date.now(), build: 'b2', addressed: true } }));
  assert.equal(new URLSearchParams(new URL(AppView.buildAppIframeSrc()).hash.slice(1)).get('un-refresh'), null,
    'once recorded at its own address, it is not refreshed again');
});

test('a long build id is shortened in the address, and an odd one is left out', (t) => {
  shell(t, { builds: { chores: '3eb26f6a0b1c2d3e4f5061728394a5b6c7d8e9f0', odd: 'a b' } });
  AppView.appData = CHORES;
  assert.equal(new URL(AppView.buildAppIframeSrc()).searchParams.get('un-build'), '3eb26f6a0b1c');
  AppView.appData = { ...CHORES, slug: 'odd' };
  assert.equal(new URL(AppView.buildAppIframeSrc()).searchParams.get('un-build'), null);
});

test('reloading the frame in place opens the live build, not the one it was opened on', (t) => {
  shell(t, { builds: { chores: 'b2' }, stored: { chores: { at: Date.now(), build: 'b1', addressed: true } } });
  const live = new URL(AppView._offlineCacheLiveSrc('https://chores.apps.example/?un-build=b1#un-token=tok&un-theme=light', 'chores'));
  assert.equal(live.searchParams.get('un-build'), 'b2');
  const own = new URLSearchParams(live.hash.slice(1));
  assert.equal(own.get('un-token'), 'tok');
  assert.equal(own.get('un-refresh'), '1');
  const plain = 'https://chores.apps.example/?token=tok&un-theme=light';
  assert.equal(AppView._offlineCacheLiveSrc(plain, 'chores'), plain, 'any other address is left alone');
  assert.match(read('public/js/app-view.js'), /const src = el && el\.src \? AppView\._offlineCacheLiveSrc\(el\.src, slug\) : '';/,
    'reloadAppFrame goes through it');
});

test('the shell records the build only from a fresh open of its own frame, online', (t) => {
  const frame = { contentWindow: {}, src: 'https://chores.apps.example/?un-build=b2#un-token=tok&un-theme=light' };
  const s = shell(t, { builds: { chores: 'b2' }, frame });
  AppView.appData = CHORES;
  AppView.handleOfflineCacheMessage({ data: { __usernode_offline_cache: 'open', fresh: false }, source: frame.contentWindow });
  assert.deepEqual(s.stored(), {}, 'still refreshing');
  AppView.handleOfflineCacheMessage({ data: { __usernode_offline_cache: 'open', fresh: true }, source: {} });
  assert.deepEqual(s.stored(), {}, 'another window');
  AppView.handleOfflineCacheMessage({ data: { __usernode_offline_cache: 'open', fresh: true }, source: frame.contentWindow });
  assert.equal(s.stored().chores.build, 'b2');
  assert.equal(s.stored().chores.addressed, true, 'kept at that build\'s own address');
  assert.equal(AppView.offlineCacheOpenable(CHORES), true, 'so it opens offline from now on');
});

test('a frame opened at another build\'s address is never recorded as the live build', (t) => {
  const frame = { contentWindow: {}, src: 'https://chores.apps.example/?un-build=b1#un-token=tok&un-theme=light' };
  const s = shell(t, { builds: { chores: 'b2' }, frame });
  AppView.appData = CHORES;
  AppView.handleOfflineCacheMessage({ data: { __usernode_offline_cache: 'open', fresh: true }, source: frame.contentWindow });
  assert.deepEqual(s.stored(), {}, 'b1\'s page, opened before b2 landed');
  frame.src = 'https://chores.apps.example/#un-token=tok&un-theme=light';
  AppView.handleOfflineCacheMessage({ data: { __usernode_offline_cache: 'open', fresh: true }, source: frame.contentWindow });
  assert.deepEqual(s.stored(), {}, 'nor a bare address, which names no build');
});

test('offline, only an app opened at its cacheable address on this device opens', (t) => {
  shell(t, { offline: true, stored: { chores: { at: Date.now(), build: 'b1' } } });
  assert.equal(AppView.offlineCacheOpenable(CHORES), true);
  assert.equal(AppView.offlineCacheOpenable({ ...CHORES, slug: 'other' }), false, 'never opened here');
  assert.equal(AppView.offlineCacheOpenable({ ...CHORES, offline_cache: false }), false);
  AppView.appData = CHORES;
  AppView.tokenForSlug = () => null; // nothing can be minted offline
  const bare = new URL(AppView.buildAppIframeSrc());
  assert.equal(bare.searchParams.get('un-build'), null, 'a copy kept before addresses named a build: the bare address');
  const own = new URLSearchParams(bare.hash.slice(1));
  assert.equal(own.get('un-token'), null);
  assert.equal(own.get('un-theme'), 'light', 'the same address as online, less the token');
  assert.equal(own.get('un-refresh'), null);
  localStorage.setItem('usernode:offline-cache', JSON.stringify({ chores: { at: Date.now(), build: 'b1', addressed: true } }));
  AppView.buildFor = () => 'b2'; // a newer build is live, but this device has no copy of it
  assert.equal(new URL(AppView.buildAppIframeSrc()).searchParams.get('un-build'), 'b1', 'offline: the build this device kept');
});

test('a page that never says it opened falls back: the old address online, the placeholder offline', async (t) => {
  const frame = { contentWindow: {} };
  const s = shell(t, { builds: { chores: 'b1' }, frame });
  AppView.appData = CHORES;
  const graceWas = AppView.OFFLINE_CACHE_GRACE_MS;
  AppView.OFFLINE_CACHE_GRACE_MS = 1;
  t.after(() => { AppView.OFFLINE_CACHE_GRACE_MS = graceWas; });

  AppView._watchOfflineCacheOpen('chores', 'https://chores.apps.example/#un-token=tok&un-theme=light');
  AppView._offlineCacheFrameLoaded(); // the frame's load handler
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.stored().chores.oldAddressUntil > Date.now(), 'a week of today\'s address on this device');
  assert.deepEqual(s.renders, ['chores'], 'and the frame is built again, the old way');
  assert.equal(AppView.offlineCacheFor(CHORES), false);
  const src = new URL(AppView.buildAppIframeSrc());
  assert.equal(src.searchParams.get('token'), 'tok');

  // A frame that does say it opened is left alone.
  localStorage.removeItem('usernode:offline-cache');
  AppView._watchOfflineCacheOpen('chores', 'https://chores.apps.example/#un-theme=light');
  AppView.handleOfflineCacheMessage({ data: { __usernode_offline_cache: 'open', fresh: true }, source: frame.contentWindow });
  AppView._offlineCacheFrameLoaded();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.renders, ['chores'], 'no second render');

  // Offline with no copy after all: forget it, so the next render is the placeholder.
  localStorage.setItem('usernode:offline-cache', JSON.stringify({ chores: { at: Date.now(), build: 'b1' } }));
  AppView._offlineCacheDidNotOpen('chores', true);
  assert.equal(AppView.offlineCacheOpenable(CHORES), false);
});

test('sign-out forgets it with the offline-ready map', (t) => {
  const s = shell(t, { stored: { chores: { at: Date.now(), build: 'b1' } } });
  AppView.clearOfflineReady();
  assert.equal(s.storage.getItem('usernode:offline-cache'), null);
});

test('sameFrameSrc ignores the theme, the refresh flag and an offline address\'s build, in both copies, and nothing else', async () => {
  const policy = await import(
    new URL('../frontend/src/features/app-frame/app-frame-policy.js', `file://${__filename}`).href
  );
  assert.equal(policy.FRAME_REFRESH_PARAM, AppView.REFRESH_PARAM, 'one parameter name');
  assert.equal(policy.FRAME_BUILD_PARAM, AppView.BUILD_PARAM, 'and one for the build');
  const table = [
    ['https://a.example/#un-token=t&un-theme=dark', 'https://a.example/#un-token=t&un-theme=light', true],
    ['https://a.example/#un-token=t&un-theme=dark&un-refresh=1', 'https://a.example/#un-token=t&un-theme=dark', true],
    ['https://a.example/#un-token=t&un-theme=dark', 'https://a.example/#un-token=u&un-theme=dark', false],
    ['https://a.example/?un-build=b1#un-token=t', 'https://a.example/?un-build=b2#un-token=t', true],
    ['https://a.example/?un-build=b1&view=x#un-token=t', 'https://a.example/?un-build=b1&view=y#un-token=t', false],
    ['https://a.example/?un-build=b1', 'https://a.example/?un-build=b2', false],
    ['https://a.example/#un-token=t', 'https://a.example/?token=t', false],
    ['https://a.example/x#/route', 'https://a.example/x#/other', false],
  ];
  for (const [a, b, want] of table) {
    assert.equal(policy.sameFrameSrc(a, b), want, `bundle: ${a} vs ${b}`);
    assert.equal(AppView.sameFrameSrc(a, b), want, `legacy: ${a} vs ${b}`);
  }
});

test('the shell wires it up: both mounts watch, both offline gates ask, the listener', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /AppView\._watchOfflineCacheOpen\(slug, src\);\n\s*frame\.setSrc\(src, \{/,
    'the eager launch, before its src goes out');
  assert.match(src, /AppView\._watchOfflineCacheOpen\(appData\.slug, iframeSrc\);\n\s*frame\.setSrc\(iframeSrc, \{/,
    'renderAppTab, before its src goes out');
  assert.match(src, /AppView\.scheduleSafeAreaBroadcast\(\);\n\s*AppView\._offlineCacheFrameLoaded\(\);\n\s*\}\);/,
    'renderAppTab\'s load handler tells it the document is up');
  assert.match(src, /if \(iframeId === 'app-iframe'\) AppView\._offlineCacheFrameLoaded\(\);/,
    'and so does the launch\'s');
  assert.match(src, /!AppView\.offlineReadyFor\(slug\)\s*&& !AppView\.offlineCacheOpenable\(rec\)\) return false;/, 'canEagerLaunch');
  assert.match(src, /!AppView\.offlineReadyFor\(appData\.slug\)\s*&& !AppView\.offlineCacheOpenable\(appData\)\) \{/, 'renderAppTab');
  assert.match(src, /try \{ AppView\.handleOfflineCacheMessage\(e\); \} catch \{\}/);
});

test('the apps rows say whether the shell may frame an app this way', () => {
  const routes = read('src/routes/apps.js');
  assert.match(routes, /offline_cache: offlineCache\.forApp\(a\),/, 'the list');
  assert.match(routes, /offline_cache: offlineCache\.forApp\(appRow\),/, 'one app');
});

test('the app conventions say what an app needs for it', () => {
  const doc = read('src/prompts/app-conventions.md');
  assert.ok(doc.includes('**1. The browser\'s own cache (most apps, no code needed).**'));
  assert.match(doc, /"offline": false/);
  assert.match(doc, /On iPhone at most\s+two apps can have one/);
});

// ── A page that never opens, learned per build (offline-cache-refusals.js) ─

const LIVE = '1'.repeat(40);

test('two people\'s reports on the live build switch the cacheable address off until the next deploy', () => {
  const on = { APP_OFFLINE_CACHE: 'on' };
  const app = { manifest_snapshot: {}, main_sha: LIVE };
  assert.equal(offlineCache.forApp({ ...app, offline_cache_off_sha: LIVE }, on), false, 'off on that build');
  assert.equal(offlineCache.forApp({ ...app, offline_cache_off_sha: '2'.repeat(40) }, on), true, 'a later deploy clears it');
  assert.equal(offlineCache.forApp({ ...app, offline_cache_off_sha: null }, on), true);
  assert.equal(offlineCache.forApp({ manifest_snapshot: {}, offline_cache_off_sha: LIVE }, on), true, 'no live build on the row: says nothing');
});

test('the online fallback reports the build it saw; offline, or with no full sha, it does not', async (t) => {
  const posted = [];
  const fetchWas = global.fetch;
  global.fetch = (url, init) => { posted.push({ url, body: JSON.parse(init.body), method: init.method }); return Promise.resolve({ ok: true }); };
  t.after(() => { if (fetchWas === undefined) delete global.fetch; else global.fetch = fetchWas; });

  shell(t, { builds: { chores: LIVE, short: 'b1' } });
  AppView._offlineCacheDidNotOpen('chores', false);
  assert.deepEqual(posted, [{ url: '/api/apps/chores/offline-cache/did-not-open', body: { build: LIVE }, method: 'POST' }]);

  AppView._offlineCacheDidNotOpen('chores', true);
  AppView._offlineCacheDidNotOpen('short', false);
  assert.equal(posted.length, 1, 'offline, and a build that is not a commit, are not reported');
});

test('the report has its route, behind the app detail\'s own visibility guard', () => {
  const routes = read('src/routes/apps.js');
  assert.match(routes, /router\.post\('\/api\/apps\/:slug\/offline-cache\/did-not-open', sameOriginBrowserOnly,/);
  assert.match(routes, /offlineCacheRefusals\.recordRefusal\(pool, \{ app: appRow, userId: req\.user\.id, build \}\)/);
  assert.ok(require('../src/services/app-access').nonSecretAppColumnList().includes('offline_cache_off_sha'),
    'the apps list carries the column forApp reads');
});

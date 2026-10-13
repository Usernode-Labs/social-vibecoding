// The standalone deployment's half of signing in at an app's own address
// (#3657): how Caddy hands the gate's identity to the app, and why it is
// shaped the way it is.
//
// The gate answers a signed-in request's 2xx with `X-Usernode-Identity`. The
// platform_gate snippet copies THAT header (copy_headers), and the main
// Caddyfile then sets x-usernode-token from it, only when present, and strips
// the carrier and the gate's cookies before the app sees the request.
//
// ROLLBACK SAFETY is the reason for the indirection. Caddy's copy_headers
// always deletes the client's copy of each header it names before copying
// the auth response's value in. The snippet is also written by
// scripts/rollback.sh, which can pair it with an OLDER platform that never
// sends the header: naming x-usernode-token (or Cookie) there would strip
// every app's own token (or cookies) on a rollback. A header nothing else
// uses is safe to delete; so the snippet names only that one.
//
// When CADDY_BIN points at a caddy binary, the config is also run for real
// against a fake gate and a fake app.
//
// Run with: node --test tests/app-host-gate-caddy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CADDYFILE = read('Caddyfile');
const SITE = CADDYFILE.slice(CADDYFILE.indexOf('*.{$USERNODE_DOMAIN} {'));

function gateSnippet(src) {
  const m = src.match(/\(platform_gate\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'a platform_gate snippet');
  return m[0];
}

const COPIES = [
  ['caddy/active/platform-upstream.caddy', read('caddy/active/platform-upstream.caddy')],
  ['scripts/platform-rollout.sh write_active()', read('scripts/platform-rollout.sh')],
  ['scripts/rollback.sh', read('scripts/rollback.sh')],
];

test('every copy of the gate snippet copies the identity carrier, and only it', () => {
  for (const [label, src] of COPIES) {
    const snippet = gateSnippet(src);
    const copies = snippet.match(/^\s*copy_headers .*$/gm) || [];
    assert.deepEqual(copies.map((l) => l.trim()), ['copy_headers X-Usernode-Identity'], label);
    assert.doesNotMatch(snippet, /copy_headers[^\n]*(X-Usernode-Token|Cookie)/i, `${label}: rollback-safe`);
  }
});

test('the app gets the identity as x-usernode-token, only when the gate sent one', () => {
  assert.match(SITE, /@edge_identity header X-Usernode-Identity \*/);
  assert.match(SITE,
    /handle @not_platform_assets \{[\s\S]*?import platform_gate[\s\S]*?request_header @edge_identity X-Usernode-Token \{http\.request\.header\.X-Usernode-Identity\}[\s\S]*?\n\t\}/);
});

test('the app never sees the carrier or the gate’s cookies', () => {
  const proxy = SITE.slice(SITE.indexOf('reverse_proxy {upstream}:3000 {'));
  assert.match(proxy, /header_up -X-Usernode-Identity/);
  const m = proxy.match(/header_up Cookie `([^`]+)` ""/);
  assert.ok(m, 'a cookie-stripping replacement');
  const re = new RegExp(m[1], 'g');
  const strip = (cookie) => cookie.replace(re, '');
  assert.equal(strip('a=1; __Host-usernode_access=x; b=2'), 'a=1; b=2');
  assert.equal(strip('__Host-usernode_access=x; __Host-usernode_anon=1'), '');
  assert.equal(strip('__usernode_access=x'), '');
  assert.equal(strip('keep=1; usernode_access=2'), 'keep=1; usernode_access=2');
});

// ── The real thing, when a caddy binary is at hand ─────────────────────

const CADDY_BIN = process.env.CADDY_BIN;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('run for real: identity in, spoofs and gate cookies out', { skip: !CADDY_BIN && 'set CADDY_BIN to run Caddy' }, async (t) => {
  const fakeGate = http.createServer((req, res) => {
    const h = { 'content-type': 'text/plain' };
    if (/__Host-usernode_access=good/.test(req.headers.cookie || '')) h['X-Usernode-Identity'] = 'IDENT';
    res.writeHead(200, h); res.end('ok');
  });
  const fakeApp = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      token: req.headers['x-usernode-token'] || null,
      identity: req.headers['x-usernode-identity'] || null,
      cookie: req.headers.cookie ?? null,
    }));
  });
  const gatePort = await listen(fakeGate);
  const appPort = await listen(fakeApp);
  t.after(() => { fakeGate.close(); fakeApp.close(); });

  // The repository's own snippet and site blocks, with the network names and
  // TLS swapped for local ones.
  const snippet = gateSnippet(COPIES[0][1]).replace('usernode-blue:3000', `127.0.0.1:${gatePort}`);
  const handle = SITE.match(/\thandle @not_platform_assets \{[\s\S]*?\n\t\}/)[0];
  const matchers = SITE.match(/\t@not_platform_assets[^\n]*\n[\s\S]*?@edge_identity[^\n]*\n/)[0];
  const proxyHeaders = SITE.match(/\t\theader_up -X-Usernode-Identity\n\t\theader_up Cookie [^\n]*\n/)[0];
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = `{\n\tauto_https off\n\tadmin off\n}\n${snippet}\n:${port} {\n${matchers}${handle}\n`
    + `\treverse_proxy 127.0.0.1:${appPort} {\n${proxyHeaders}\t}\n}\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-gate-'));
  fs.writeFileSync(path.join(dir, 'Caddyfile'), config);
  const caddy = spawn(CADDY_BIN, ['run', '--config', path.join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], { stdio: 'ignore' });
  t.after(() => caddy.kill());

  const get = (headers) => new Promise((resolve, reject) => {
    const attempt = (n) => http.get({ host: '127.0.0.1', port, path: '/x', headers: { host: 'app.example', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', (err) => (n > 0 ? setTimeout(() => attempt(n - 1), 100) : reject(err)));
    attempt(50);
  });

  assert.deepEqual(await get({ cookie: 'a=1; __Host-usernode_access=good; b=2' }),
    { token: 'IDENT', identity: null, cookie: 'a=1; b=2' });
  assert.deepEqual(await get({ 'x-usernode-token': 'OWN', cookie: 'z=9' }),
    { token: 'OWN', identity: null, cookie: 'z=9' }, 'the app’s own token is untouched');
  assert.deepEqual(await get({ 'x-usernode-identity': 'SPOOF' }),
    { token: null, identity: null, cookie: null }, 'a client cannot hand itself an identity');
});

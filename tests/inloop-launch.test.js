'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environmentForInLoop, readManifest } = require('../worker/usernode-run-inloop');

const baseEnv = {
  INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: '3100',
  INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop',
};

test('in-loop launch applies staging manifest fallbacks and never borrows worker secrets', () => {
  const env = environmentForInLoop({ secrets: [
    { key: 'PRIVATE_KEY', required: true, private: true, staging_default: 'staging-dummy' },
    { key: 'PUBLIC_NAME', required: true, default: 'display name' },
  ] }, { ...baseEnv, PRIVATE_KEY: 'worker-private-value', PUBLIC_NAME: 'worker-public-value',
    OPENROUTER_API_KEY: 'worker-model-key', WORKER_JWT: 'worker-push-grant' });
  assert.equal(env.USERNODE_ENV, 'staging');
  assert.equal(env.PORT, '3100');
  assert.equal(env.DATABASE_URL, baseEnv.INLOOP_DATABASE_URL);
  assert.equal(env.PRIVATE_KEY, 'staging-dummy');
  assert.equal(env.PUBLIC_NAME, 'display name');
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.WORKER_JWT, undefined);
});

test('in-loop launch names missing required fallback rather than inventing one', () => {
  assert.throws(() => environmentForInLoop({ secrets: [
    { key: 'MISSING_PRIVATE', required: true, private: true },
    { key: 'MISSING_PUBLIC', required: true },
  ] }, baseEnv), /MISSING_PRIVATE, MISSING_PUBLIC/);
  assert.throws(() => environmentForInLoop({ secrets: [] }, {}), /build turn/);
});

test('apps without a dapp.json can still use the local staging launch', () => {
  assert.deepEqual(readManifest(path.join(__dirname, '__missing_dapp__.json')), {});
  assert.equal(environmentForInLoop({}, baseEnv).DATABASE_URL, baseEnv.INLOOP_DATABASE_URL);
});

test('this app local launch receives only the required values already committed in dapp.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const env = environmentForInLoop(manifest, baseEnv);
  assert.equal(env.ADMIN_USERNAME, 'admin');
  assert.equal(env.ADMIN_PASSWORD, '__staging_admin_password__');
  assert.equal(env.SESSION_SECRET, '__staging_session_secret_not_for_prod__');
});

// ── Production parity: the build and the edge ──────────────────────────────
//
// The in-loop page has to be the page users get. Production images run the
// app's `npm run build` and the Ingress answers the three hosted-asset
// prefixes from the platform; a plain `node server.js` did neither, and an
// agent once "fixed" the resulting 401s by making an app answer
// `/tailwind.css` with 204 — which deleted its stylesheet in production.

const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const {
  shouldRunBuild, routesPlatformAssets, platformAssetOrigin, isPlatformAssetPath,
  createFrontProxy, untrackedFiles, excludeBuildOutputs,
} = require('../worker/usernode-run-inloop');

test('the launch runs the build production runs, unless deliberately skipped', () => {
  assert.equal(shouldRunBuild({ scripts: { build: 'tailwindcss -o public/tailwind.css' } }, {}), true);
  assert.equal(shouldRunBuild({ scripts: { start: 'node server.js' } }, {}), false);
  assert.equal(shouldRunBuild({}, {}), false);
  assert.equal(shouldRunBuild({ scripts: { build: '  ' } }, {}), false);
  assert.equal(shouldRunBuild({ scripts: { build: 'x' } }, { INLOOP_SKIP_BUILD: '1' }), false);
});

test('child apps get the platform\'s hosted assets; the platform\'s own checkout serves its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-assets-'));
  try {
    assert.equal(routesPlatformAssets(dir, {}), true);
    fs.mkdirSync(path.join(dir, 'public', 'usernode-bridge'), { recursive: true });
    assert.equal(routesPlatformAssets(dir, {}), false);
    assert.equal(routesPlatformAssets(dir, { INLOOP_PLATFORM_ASSETS: '1' }), true);
    assert.equal(routesPlatformAssets(path.join(dir, 'nope'), { INLOOP_PLATFORM_ASSETS: '0' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // This repository is the platform: it carries its own copies.
  assert.equal(routesPlatformAssets(path.join(__dirname, '..'), {}), false);
});

test('asset origin and paths are parsed conservatively', () => {
  assert.equal(platformAssetOrigin({ PLATFORM_URL: 'http://usernode:3000/api' }), 'http://usernode:3000');
  assert.equal(platformAssetOrigin({ PLATFORM_URL: 'file:///etc' }), null);
  assert.equal(platformAssetOrigin({}), null);
  assert.equal(isPlatformAssetPath('/usernode-bridge/v1/bridge.js'), true);
  assert.equal(isPlatformAssetPath('/usernode-native/v1/native.css'), true);
  assert.equal(isPlatformAssetPath('/usernode-tailwind/v1/tailwind.js'), true);
  assert.equal(isPlatformAssetPath('/tailwind.css'), false);
  assert.equal(isPlatformAssetPath('/usernode-bridgeX/a.js'), false);
  assert.equal(isPlatformAssetPath('/usernode-bridge/%2e%2e/secret'), false);
  assert.equal(isPlatformAssetPath('/usernode-bridge/%E0%A4%A'), false);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
// The proxy reaches the app and the platform through Node's default agent,
// which keeps sockets alive; drop them so each test's servers really stop.
function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}
function request(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the front proxy routes hosted assets to the platform and everything else to the app', async () => {
  const platformSeen = [];
  const platform = http.createServer((req, res) => {
    platformSeen.push({ method: req.method, url: req.url, cookie: req.headers.cookie || null });
    res.writeHead(200, { 'content-type': 'application/javascript', 'set-cookie': 'leak=1', etag: '"v1"' });
    res.end('/* usernode-bridge.js */');
  });
  const app = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/tailwind.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        return res.end('.flex{display:flex}');
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-app': '1' });
      res.end(`app ${req.method} ${req.url} host=${req.headers.host} body=${body}`);
    });
  });
  app.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
    // HTTP servers allow half-open sockets; a real WebSocket server ends its
    // side when the peer does, and so must this one or close() never returns.
    socket.on('end', () => socket.end());
  });
  const platformPort = await listen(platform);
  const appPort = await listen(app);
  const proxy = createFrontProxy({ appPort, assetOrigin: `http://127.0.0.1:${platformPort}`, routeAssets: true });
  const port = await listen(proxy);
  try {
    // Hosted asset: from the platform, without the page's cookie, and with
    // only cache/render headers coming back.
    const bridge = await request(port, { path: '/usernode-bridge/v1/bridge.js', headers: { cookie: 'session=secret' } });
    assert.equal(bridge.status, 200);
    assert.equal(bridge.body, '/* usernode-bridge.js */');
    assert.equal(bridge.headers.etag, '"v1"');
    assert.equal(bridge.headers['set-cookie'], undefined);
    assert.deepEqual(platformSeen, [{ method: 'GET', url: '/usernode-bridge/v1/bridge.js', cookie: null }]);

    // The app's own built stylesheet is the app's, as in production.
    const css = await request(port, { path: '/tailwind.css' });
    assert.equal(css.status, 200);
    assert.equal(css.body, '.flex{display:flex}');

    // Everything else, body and Host included, reaches the app.
    const post = await request(port, { method: 'POST', path: '/api/x?y=1', body: 'hello', headers: { 'content-type': 'text/plain' } });
    assert.equal(post.headers['x-app'], '1');
    assert.equal(post.body, `app POST /api/x?y=1 host=127.0.0.1:${port} body=hello`);

    // Only GET/HEAD of the prefixes go to the platform.
    const postAsset = await request(port, { method: 'POST', path: '/usernode-bridge/v1/bridge.js' });
    assert.match(postAsset.body, /^app POST \/usernode-bridge/);
    assert.equal(platformSeen.length, 1);

    // Upgrades are spliced through to the app.
    const echoed = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c;
        if (buf.includes('\r\n\r\n') && !buf.includes('echo:')) sock.write('ping');
        if (buf.includes('echo:ping')) { sock.destroy(); resolve(buf); }
      });
      sock.on('error', reject);
    });
    assert.match(echoed, /^HTTP\/1\.1 101/);
  } finally {
    await close(proxy);
    await close(app);
    await close(platform);
  }
});

test('the platform checkout, a missing platform address, and a stopped app all answer plainly', async () => {
  const app = http.createServer((req, res) => { res.end(`own copy ${req.url}`); });
  const appPort = await listen(app);
  const own = createFrontProxy({ appPort, assetOrigin: null, routeAssets: false });
  const ownPort = await listen(own);
  const noOrigin = createFrontProxy({ appPort, assetOrigin: null, routeAssets: true });
  const noOriginPort = await listen(noOrigin);
  try {
    assert.equal((await request(ownPort, { path: '/usernode-bridge/v1/bridge.js' })).body,
      'own copy /usernode-bridge/v1/bridge.js');
    const missing = await request(noOriginPort, { path: '/usernode-native/v1/native.css' });
    assert.equal(missing.status, 502);
    assert.match(missing.body, /PLATFORM_URL is not set/);
  } finally {
    await close(own);
    await close(noOrigin);
    await close(app);
  }
  // A port nothing listens on: reserve one, then let it go.
  const reserved = http.createServer();
  const deadPort = await listen(reserved);
  await close(reserved);
  const dead = createFrontProxy({ appPort: deadPort, assetOrigin: null, routeAssets: true });
  const port = await listen(dead);
  try {
    const down = await request(port, { path: '/' });
    assert.equal(down.status, 502);
    assert.match(down.body, /not listening yet/);
  } finally {
    await close(dead);
  }
});

test('files the build writes that the app does not ignore stay out of the turn\'s commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-build-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(dir, 'server.js'), '1');
    const before = untrackedFiles(dir);
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'tailwind.css'), '.a{}');
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'app[1].js'), 'x');
    assert.deepEqual(excludeBuildOutputs(dir, before), ['dist/app[1].js', 'public/tailwind.css']);
    git('add', '-A');
    assert.deepEqual(git('diff', '--cached', '--name-only').trim().split('\n').sort(), ['.gitignore', 'server.js']);
    // A second build that writes nothing new appends nothing.
    const size = fs.statSync(path.join(dir, '.git', 'info', 'exclude')).size;
    assert.deepEqual(excludeBuildOutputs(dir, untrackedFiles(dir)), []);
    assert.equal(fs.statSync(path.join(dir, '.git', 'info', 'exclude')).size, size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(untrackedFiles(os.tmpdir()), null, 'outside a checkout there is nothing to exclude');
});

test('end to end: the launcher builds, boots the app behind the front proxy, and stops with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-e2e-'));
  const launcher = path.join(__dirname, '..', 'worker', 'usernode-run-inloop');
  const reserved = http.createServer();
  const publicPort = await listen(reserved);
  await close(reserved);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'e2e', private: true,
    scripts: { build: 'node build.js' },
  }));
  fs.writeFileSync(path.join(dir, 'build.js'),
    "require('fs').mkdirSync('public',{recursive:true});require('fs').writeFileSync('public/tailwind.css','.flex{display:flex}');");
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http'); const fs = require('fs');",
    'http.createServer((req, res) => {',
    "  if (req.url === '/tailwind.css') return res.end(fs.readFileSync('public/tailwind.css'));",
    "  res.end('port=' + process.env.PORT + ' env=' + process.env.USERNODE_ENV);",
    '}).listen(Number(process.env.PORT));',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('\n'));
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [launcher, process.execPath, 'server.js'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(publicPort),
      INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop', PLATFORM_URL: '' },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    let css = null;
    for (let i = 0; i < 100 && !css; i += 1) {
      try { css = await request(publicPort, { path: '/tailwind.css' }); }
      catch { await new Promise((r) => setTimeout(r, 100)); }
      if (css && css.status === 502) { css = null; await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(css, `the launch came up (stderr: ${stderr})`);
    assert.equal(css.body, '.flex{display:flex}', 'the built stylesheet is served, as in production');
    const root = await request(publicPort, { path: '/' });
    const appPort = Number(/port=(\d+)/.exec(root.body)[1]);
    assert.notEqual(appPort, publicPort, 'the app listens behind the proxy');
    assert.match(root.body, /env=staging$/);
    assert.match(stderr, /running `npm run build`/);
    assert.match(stderr, new RegExp(`open http://127\\.0\\.0\\.1:${publicPort}`));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a front port still held by an earlier launch stops the launch before the app starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-busy-'));
  const launcher = path.join(__dirname, '..', 'worker', 'usernode-run-inloop');
  const holder = http.createServer();
  const busyPort = await listen(holder);
  fs.writeFileSync(path.join(dir, 'server.js'), "require('fs').writeFileSync('started', '1');");
  try {
    const { spawnSync } = require('node:child_process');
    const out = spawnSync(process.execPath, [launcher, process.execPath, 'server.js'], {
      cwd: dir, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(busyPort),
        INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop' },
    });
    assert.equal(out.status, 2);
    assert.match(out.stderr, new RegExp(`cannot listen on ${busyPort}`));
    assert.equal(fs.existsSync(path.join(dir, 'started')), false, 'no unfronted app was left running');
  } finally {
    await close(holder);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

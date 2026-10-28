'use strict';

// test:changed: when worker/inloop-app-supervisor.js (real wrapper-exit, title-change and launcher-disconnect cleanup)

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
// Nothing of ours answers on this port any more. The number came from an
// ephemeral bind (freePort(), or the probe server above), so once our
// listener is gone another test file running in parallel may bind it; a
// connect that meets that socket opening or closing is reset, not refused.
// Any HTTP response still resolves request() and fails the assertion.
function refused(port) {
  return assert.rejects(request(port), /ECONNREFUSED|ECONNRESET|EPIPE/);
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
    "const http = require('http'); const fs = require('fs'); process.title = 'fixture app';",
    'http.createServer((req, res) => {',
    "  if (req.url === '/tailwind.css') return res.end(fs.readFileSync('public/tailwind.css'));",
    "  res.end('port=' + process.env.PORT + ' env=' + process.env.USERNODE_ENV);",
    "}).listen(Number(process.env.PORT), '127.0.0.1');",
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
    await require('../worker/usernode-run-inloop').stopLaunch(publicPort);
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

// App bench run 190: five of six builds relaunched after an edit, found the
// port still held by their launch before, and wrote loops to kill it.
test('a launch on a port stops the launch it made there before, and --stop stops it on its own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-again-'));
  const launcher = path.join(__dirname, '..', 'worker', 'usernode-run-inloop');
  const reserved = http.createServer();
  const port = await listen(reserved);
  await close(reserved);
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    "http.createServer((req, res) => res.end('launch=' + process.env.LAUNCH)).listen(Number(process.env.PORT), '127.0.0.1');",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('\n'));
  const { spawn, spawnSync } = require('node:child_process');
  const env = { ...process.env, INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(port),
    INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop', PLATFORM_URL: '', INLOOP_SKIP_BUILD: '1' };
  const launch = (n) => {
    const child = spawn(process.execPath, [launcher, process.execPath, 'server.js'], {
      cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, LAUNCH: String(n) },
    });
    child.stderrText = '';
    child.stderr.on('data', (c) => { child.stderrText += c; });
    child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return child;
  };
  const answer = async (n) => {
    for (let i = 0; i < 100; i += 1) {
      try {
        const res = await request(port, { path: '/' });
        if (res.body === `launch=${n}`) return res.body;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const first = launch(1);
  let second = null;
  try {
    assert.equal(await answer(1), 'launch=1', `the first launch came up (stderr: ${first.stderrText})`);
    second = launch(2);
    assert.equal(await answer(2), 'launch=2', `the second replaced it (stderr: ${second.stderrText})`);
    assert.equal(await first.exited, 0, 'the first launch stopped, its app with it');
    assert.match(second.stderrText, new RegExp(`stopped the app it launched earlier on ${port}`));
    const stop = spawnSync(process.execPath, [launcher, '--stop'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(stop.status, 0);
    assert.match(stop.stderr, new RegExp(`stopped the app it launched on ${port}`));
    assert.equal(await second.exited, 0);
    const again = spawnSync(process.execPath, [launcher, '--stop'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(again.status, 0);
    assert.match(again.stderr, new RegExp(`no app it launched is running on ${port}`));
  } finally {
    await require('../worker/usernode-run-inloop').stopLaunch(port);
    first.kill('SIGKILL');
    if (second) second.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the launch record only ever stops this command: a pid that is now something else is left alone', async () => {
  const { stopLaunch } = require('../worker/usernode-run-inloop');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-rec-'));
  fs.writeFileSync(path.join(dir, '4100.json'), JSON.stringify({ pid: 4242, childPid: 4243, childCommand: 'node server.js' }));
  const killed = [];
  const kill = (pid, sig) => { if (sig) killed.push([pid, sig]); };
  const stopped = await stopLaunch(4100, { dir, kill, waitMs: 0, commandLine: () => 'bash -c something else', selfPid: 1 });
  assert.equal(stopped, false);
  assert.deepEqual(killed, [], 'a reused pid is never signalled');
  assert.equal(fs.existsSync(path.join(dir, '4100.json')), false, 'the stale record goes');
  fs.rmSync(dir, { recursive: true, force: true });
});

// App bench run 191: the launch served every app signed out (a worker has no
// USERNODE_JWT_PUBLIC_KEY), and 11 of 17 builds read the platform's check
// script to mint a token of their own.
test('the launch signs an app in as Homeroom does: its own key, kept, and a link that verifies', () => {
  const jwt = require('jsonwebtoken');
  const {
    localIdentity, viewerToken, signedInLink, signsIn, VIEWER, LOCAL_APP_ID,
  } = require('../worker/usernode-run-inloop');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-id-'));
  try {
    const identity = localIdentity({ dir });
    assert.match(identity.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
    assert.deepEqual(localIdentity({ dir }), identity, 'made once, so earlier links keep working after a relaunch');
    assert.equal(fs.statSync(path.join(dir, 'identity.json')).mode & 0o777, 0o600, 'readable by this user alone');
    // The starter's own check (template.js server.js): RS256, issuer, audience, pur.
    const claims = jwt.verify(viewerToken(identity, '42'), identity.publicKeyPem,
      { algorithms: ['RS256'], issuer: 'usernode', audience: 'usernode:app:42' });
    assert.equal(claims.pur, 'iframe');
    assert.equal(claims.id, VIEWER.id);
    assert.equal(claims.username, 'staging-demo-viewer', 'the platform check script\'s viewer');
    assert.ok(claims.exp - claims.iat >= 4 * 60 * 60, 'lasts a build and its review');
    const link = new URL(signedInLink(identity, LOCAL_APP_ID, 3100, '/?demo=1#/feeds'));
    assert.equal(link.origin, 'http://localhost:3100');
    assert.equal(link.searchParams.get('demo'), '1');
    assert.equal(link.hash, '#/feeds', 'a hash route keeps its hash');
    assert.equal(jwt.verify(link.searchParams.get('token'), identity.publicKeyPem,
      { algorithms: ['RS256'], issuer: 'usernode', audience: 'usernode:app:1' }).pur, 'iframe');
    assert.throws(() => jwt.verify(viewerToken(identity, '42'), localIdentity({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-id-')) }).publicKeyPem,
      { algorithms: ['RS256'] }), /invalid signature/, 'nothing else trusts it');
    // Only an app's checkout, and only when the worker sets no key of its own.
    assert.equal(signsIn({}, true), true);
    assert.equal(signsIn({}, false), false, 'not the platform\'s own repository');
    assert.equal(signsIn({ USERNODE_JWT_PUBLIC_KEY: 'k' }, true), false);
    assert.equal(signsIn({ INLOOP_SIGN_IN: '0' }, true), false);
    // A directory it cannot make: no identity, and the launch goes on signed out.
    const notADir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(notADir, 'x');
    assert.equal(localIdentity({ dir: notADir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: the launched app gets the public half, the printed link opens it signed in, and --link prints one for any route', async () => {
  const jwt = require('jsonwebtoken');
  const { readLaunch } = require('../worker/usernode-run-inloop');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-signed-'));
  const launcher = path.join(__dirname, '..', 'worker', 'usernode-run-inloop');
  const reserved = http.createServer();
  const port = await listen(reserved);
  await close(reserved);
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "const http = require('http');",
    'http.createServer((req, res) => res.end(JSON.stringify({',
    '  key: process.env.USERNODE_JWT_PUBLIC_KEY || null, app: process.env.USERNODE_APP_ID || null,',
    "}))).listen(Number(process.env.PORT), '127.0.0.1');",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('\n'));
  const { spawn, spawnSync } = require('node:child_process');
  const env = { ...process.env, INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(port),
    INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop', PLATFORM_URL: '', INLOOP_SKIP_BUILD: '1' };
  delete env.USERNODE_JWT_PUBLIC_KEY;
  delete env.USERNODE_APP_ID;
  delete env.INLOOP_SIGN_IN;
  const child = spawn(process.execPath, [launcher, process.execPath, 'server.js'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    let seen = null;
    for (let i = 0; i < 100 && !seen; i += 1) {
      try {
        const res = await request(port, { path: '/' });
        if (res.status === 200) seen = JSON.parse(res.body);
      } catch { /* not up yet */ }
      if (!seen) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen, `the launch came up (stderr: ${stderr})`);
    assert.match(seen.key, /^-----BEGIN PUBLIC KEY-----/, 'the app gets a key to verify with, as on the platform');
    assert.equal(seen.app, '1');
    const printed = new RegExp(`signed in as staging-demo-viewer, as Homeroom signs a person in: open (http://localhost:${port}/\\?token=\\S+)`).exec(stderr);
    assert.ok(printed, stderr);
    assert.equal(jwt.verify(new URL(printed[1]).searchParams.get('token'), seen.key,
      { algorithms: ['RS256'], issuer: 'usernode', audience: 'usernode:app:1' }).pur, 'iframe');
    assert.deepEqual([readLaunch(port).signedIn, readLaunch(port).appId], [true, '1']);
    const link = spawnSync(process.execPath, [launcher, '--link', '/?demo=1'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(link.status, 0, link.stderr);
    const url = new URL(link.stdout.trim());
    assert.equal(url.searchParams.get('demo'), '1');
    assert.equal(jwt.verify(url.searchParams.get('token'), seen.key, { algorithms: ['RS256'], audience: 'usernode:app:1' }).username, 'staging-demo-viewer');
    const help = spawnSync(process.execPath, [launcher, '--help'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(help.status, 0, 'help is help, never an app command');
    assert.match(help.stderr, /--link \[route\]/);
    spawnSync(process.execPath, [launcher, '--stop'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(await exited, 0);
    const none = spawnSync(process.execPath, [launcher, '--link'], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no app it launched is running/);
  } finally {
    await require('../worker/usernode-run-inloop').stopLaunch(port);
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A shell/npm command can exit while its server continues in the inherited
// process group. Also exercise an ignored TERM and a failed spawn on each OS.
test('failed commands and wrapper exits leave no app listener behind', { timeout: 20000 }, async () => {
  const { spawn, spawnSync } = require('node:child_process');
  const { readProcess, processGroup, stopOwned } = require('../worker/process-ownership');
  const launcher = path.join(__dirname, '../worker/usernode-run-inloop');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-failures-'));
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const env = { ...process.env, INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(port),
    INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop', INLOOP_SKIP_BUILD: '1', PLATFORM_URL: '' };
  fs.writeFileSync(path.join(dir, 'grandchild.js'), `
    const fs = require('fs');
    const server = require('http').createServer((_q, r) => r.end('ok'));
    process.on('SIGTERM', () => {});
    server.listen(0, '127.0.0.1', () => fs.writeFileSync('grandchild.json', JSON.stringify({pid: process.pid, port: server.address().port})));
  `);
  fs.writeFileSync(path.join(dir, 'wrapper.js'), `
    require('child_process').spawn(process.execPath, ['grandchild.js'], { stdio: 'ignore' }).unref();
    const timer = setInterval(() => { if (require('fs').existsSync('grandchild.json')) { clearInterval(timer); process.exit(1); } }, 50);
  `);
  let child;
  let identity;
  try {
    const missing = spawnSync(process.execPath, [launcher, '/a-command-that-does-not-exist'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(missing.status, 2, missing.stderr);
    // The failed spawn closed the front socket as well as its launch record.
    await refused(port);
    child = spawn(process.execPath, [launcher, process.execPath, 'wrapper.js'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    identity = readProcess(child.pid);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 1, stderr);
    const grandchild = JSON.parse(fs.readFileSync(path.join(dir, 'grandchild.json'), 'utf8'));
    const state = readProcess(grandchild.pid)?.state;
    assert.ok(!state || /^[ZX]/.test(state), `grandchild ${grandchild.pid} is still alive: ${state}`);
    await refused(grandchild.port);
    await refused(port);
  } finally {
    if (identity) await stopOwned(processGroup(identity), { waitMs: 0 });
    if (child) child.kill('SIGKILL');
    // If an assertion fails, still clean only the exact fixture process.
    const file = path.join(dir, 'grandchild.json');
    if (fs.existsSync(file)) {
      const grandchild = JSON.parse(fs.readFileSync(file, 'utf8'));
      const p = readProcess(grandchild.pid);
      if (p?.cmd.includes('grandchild.js')) await stopOwned([p], { waitMs: 0 });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('the live supervisor cleans its app group if the launcher is killed', { timeout: 20000 }, async () => {
  const { spawn } = require('node:child_process');
  const { readProcess, stopOwned } = require('../worker/process-ownership');
  const launcher = path.join(__dirname, '../worker/usernode-run-inloop');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-inloop-disconnect-'));
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const env = { ...process.env, INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(port),
    INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop', INLOOP_SKIP_BUILD: '1', PLATFORM_URL: '' };
  fs.writeFileSync(path.join(dir, 'server.js'), `
    const fs = require('fs');
    const server = require('http').createServer((_q, r) => r.end('ok'));
    process.on('SIGTERM', () => {});
    server.listen(Number(process.env.PORT), '127.0.0.1', () => fs.writeFileSync('app.json', JSON.stringify({
      pid: process.pid, port: server.address().port, ipc: typeof process.send, ipcFd: process.env.NODE_CHANNEL_FD || null
    })));
  `);
  const child = spawn(process.execPath, [launcher, process.execPath, 'server.js'], { cwd: dir, env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let appIdentity;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'app.json')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const app = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    appIdentity = readProcess(app.pid);
    assert.equal(app.ipc, 'undefined', 'the app does not inherit the supervisor IPC channel');
    assert.equal(app.ipcFd, null);
    assert.equal((await request(port)).status, 200);
    child.kill('SIGKILL');
    await exited;
    for (let i = 0; i < 120; i += 1) {
      const state = readProcess(app.pid)?.state;
      if (!state || /^[ZX]/.test(state)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const state = readProcess(app.pid)?.state;
    assert.ok(!state || /^[ZX]/.test(state), `app ${app.pid} survived supervisor cleanup: ${state}`);
    await refused(app.port);
    await refused(port);
  } finally {
    await require('../worker/usernode-run-inloop').stopLaunch(port, { waitMs: 0 });
    if (appIdentity) await stopOwned([appIdentity], { waitMs: 0 });
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

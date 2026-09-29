'use strict';

// A child app's pages load /usernode-bridge|native|tailwind/ from their own
// origin, and the production edge routes those paths to the platform. The
// evidence proxy does the same for a child-app pair (and a hosted app), so the
// before/after shots are not taken of an unstyled page: the regression #3357
// fixed in the replay runner that before/after shots replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function startProxy(t, { origins, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-proxy-assets-'));
  const ready = path.join(dir, 'proxy.ready');
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'worker', 'evidence-origin-proxy.js')], {
    env: { PATH: process.env.PATH, EVIDENCE_ALLOWED_ORIGINS: JSON.stringify(origins),
      EVIDENCE_PROXY_PORT: '0', EVIDENCE_PROXY_READY: ready, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const diagnostics = [];
  proxy.stderr.on('data', (chunk) => diagnostics.push(chunk));
  t.after(async () => {
    proxy.kill('SIGTERM');
    await once(proxy, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true, 'the proxy started');
  return {
    port: Number(fs.readFileSync(ready, 'utf8')),
    kinds: () => Buffer.concat(diagnostics).toString().trim().split('\n')
      .filter((line) => line.startsWith('__USERNODE_EVIDENCE_BROWSER__ '))
      .map((line) => JSON.parse(line.slice('__USERNODE_EVIDENCE_BROWSER__ '.length))),
    raw: () => Buffer.concat(diagnostics).toString(),
  };
}

function send(port, url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', (error) => resolve({ error: error.code }));
    request.end();
  });
}

function connect(port, authority) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; if (data.includes('\r\n\r\n')) socket.destroy(); });
    socket.on('close', () => resolve(data.split('\r\n')[0] || ''));
    socket.on('error', () => {});
    setTimeout(() => socket.destroy(), 3000).unref();
  });
}

async function fixtures(t) {
  const app = { hits: [] };
  const platform = { hits: [] };
  const appServer = await listen((req, res) => {
    app.hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>SPA fallback</title>');
  });
  const platformServer = await listen((req, res) => {
    platform.hits.push({ line: `${req.method} ${req.url}`, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache',
      'set-cookie': 'platform=must-not-reach-the-app' }).end('window.usernodeBridge = true;');
  });
  t.after(() => { appServer.server.close(); platformServer.server.close(); });
  return { app, platform, appOrigin: appServer.origin, platformOrigin: platformServer.origin };
}

test('a child-app pair gets the platform\'s bridge, kit and Tailwind build instead of its SPA fallback', async (t) => {
  const { app, platform, appOrigin, platformOrigin } = await fixtures(t);
  const proxy = await startProxy(t, { origins: [appOrigin, 'http://head.invalid:3000'],
    env: { EVIDENCE_PLATFORM_ASSETS: '1', PLATFORM_URL: platformOrigin } });

  const bridge = await send(proxy.port, `${appOrigin}/usernode-bridge/v1/usernode-bridge.js?v=2`,
    { headers: { cookie: 'session=app-session', authorization: 'Bearer app-token', 'if-none-match': '"abc"' } });
  assert.equal(bridge.status, 200);
  assert.equal(bridge.body, 'window.usernodeBridge = true;');
  assert.equal(bridge.headers['content-type'], 'application/javascript');
  assert.equal(bridge.headers['set-cookie'], undefined, 'the platform sets nothing on the app\'s origin');
  assert.deepEqual(platform.hits.map((hit) => hit.line), ['GET /usernode-bridge/v1/usernode-bridge.js?v=2']);
  assert.equal(platform.hits[0].headers.cookie, undefined, 'the page\'s cookies never reach the platform');
  assert.equal(platform.hits[0].headers.authorization, undefined);
  assert.equal(platform.hits[0].headers['if-none-match'], '"abc"', 'revalidation still works');

  for (const pathname of ['/usernode-native/v1/native.css', '/usernode-tailwind/v1/tailwind.js']) {
    assert.equal((await send(proxy.port, `${appOrigin}${pathname}`)).status, 200);
  }
  assert.equal(platform.hits.length, 3);
  assert.deepEqual(app.hits, [], 'no asset request reached the app');

  // Everything else is the app's: its pages, writes, and anything that only
  // looks like an asset path.
  await send(proxy.port, `${appOrigin}/`);
  await send(proxy.port, `${appOrigin}/usernode-bridge/v1/usernode-bridge.js`, { method: 'POST' });
  await send(proxy.port, `${appOrigin}/usernode-bridge/%2e%2e/private`);
  await send(proxy.port, `${appOrigin}/usernode-bridgex/v1/x.js`);
  assert.equal(app.hits.length, 4);
  assert.equal(platform.hits.length, 3);
  assert.deepEqual(proxy.kinds().filter((event) => event.kind === 'platform_asset').map((event) => [event.side, event.httpStatus]),
    [['base', 200], ['base', 200], ['base', 200]]);
  assert.doesNotMatch(proxy.raw(), /app-session|app-token|usernode-bridge\.js/);
});

test('the platform\'s own pair keeps the assets its revision serves', async (t) => {
  const { app, platform, appOrigin, platformOrigin } = await fixtures(t);
  const proxy = await startProxy(t, { origins: [appOrigin, 'http://head.invalid:3000'],
    env: { EVIDENCE_PLATFORM_ASSETS: '0', PLATFORM_URL: platformOrigin } });
  const response = await send(proxy.port, `${appOrigin}/usernode-native/v1/native.css`);
  assert.equal(response.status, 200);
  assert.deepEqual(app.hits, ['GET /usernode-native/v1/native.css']);
  assert.deepEqual(platform.hits, []);
});

test('only a child-app pair may reach the legacy Tailwind CDN, and no other third-party host', async (t) => {
  const { appOrigin, platformOrigin } = await fixtures(t);
  const platformPair = await startProxy(t, { origins: [appOrigin, 'http://head.invalid:3000'],
    env: { EVIDENCE_PLATFORM_ASSETS: '0', PLATFORM_URL: platformOrigin } });
  assert.match(await connect(platformPair.port, 'cdn.tailwindcss.com:443'), /^HTTP\/1\.1 403/);

  const childPair = await startProxy(t, { origins: [appOrigin, 'http://head.invalid:3000'],
    env: { EVIDENCE_PLATFORM_ASSETS: '1', PLATFORM_URL: platformOrigin } });
  // Whether or not the network reaches the CDN from here, the proxy does not refuse it.
  assert.doesNotMatch(await connect(childPair.port, 'cdn.tailwindcss.com:443'), /403/);
  assert.ok(childPair.kinds().some((event) => event.kind === 'legacy_tailwind_cdn'));
  for (const authority of ['cdn.tailwindcss.com:80', 'evil.example:443', 'cdn.tailwindcss.com.evil.example:443']) {
    assert.match(await connect(childPair.port, authority), /^HTTP\/1\.1 403/, authority);
  }
});

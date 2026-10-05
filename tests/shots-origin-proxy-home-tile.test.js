'use strict';

// The app's tile on Homeroom's home screen is not on a pair's addresses, so
// the shots proxy answers /__shots/home-tile on each of them with that
// side's tile, fetched from the platform with the run's shots token
// (services/shots-home-tile.js). Pinned here: only that exact path on the
// pair's two addresses, only GET/HEAD, the token never reaching the page or
// the trace, and every other request still the app's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const RUN_ID = '7'.repeat(32);
const SHOTS_JWT = 'shots-run-token-must-stay-in-the-proxy';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function startProxy(t, { origins, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-proxy-tile-'));
  const ready = path.join(dir, 'proxy.ready');
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js')], {
    env: { PATH: process.env.PATH, SHOTS_ALLOWED_ORIGINS: JSON.stringify(origins),
      SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready, ...env },
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
    events: () => Buffer.concat(diagnostics).toString().trim().split('\n')
      .filter((line) => line.startsWith('__USERNODE_SHOTS_BROWSER__ '))
      .map((line) => JSON.parse(line.slice('__USERNODE_SHOTS_BROWSER__ '.length))),
    raw: () => Buffer.concat(diagnostics).toString(),
  };
}

// The proxy writes a diagnostic as it answers, so the response can arrive
// before the line does; wait for it rather than race it.
async function eventsOf(proxy, kind, count) {
  const deadline = Date.now() + 3000;
  let found = [];
  while (Date.now() < deadline) {
    found = proxy.events().filter((event) => event.kind === kind);
    if (found.length >= count) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return found;
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

async function fixtures(t) {
  const apps = { hits: [] };
  const platform = { hits: [] };
  const appHandler = (req, res) => {
    apps.hits.push(`${req.headers.host} ${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>The app</title>');
  };
  const base = await listen(appHandler);
  const head = await listen(appHandler);
  const platformServer = await listen((req, res) => {
    platform.hits.push({ line: `${req.method} ${req.url}`, headers: req.headers });
    const side = req.url.split('/').pop();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'", 'set-cookie': 'platform=must-not-reach-the-app',
    }).end(req.method === 'HEAD' ? undefined : `<!doctype html><title>Home screen tile</title><p>${side}</p>`);
  });
  t.after(() => { base.server.close(); head.server.close(); platformServer.server.close(); });
  return { apps, platform, base: base.origin, head: head.origin, platformOrigin: platformServer.origin };
}

for (const childApp of [true, false]) {
  test(`each side's address answers the home tile path with that side's tile (${childApp ? 'a hosted app' : 'Homeroom'})`, async (t) => {
    const { apps, platform, base, head, platformOrigin } = await fixtures(t);
    const proxy = await startProxy(t, { origins: [base, head], env: {
      SHOTS_PLATFORM_ASSETS: childApp ? '1' : '0', PLATFORM_URL: platformOrigin,
      SHOTS_RUN_ID: RUN_ID, SHOTS_JWT,
    } });

    const before = await send(proxy.port, `${base}/__shots/home-tile`, { headers: { cookie: 'session=page-session' } });
    assert.equal(before.status, 200);
    assert.equal(before.body, '<!doctype html><title>Home screen tile</title><p>base</p>');
    assert.equal(before.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(before.headers['content-security-policy'], "default-src 'none'");
    assert.equal(before.headers['set-cookie'], undefined, 'the platform sets nothing on the app\'s origin');
    const after = await send(proxy.port, `${head}/__shots/home-tile?theme=dark`);
    assert.equal(after.body, '<!doctype html><title>Home screen tile</title><p>head</p>');
    assert.equal((await send(proxy.port, `${head}/__shots/home-tile`, { method: 'HEAD' })).status, 200);

    assert.deepEqual(platform.hits.map((hit) => hit.line), [
      `GET /api/internal/shots/${RUN_ID}/home-tile/base`,
      `GET /api/internal/shots/${RUN_ID}/home-tile/head`,
      `HEAD /api/internal/shots/${RUN_ID}/home-tile/head`,
    ]);
    assert.equal(platform.hits[0].headers.authorization, `Bearer ${SHOTS_JWT}`);
    assert.equal(platform.hits[0].headers.cookie, undefined, 'the page\'s cookies never reach the platform');
    assert.deepEqual(apps.hits, [], 'the app never saw the tile path');

    // Only the exact path, only GET/HEAD: everything else is the app's.
    assert.equal((await send(proxy.port, `${base}/__shots/home-tile`, { method: 'POST' })).status, 405);
    await send(proxy.port, `${base}/__shots/home-tile/extra`);
    await send(proxy.port, `${base}/`);
    assert.equal(apps.hits.length, 2);
    assert.equal(platform.hits.length, 3);

    assert.deepEqual((await eventsOf(proxy, 'home_tile', 3))
      .map((event) => [event.side, event.httpStatus]), [['base', 200], ['head', 200], ['head', 200]]);
    assert.doesNotMatch(proxy.raw(), new RegExp(SHOTS_JWT));
    assert.doesNotMatch(before.body + after.body, new RegExp(SHOTS_JWT));
  });
}

test('without the run\'s token the home tile path answers 404 and asks the platform nothing', async (t) => {
  const { apps, platform, base, head, platformOrigin } = await fixtures(t);
  const proxy = await startProxy(t, { origins: [base, head],
    env: { SHOTS_PLATFORM_ASSETS: '1', PLATFORM_URL: platformOrigin, SHOTS_RUN_ID: RUN_ID } });
  assert.equal((await send(proxy.port, `${base}/__shots/home-tile`)).status, 404);
  assert.deepEqual(platform.hits, []);
  assert.deepEqual(apps.hits, []);
});

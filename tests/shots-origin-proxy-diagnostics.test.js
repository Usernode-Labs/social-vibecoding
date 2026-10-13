'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { closedPromise, waitForReady, stopProxy } = require('./lib/shots-proxy');

test('shots proxy reports document timing/status without leaking request content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-proxy-diag-'));
  const ready = path.join(dir, 'proxy.ready');
  const upstream = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>private page content</h1>');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = spawn(process.execPath,
    [path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js')], {
      env: { ...process.env,
        SHOTS_ALLOWED_ORIGINS: JSON.stringify([origin, 'http://head.invalid:3000']),
        SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const closed = closedPromise(proxy);
  const diagnostics = [];
  proxy.stderr.on('data', (chunk) => diagnostics.push(chunk));
  try {
    const proxyPort = await waitForReady(proxy, ready, { output: () => Buffer.concat(diagnostics).toString() });
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: proxyPort,
        path: `${origin}/?token=private-token`,
        headers: { host: `127.0.0.1:${upstream.address().port}`,
          'sec-fetch-dest': 'document' } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode,
          body: Buffer.concat(chunks).toString() }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response.status, 404);
    assert.match(response.body, /private page content/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = Buffer.concat(diagnostics).toString().trim().split('\n')
      .filter((line) => line.startsWith('__USERNODE_SHOTS_BROWSER__ '))
      .map((line) => JSON.parse(line.slice('__USERNODE_SHOTS_BROWSER__ '.length)));
    assert.deepEqual(lines.map((line) => line.kind), ['document_request', 'document_response']);
    assert.equal(lines[0].side, 'base');
    assert.equal(lines[1].httpStatus, 404);
    assert.equal(lines[1].outcome, 'http_error');
    assert.ok(lines[1].durationMs >= 0);
    assert.ok(lines[1].bodyBytes > 0);
    assert.doesNotMatch(Buffer.concat(diagnostics).toString(), /private-token|private page content/);
  } finally {
    await stopProxy(proxy, closed);
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots proxy blocks only the authorized exact API GET while enabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-proxy-failure-'));
  const ready = path.join(dir, 'proxy.ready');
  const token = 'a'.repeat(64);
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200).end('real upstream response');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = spawn(process.execPath,
    [path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js')], {
      env: { ...process.env, SHOTS_ALLOWED_ORIGINS: JSON.stringify([origin, 'http://head.invalid:3000']),
        SHOTS_PROXY_CONTROL_TOKEN: token, SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const closed = closedPromise(proxy);
  const diagnosticChunks = [];
  proxy.stderr.on('data', (chunk) => diagnosticChunks.push(chunk));
  const send = (port, pathValue, { method = 'GET', body = null, controlToken = '' } = {}) => new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathValue, method,
      headers: controlToken ? { 'x-shots-control-token': controlToken } : {} }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', (error) => resolve({ error: error.code }));
    request.end(body == null ? undefined : JSON.stringify(body));
  });
  try {
    const port = await waitForReady(proxy, ready, { output: () => Buffer.concat(diagnosticChunks).toString() });
    const controlPath = '/__usernode_shots_control/request-failure';
    const wanted = '/api/lists/demo?sort=new';
    assert.equal((await send(port, controlPath, { method: 'POST', body: { path: wanted, enabled: true } })).status, 403);
    assert.equal((await send(port, controlPath, { method: 'POST', body: { path: wanted, enabled: true }, controlToken: token })).status, 200);
    assert.equal((await send(port, `${origin}${wanted}`)).error, 'ECONNRESET');
    assert.equal((await send(port, `${origin}/api/lists/demo?sort=old`)).status, 200);
    assert.equal((await send(port, `${origin}${wanted}`, { method: 'POST' })).status, 200);
    assert.equal(upstreamHits, 2);
    assert.equal((await send(port, controlPath, { method: 'POST', body: { path: wanted, enabled: false }, controlToken: token })).status, 200);
    assert.equal((await send(port, `${origin}${wanted}`)).status, 200);
    assert.equal(upstreamHits, 3);
    assert.doesNotMatch(Buffer.concat(diagnosticChunks).toString(), /sort=new|real upstream response|a{64}/);
    assert.match(Buffer.concat(diagnosticChunks).toString(), /controlled_failure_hit/);
  } finally {
    await stopProxy(proxy, closed);
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// control_request (worker/shots-mcp.js): a loading state is shot while the
// request behind it waits, on both addresses alike.
test('shots proxy holds an exact API GET on both addresses until it is let go, failed, or waited on too long', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-proxy-hold-'));
  const ready = path.join(dir, 'proxy.ready');
  const token = 'b'.repeat(64);
  const hits = [];
  const side = (name) => http.createServer((req, res) => {
    hits.push(`${name} ${req.url}`);
    res.writeHead(200).end(`${name} answered`);
  });
  const base = side('base');
  const head = side('head');
  for (const server of [base, head]) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseOrigin = `http://127.0.0.1:${base.address().port}`;
  const headOrigin = `http://127.0.0.1:${head.address().port}`;
  const proxy = spawn(process.execPath,
    [path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js')], {
      env: { ...process.env, SHOTS_ALLOWED_ORIGINS: JSON.stringify([baseOrigin, headOrigin]),
        SHOTS_PROXY_CONTROL_TOKEN: token, SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready, SHOTS_HOLD_MAX_MS: '600' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const closed = closedPromise(proxy);
  const diagnosticChunks = [];
  proxy.stderr.on('data', (chunk) => diagnosticChunks.push(chunk));
  const send = (port, pathValue, { method = 'GET', body = null, controlToken = '' } = {}) => new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathValue, method,
      headers: controlToken ? { 'x-shots-control-token': controlToken } : {} }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', (error) => resolve({ error: error.code }));
    request.end(body == null ? undefined : JSON.stringify(body));
  });
  const settledYet = (promise) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 150))]);
  try {
    const port = await waitForReady(proxy, ready, { output: () => Buffer.concat(diagnosticChunks).toString() });
    const controlPath = '/__usernode_shots_control/request-failure';
    const control = (body) => send(port, controlPath, { method: 'POST', body, controlToken: token });
    const wanted = '/api/items?page=1';
    for (const body of [
      { path: wanted, mode: 'pause' },
      { path: '/api/items/*', mode: 'hold' },
      { path: `${headOrigin}${wanted}`, mode: 'hold' },
      { path: '/lists', mode: 'hold' },
      { path: wanted, mode: 'hold', enabled: true },
    ]) {
      assert.equal((await control(body)).status, 400, JSON.stringify(body));
    }

    const held = await control({ path: wanted, mode: 'hold' });
    assert.deepEqual([held.status, JSON.parse(held.body)], [200, { ok: true, enabled: true, mode: 'hold', hitCount: 0 }]);
    const beforeSide = send(port, `${baseOrigin}${wanted}`);
    const afterSide = send(port, `${headOrigin}${wanted}`);
    assert.equal(await settledYet(beforeSide), false, 'the before side waits');
    assert.equal(await settledYet(afterSide), false, 'the after side waits');
    // Only that exact GET: another query, another method, go on as normal.
    assert.equal((await send(port, `${headOrigin}/api/items?page=2`)).status, 200);
    assert.equal((await send(port, `${headOrigin}${wanted}`, { method: 'POST' })).status, 200);
    assert.deepEqual(hits, ['head /api/items?page=2', `head ${wanted}`]);
    // Let go: both go on to their own side.
    assert.equal(JSON.parse((await control({ path: wanted, mode: 'off' })).body).mode, 'off');
    assert.deepEqual(await beforeSide, { status: 200, body: 'base answered' });
    assert.deepEqual(await afterSide, { status: 200, body: 'head answered' });

    // Failed while held: what was held fails, and so does what comes next.
    await control({ path: wanted, mode: 'hold' });
    const failing = send(port, `${baseOrigin}${wanted}`);
    assert.equal(await settledYet(failing), false);
    await control({ path: wanted, mode: 'fail' });
    assert.deepEqual(await failing, { error: 'ECONNRESET' });
    assert.deepEqual(await send(port, `${headOrigin}${wanted}`), { error: 'ECONNRESET' });

    // Never longer than the limit: then it goes on by itself.
    await control({ path: wanted, mode: 'hold' });
    const started = Date.now();
    assert.deepEqual(await send(port, `${headOrigin}${wanted}`), { status: 200, body: 'head answered' });
    assert.ok(Date.now() - started >= 500, 'it waited for the limit');

    const diagnostics = Buffer.concat(diagnosticChunks).toString();
    assert.match(diagnostics, /"kind":"controlled_failure_hit","mode":"hold","side":"base"/);
    assert.match(diagnostics, /"kind":"controlled_failure_hit","mode":"hold","side":"head"/);
    assert.match(diagnostics, /"kind":"controlled_failure_set","enabled":false,"mode":"off"/);
    assert.doesNotMatch(diagnostics, /page=1|answered|b{64}/);
  } finally {
    await stopProxy(proxy, closed);
    base.close();
    head.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('evidence proxy reports document timing/status without leaking request content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-proxy-diag-'));
  const ready = path.join(dir, 'proxy.ready');
  const upstream = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>private page content</h1>');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = spawn(process.execPath,
    [path.join(__dirname, '..', 'worker', 'evidence-origin-proxy.js')], {
      env: { ...process.env,
        EVIDENCE_ALLOWED_ORIGINS: JSON.stringify([origin, 'http://head.invalid:3000']),
        EVIDENCE_PROXY_PORT: '0', EVIDENCE_PROXY_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const diagnostics = [];
  proxy.stderr.on('data', (chunk) => diagnostics.push(chunk));
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(ready), true);
    const proxyPort = Number(fs.readFileSync(ready, 'utf8'));
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
      .filter((line) => line.startsWith('__USERNODE_EVIDENCE_BROWSER__ '))
      .map((line) => JSON.parse(line.slice('__USERNODE_EVIDENCE_BROWSER__ '.length)));
    assert.deepEqual(lines.map((line) => line.kind), ['document_request', 'document_response']);
    assert.equal(lines[0].side, 'base');
    assert.equal(lines[1].httpStatus, 404);
    assert.equal(lines[1].outcome, 'http_error');
    assert.ok(lines[1].durationMs >= 0);
    assert.ok(lines[1].bodyBytes > 0);
    assert.doesNotMatch(Buffer.concat(diagnostics).toString(), /private-token|private page content/);
  } finally {
    proxy.kill('SIGTERM');
    await once(proxy, 'close');
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence proxy blocks only the authorized exact API GET while enabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-proxy-failure-'));
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
    [path.join(__dirname, '..', 'worker', 'evidence-origin-proxy.js')], {
      env: { ...process.env, EVIDENCE_ALLOWED_ORIGINS: JSON.stringify([origin, 'http://head.invalid:3000']),
        EVIDENCE_PROXY_CONTROL_TOKEN: token, EVIDENCE_PROXY_PORT: '0', EVIDENCE_PROXY_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const diagnosticChunks = [];
  proxy.stderr.on('data', (chunk) => diagnosticChunks.push(chunk));
  const send = (port, pathValue, { method = 'GET', body = null, controlToken = '' } = {}) => new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathValue, method,
      headers: controlToken ? { 'x-evidence-control-token': controlToken } : {} }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', (error) => resolve({ error: error.code }));
    request.end(body == null ? undefined : JSON.stringify(body));
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true);
    const port = Number(fs.readFileSync(ready, 'utf8'));
    const controlPath = '/__usernode_evidence_control/request-failure';
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
    proxy.kill('SIGTERM');
    await once(proxy, 'close');
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

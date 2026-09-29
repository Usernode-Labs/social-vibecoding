// Brotli / gzip for the shell's own text responses, and for nothing that
// streams or proxies (src/middleware/response-compression.js).
//
// The failure this guards against is not a missing byte saving — it is a
// stream the client is waiting on sitting inside a zlib buffer. So beside the
// "it compresses" cases, every surface that must pass through untouched is
// pinned: event streams (by request and by response type), non-GETs, the
// proxy prefixes, a small body, a 304, and a client that did not ask.
//
// Run with: node --test tests/response-compression.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');

const {
  responseCompression, wantsCompression, COMPRESSIBLE_TYPE,
} = require('../src/middleware/response-compression');

const BIG_JS = `window.x = ${JSON.stringify('a'.repeat(20000))};\n`;
const BIG_JSON = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row ${i}` })) };

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-'));
  fs.writeFileSync(path.join(dir, 'app.js'), BIG_JS);
  const app = express();
  app.use(responseCompression());
  app.get('/api/list', (_req, res) => res.json(BIG_JSON));
  app.post('/api/list', (_req, res) => res.json(BIG_JSON));
  app.get('/api/tiny', (_req, res) => res.json({ ok: true }));
  app.get('/api/internal/anthropic/v1/x', (_req, res) => res.json(BIG_JSON));
  app.get('/explorer-api/x', (_req, res) => res.json(BIG_JSON));
  app.get('/export.csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.end('a,b\n'.repeat(2000));
  });
  // An event stream: the first event must reach the client while the
  // response is still open.
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${'x'.repeat(4000)}\n\n`);
    req.on('close', () => res.end());
  });
  app.use(express.static(dir));
  return app;
}

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

// Raw request so the body arrives exactly as sent (fetch would decode it).
function get(server, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: pathname, method, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('static JavaScript is brotli-encoded for a client that accepts it', async () => {
  const server = await listen(makeApp());
  try {
    const res = await get(server, '/app.js', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    assert.match(res.headers.vary || '', /Accept-Encoding/i);
    assert.equal(zlib.brotliDecompressSync(res.body).toString(), BIG_JS);
    assert.ok(res.body.length < BIG_JS.length / 10);
  } finally { server.close(); }
});

test('JSON is gzip-encoded for a gzip-only client', async () => {
  const server = await listen(makeApp());
  try {
    const res = await get(server, '/api/list', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body)), BIG_JSON);
  } finally { server.close(); }
});

test('a client that does not ask gets the identity body', async () => {
  const server = await listen(makeApp());
  try {
    const res = await get(server, '/app.js');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.toString(), BIG_JS);
  } finally { server.close(); }
});

test('a revalidation still answers 304', async () => {
  const server = await listen(makeApp());
  try {
    const first = await get(server, '/app.js', { headers: { 'Accept-Encoding': 'br' } });
    const again = await get(server, '/app.js', {
      headers: { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag },
    });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
  } finally { server.close(); }
});

test('what must pass through untouched does', async () => {
  const server = await listen(makeApp());
  const br = { 'Accept-Encoding': 'gzip, br' };
  try {
    for (const [what, pathname, opts] of [
      ['a POST', '/api/list', { method: 'POST', headers: br }],
      ['a body under the threshold', '/api/tiny', { headers: br }],
      ['the worker model proxy', '/api/internal/anthropic/v1/x', { headers: br }],
      ['the explorer passthrough', '/explorer-api/x', { headers: br }],
      ['a CSV export', '/export.csv', { headers: br }],
    ]) {
      const res = await get(server, pathname, opts);
      assert.equal(res.headers['content-encoding'], undefined, `${what} must not be encoded`);
    }
  } finally { server.close(); }
});

test('an event stream is neither encoded nor held back', async () => {
  const server = await listen(makeApp());
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1', port: server.address().port, path: '/api/stream',
        // The response type decides it even when the request does not say.
        headers: { 'Accept-Encoding': 'gzip, br', Accept: '*/*' },
      }, (res) => {
        assert.equal(res.headers['content-encoding'], undefined);
        res.once('data', (chunk) => {
          assert.match(chunk.toString(), /^data: x+/);
          req.destroy();
          resolve();
        });
      });
      req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
      setTimeout(() => reject(new Error('the first event never arrived')), 2000).unref();
    });
  } finally { server.close(); }
});

test('the request pre-check', () => {
  const req = (method, p, accept) => ({ method, path: p, headers: accept ? { accept } : {} });
  assert.equal(wantsCompression(req('GET', '/js/app.js')), true);
  assert.equal(wantsCompression(req('HEAD', '/api/apps')), true);
  assert.equal(wantsCompression(req('POST', '/api/apps')), false);
  assert.equal(wantsCompression(req('GET', '/api/sessions/1/events', 'text/event-stream')), false);
  assert.equal(wantsCompression(req('GET', '/api/internal/anthropic/v1/messages')), false);
  assert.equal(wantsCompression(req('GET', '/api/app-llm/x')), false);
  assert.equal(wantsCompression(req('GET', '/mcp')), false);
  assert.equal(wantsCompression(req('GET', '/mcpx')), true, 'a prefix match is a path segment, not a string prefix');
  assert.equal(wantsCompression(req('GET', '/explorer-api/blocks')), false);
});

test('the response types it compresses', () => {
  for (const t of ['text/html; charset=UTF-8', 'text/css', 'application/javascript; charset=UTF-8',
    'text/javascript', 'application/json; charset=utf-8', 'image/svg+xml', 'application/manifest+json']) {
    assert.ok(COMPRESSIBLE_TYPE.test(t), t);
  }
  for (const t of ['text/event-stream', 'text/plain', 'text/csv', 'application/gzip',
    'application/octet-stream', 'image/png', 'application/x-ndjson', 'application/jsonl']) {
    assert.ok(!COMPRESSIBLE_TYPE.test(t), t);
  }
});

test('server.js mounts it ahead of every route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = src.indexOf('app.use(responseCompression());');
  assert.ok(mount > -1, 'mounted');
  for (const later of ['app.use(publicApiCors());', 'app.use(buildScopedAssetHandler(', 'app.use(express.static(']) {
    assert.ok(mount < src.indexOf(later), `before ${later}`);
  }
});

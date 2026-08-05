const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createExplorerProxy } = require('../src/services/explorer-proxy');

const quietLog = {
  debug() {},
  warn() {},
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

function request(port, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  const bodyBuffer = body == null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...headers,
        ...(bodyBuffer && headers['content-length'] == null
          ? { 'content-length': bodyBuffer.length }
          : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function withProxy(upstreamHandler, options, fn) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const middleware = createExplorerProxy({
    upstream: `127.0.0.1:${upstreamPort}`,
    upstreamBase: '/api',
    timeoutMs: 100,
    retryDelayMs: 1,
    log: quietLog,
    ...options,
  });
  const proxy = http.createServer(middleware);
  const proxyPort = await listen(proxy);
  try {
    await fn(proxyPort);
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

test('forwards GET query strings and POST JSON through the configured base', async () => {
  const seen = [];
  await withProxy((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(201, { 'content-type': 'application/vnd.explorer+json' });
      res.end('{"ok":true}');
    });
  }, {}, async (port) => {
    const get = await request(port, { path: '/active_chain?fresh=1' });
    const post = await request(port, {
      method: 'POST',
      path: '/testnet/transactions',
      body: '{"limit":50}',
      headers: { 'content-type': 'application/json' },
    });

    assert.equal(get.status, 201);
    assert.equal(post.status, 201);
    assert.equal(post.headers['content-type'], 'application/vnd.explorer+json');
    assert.equal(post.headers['access-control-allow-origin'], '*');
    assert.deepEqual(seen, [
      { method: 'GET', url: '/api/active_chain?fresh=1', body: '' },
      { method: 'POST', url: '/api/testnet/transactions', body: '{"limit":50}' },
    ]);
  });
});

test('rejects mutating methods without contacting the upstream', async () => {
  let calls = 0;
  await withProxy((_req, res) => {
    calls += 1;
    res.end('{}');
  }, {}, async (port) => {
    const response = await request(port, { method: 'DELETE', path: '/testnet/transactions/1' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, POST');
    assert.deepEqual(JSON.parse(response.body), { error: 'Explorer method not allowed' });
    assert.equal(calls, 0);
  });
});

test('bounds caller bodies and upstream responses', async () => {
  let calls = 0;
  await withProxy((_req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(65));
  }, { requestLimitBytes: 32, responseLimitBytes: 64 }, async (port) => {
    const requestTooLarge = await request(port, {
      method: 'POST',
      body: 'x'.repeat(33),
    });
    assert.equal(requestTooLarge.status, 413);
    assert.equal(calls, 0);

    const responseTooLarge = await request(port);
    assert.equal(responseTooLarge.status, 502);
    assert.deepEqual(JSON.parse(responseTooLarge.body), { error: 'Explorer response too large' });
    assert.equal(calls, 1, 'oversized responses are not retried');
  });
});

test('rejects a declared oversized upstream response before buffering it', async () => {
  let calls = 0;
  await withProxy((_req, res) => {
    calls += 1;
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '1000',
    });
    res.write('x');
  }, { responseLimitBytes: 64 }, async (port) => {
    const response = await request(port);
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), { error: 'Explorer response too large' });
    assert.equal(calls, 1);
  });
});

test('retries one timeout and then returns the successful response', async () => {
  let calls = 0;
  await withProxy((_req, res) => {
    calls += 1;
    if (calls === 1) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"confirmed"}');
  }, { timeoutMs: 30 }, async (port) => {
    const response = await request(port, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { status: 'confirmed' });
    assert.equal(calls, 2);
  });
});

test('returns a stable 504 after the second upstream timeout', async () => {
  let calls = 0;
  await withProxy(() => { calls += 1; }, { timeoutMs: 20 }, async (port) => {
    const response = await request(port);
    assert.equal(response.status, 504);
    assert.deepEqual(JSON.parse(response.body), { error: 'Explorer upstream timed out' });
    assert.equal(calls, 2);
  });
});

test('retries 502/503/504 once but does not retry other upstream statuses', async () => {
  let retryableCalls = 0;
  await withProxy((_req, res) => {
    retryableCalls += 1;
    if (retryableCalls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":"warming"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, {}, async (port) => {
    const response = await request(port);
    assert.equal(response.status, 200);
    assert.equal(retryableCalls, 2);
  });

  let ordinaryCalls = 0;
  await withProxy((_req, res) => {
    ordinaryCalls += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"ordinary failure"}');
  }, {}, async (port) => {
    const response = await request(port);
    assert.equal(response.status, 500);
    assert.equal(response.body, '{"error":"ordinary failure"}');
    assert.equal(ordinaryCalls, 1);
  });
});

test('terminal transport errors are stable and redact network details', async () => {
  const unused = http.createServer();
  const unusedPort = await listen(unused);
  await close(unused);

  const middleware = createExplorerProxy({
    upstream: `127.0.0.1:${unusedPort}`,
    upstreamBase: '/api',
    timeoutMs: 30,
    retryDelayMs: 1,
    log: quietLog,
  });
  const proxy = http.createServer(middleware);
  const proxyPort = await listen(proxy);
  try {
    const response = await request(proxyPort);
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), { error: 'Explorer temporarily unavailable' });
    assert.doesNotMatch(response.body, /ECONNREFUSED|127\.0\.0\.1|unusedPort/);
  } finally {
    await close(proxy);
  }
});

'use strict';

// Exercise the actual HTTP client and Node socket lookup boundary. The
// transport shim records the addresses chosen by that client, then routes
// them to an owned loopback fixture. No public/internal service is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const webFetch = require('../src/services/web-fetch');
const PUBLIC = '93.184.216.34';
const NEXT_PUBLIC = '8.8.8.8';
const PUBLIC_V6 = '2606:4700:4700::1111';
const HOST = 'public.web-fetch.test';
const NEXT_HOST = 'next.web-fetch.test';

async function fixture(t, handler, { pair, unreachable, onLookup, stallLookup } = {}) {
  const requests = [], lookups = [], ambient = [], handshakes = [], literalDials = [];
  const onRequest = (req, res) => {
    requests.push({ host: req.headers.host, url: req.url });
    res.setHeader('Content-Type', 'text/plain');
    if (handler) return handler(req, res);
    res.end('Public fixture document');
  };
  const server = pair ? https.createServer(pair, onRequest) : http.createServer(onRequest);
  server.on('tlsClientError', () => {});
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    webFetch._setLookup(null);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  const hostnames = new Set([HOST, NEXT_HOST]);
  const originalDns = dns.lookup;
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    if (!hostnames.has(host)) return originalDns(host, options, callback);
    ambient.push(host);
    // A second DNS resolution after validation is the attacker answer.
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  });
  if (pair) {
    const originalTls = tls.connect;
    t.mock.method(tls, 'connect', function (options, ...args) {
      if (hostnames.has(options.host)) {
        handshakes.push({ servername: options.servername, rejectUnauthorized: options.rejectUnauthorized });
        // Trust only the fixture CA. Hostname verification stays enabled.
        options = { ...options, ca: pair.cert };
      }
      return originalTls.call(this, options, ...args);
    });
  }
  const originalConnect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const literal = typeof options?.host === 'string' ? options.host.replace(/^\[/, '').replace(/\]$/, '') : '';
    if ([PUBLIC, PUBLIC_V6].includes(literal) && Number(options.port) === port) {
      literalDials.push(literal);
      options.host = '127.0.0.1';
      return originalConnect.apply(this, args);
    }
    if (!options || typeof options !== 'object' || !hostnames.has(options.host)) {
      return originalConnect.apply(this, args);
    }
    const lookup = options.lookup || dns.lookup;
    options.lookup = (host, opts, callback) => lookup(host, opts, (error, result, family) => {
      if (error) return callback(error);
      const records = Array.isArray(result) ? result : [{ address: result, family }];
      lookups.push({ host, addresses: records.map(record => ({ ...record })) });
      onLookup?.();
      if (stallLookup) return; // a connector still waiting when its deadline expires
      // The security decision is already made: observe it before translating
      // the selected address to our fixture. Keep the real HTTP/TLS stack.
      if (Array.isArray(result)) callback(null, records.map(record => ({ address: record.address === unreachable ? '127.0.0.2' : '127.0.0.1', family: 4 })));
      else callback(null, result === unreachable ? '127.0.0.2' : '127.0.0.1', 4);
    });
    return originalConnect.apply(this, args);
  });
  return { port, requests, lookups, ambient, handshakes, sockets, literalDials };
}

test('the socket uses only the validated addresses, never a second DNS answer', async (t) => {
  const f = await fixture(t);
  const validations = [];
  webFetch._setLookup(async host => {
    validations.push(host);
    return [{ address: PUBLIC, family: 4 }];
  });
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/document`);
  assert.equal(result.content, 'Public fixture document');
  assert.deepEqual(validations, [HOST]);
  assert.deepEqual(f.ambient, [], 'the client cannot resolve the hostname again');
  assert.deepEqual(f.lookups.flatMap(x => x.addresses), [{ address: PUBLIC, family: 4 }]);
  assert.deepEqual(f.requests, [{ host: `${HOST}:${f.port}`, url: '/document' }]);
});

test('a redirect gets a fresh pinned address set and preserves each Host header', async (t) => {
  let port;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: `http://${NEXT_HOST}:${port}/end` }); res.end(); }
    else res.end('Redirect arrived');
  });
  port = f.port;
  webFetch._setLookup(async host => [{ address: host === HOST ? PUBLIC : NEXT_PUBLIC, family: 4 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${port}/start`);
  assert.equal(result.content, 'Redirect arrived');
  assert.deepEqual(f.ambient, []);
  assert.deepEqual(f.lookups.map(x => [x.host, x.addresses[0].address]), [[HOST, PUBLIC], [NEXT_HOST, NEXT_PUBLIC]]);
  assert.deepEqual(f.requests.map(x => x.host), [`${HOST}:${port}`, `${NEXT_HOST}:${port}`]);
});

test('a same-origin redirect cannot reuse a connection outside its new validation', async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/end' }); res.end(); }
    else res.end('Fresh connection');
  });
  let validations = 0;
  webFetch._setLookup(async () => [{ address: ++validations === 1 ? PUBLIC : NEXT_PUBLIC, family: 4 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/start`);
  assert.equal(result.content, 'Fresh connection');
  assert.deepEqual(f.ambient, []);
  assert.deepEqual(f.lookups.flatMap(x => x.addresses.map(a => a.address)), [PUBLIC, NEXT_PUBLIC]);
});

test('a public-to-private redirect is refused before opening its socket', async (t) => {
  let port;
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: `http://${NEXT_HOST}:${port}/secret` }); res.end(); });
  port = f.port;
  webFetch._setLookup(async host => [{ address: host === HOST ? PUBLIC : '169.254.169.254', family: 4 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${port}/start`);
  assert.equal(result.content, null);
  assert.match(result.note, /private or internal/);
  assert.deepEqual(f.requests.map(x => x.url), ['/start']);
  assert.equal(f.lookups.some(x => x.host === NEXT_HOST), false);
});


// Generate fixture-only certificates at runtime so their keys are never
// shipped. OpenSSL is present on both security-CI OSes; other local setups
// may skip the TLS cases when that optional test utility is unavailable.
let certDirectory;
const pairs = new Map();
function certificate(t, hostname) {
  if (pairs.has(hostname)) return pairs.get(hostname);
  certDirectory ||= fs.mkdtempSync(path.join(os.tmpdir(), 'web-fetch-tls-'));
  const prefix = path.join(certDirectory, hostname);
  const config = `${prefix}.cnf`;
  fs.writeFileSync(config, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=${hostname}\n[ext]\nsubjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:TRUE\n`);
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-config', config, '-keyout', `${prefix}.key`, '-out', `${prefix}.pem`], { stdio: 'ignore' });
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('OpenSSL unavailable for TLS fixture'); return null; }
    throw error;
  }
  const pair = { key: fs.readFileSync(`${prefix}.key`), cert: fs.readFileSync(`${prefix}.pem`) };
  pairs.set(hostname, pair);
  return pair;
}
test.after(() => { if (certDirectory) fs.rmSync(certDirectory, { recursive: true, force: true }); });

test('HTTPS retains the original Host, SNI and trusted hostname verification', async (t) => {
  const pair = certificate(t, HOST);
  if (!pair) return;
  const f = await fixture(t, null, { pair });
  webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }]);
  const result = await webFetch.fetchUrl(`https://${HOST}:${f.port}/secure`);
  assert.equal(result.content, 'Public fixture document');
  assert.deepEqual(f.ambient, []);
  assert.equal(f.handshakes[0].servername, HOST);
  assert.notEqual(f.handshakes[0].rejectUnauthorized, false);
  assert.equal(f.requests[0].host, `${HOST}:${f.port}`);
});

test('HTTPS refuses a trusted certificate for a different hostname', async (t) => {
  const pair = certificate(t, NEXT_HOST);
  if (!pair) return;
  const f = await fixture(t, null, { pair });
  webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }]);
  const result = await webFetch.fetchUrl(`https://${HOST}:${f.port}/secret`);
  assert.equal(result.content, null);
  assert.match(result.note, /fetch failed/);
  assert.equal(f.requests.length, 0, 'TLS refuses before sending an HTTP request');
});

test('IPv6 public answers reach the socket as IPv6, with no ambient resolution', async (t) => {
  const f = await fixture(t);
  const address = '2606:4700:4700::1111';
  webFetch._setLookup(async () => [{ address, family: 6 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/ipv6`);
  assert.equal(result.content, 'Public fixture document');
  assert.deepEqual(f.ambient, []);
  assert.deepEqual(f.lookups[0].addresses, [{ address, family: 6 }]);
});

test('mixed public IPv4/private IPv6 answers are refused before any socket', async (t) => {
  const f = await fixture(t);
  webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/private`);
  assert.equal(result.content, null);
  assert.match(result.note, /private or internal/);
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.requests, []);
});

test('an unreachable approved address can fall back only to another approved address', async (t) => {
  const f = await fixture(t, null, { unreachable: PUBLIC });
  const addresses = [{ address: PUBLIC, family: 4 }, { address: NEXT_PUBLIC, family: 4 }];
  webFetch._setLookup(async () => addresses);
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/fallback`);
  assert.equal(result.content, 'Public fixture document');
  assert.deepEqual(f.ambient, []);
  assert.deepEqual(f.lookups[0].addresses, addresses);
});

test('a timed-out approved address cannot retry against the ambient private DNS answer', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let timer;
  t.after(() => clearTimeout(timer));
  const f = await fixture(t, null, {
    stallLookup: true,
    onLookup: () => { timer = setTimeout(() => controller.abort(new DOMException('Fixture deadline', 'TimeoutError')), 75); },
  });
  webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/unavailable`);
  assert.equal(result.content, null);
  assert.match(result.note, /timed out/);
  assert.equal(f.lookups.length, 1, 'the timer covers an actual connection attempt');
  assert.deepEqual(f.ambient, []);
  assert.deepEqual(f.requests, []);
});

async function assertClosed(sockets) {
  for (let i = 0; i < 50 && sockets.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.size, 0, 'the fetch destroys its connections without relying on process exit');
}
for (const kind of ['success', 'binary', 'oversized']) {
  test(`${kind}: completion releases its live socket`, async (t) => {
    const f = await fixture(t, (_req, res) => {
      if (kind === 'binary') res.setHeader('Content-Type', 'image/png');
      res.end(kind === 'oversized' ? 'x'.repeat(webFetch.MAX_DOWNLOAD_BYTES + 1) : 'Fixture body');
    });
    webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }]);
    const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/body`);
    if (kind === 'binary') assert.equal(result.content, null);
    else assert.equal(typeof result.content, 'string');
    if (kind === 'oversized') assert.equal(result.truncated, true);
    await assertClosed(f.sockets);
  });
}

test('the total deadline covers DNS and discards a late answer without connecting', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const answer = Promise.withResolvers();
  webFetch._setLookup(() => answer.promise);
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const timer = setTimeout(() => controller.abort(new DOMException('Fixture deadline', 'TimeoutError')), 25);
  t.after(() => clearTimeout(timer));
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/too-late`);
  assert.equal(result.content, null);
  assert.match(result.note, /timed out/);
  answer.resolve([{ address: PUBLIC, family: 4 }]);
  await new Promise(setImmediate);
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.requests, []);
});

test('a body timeout returns a refusal and destroys the in-flight connection', async (t) => {
  const controller = new AbortController();
  let timer;
  const f = await fixture(t, (_req, res) => {
    res.write('Partial fixture body');
    timer = setTimeout(() => controller.abort(new DOMException('Fixture deadline', 'TimeoutError')), 50);
  });
  webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }]);
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  t.after(() => clearTimeout(timer));
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/slow-body`);
  assert.equal(result.content, null);
  assert.match(result.note, /timed out/);
  assert.equal(f.requests.length, 1, 'the response body started before the deadline');
  await assertClosed(f.sockets);
});


test('timed-out requests leave no event-loop handles in a fresh process', async () => {
  await promisify(execFile)(process.execPath, [
    '--require', path.join(__dirname, 'lib/test-net.js'), '--test',
    '--test-name-pattern=^a timed-out approved address cannot retry', __filename,
  ], { timeout: 4000 });
});


test('public IPv4 and IPv6 literals remain usable without a resolver', async (t) => {
  const f = await fixture(t);
  webFetch._setLookup(() => { throw new Error('literal addresses must not resolve'); });
  for (const host of [PUBLIC, `[${PUBLIC_V6}]`]) {
    const result = await webFetch.fetchUrl(`http://${host}:${f.port}/literal`);
    assert.equal(result.content, 'Public fixture document');
    assert.equal(f.requests.at(-1).host, `${host}:${f.port}`);
  }
  assert.deepEqual(f.literalDials, [PUBLIC, PUBLIC_V6]);
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.ambient, []);
});

test('a real five-hop redirect chain completes and releases all its sockets', async (t) => {
  const f = await fixture(t, (req, res) => {
    const n = Number(req.url.slice(1));
    if (n < 5) { res.writeHead(302, { Location: `/${n + 1}` }); res.end(); }
    else res.end('Five hops complete');
  });
  webFetch._setLookup(async () => [{ address: PUBLIC, family: 4 }]);
  const result = await webFetch.fetchUrl(`http://${HOST}:${f.port}/0`);
  assert.equal(result.content, 'Five hops complete');
  assert.equal(f.requests.length, 6);
  assert.equal(f.lookups.length, 6);
  assert.deepEqual(f.ambient, []);
  await assertClosed(f.sockets);
});

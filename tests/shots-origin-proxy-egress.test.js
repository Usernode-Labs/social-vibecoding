'use strict';

// The shots browser may reach the public internet through the shots proxy,
// never the network the worker runs in (worker/shots-boundary.js). The proxy
// runs as it does in the worker, with a test-only preload
// (tests/lib/shots-proxy-fake-network.js) standing in for DNS and for the
// public hosts, so nothing here leaves the machine.
//
// Pinned here: a public name is reached at the address that was checked, not
// looked up again; a name with any internal answer, an internal address, a
// port other than 80 and 443 and a name that does not resolve are refused and
// counted by reason only; the pair stays reachable by name although it is
// internal; and a persona's identity never goes to an outside host.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { closedPromise, waitForReady, stopProxy } = require('./lib/shots-proxy');

const PUBLIC = '93.184.215.14';
const FAKE_DNS = {
  'cdn.example': [PUBLIC],
  'cdn.tailwindcss.com': [PUBLIC],
  'rebind.example': [PUBLIC, '10.0.0.5'],
  'internal.example': ['10.1.2.3'],
  'metadata.example': ['169.254.169.254'],
};

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
}

async function freePort() {
  const { server, port } = await listen(() => {});
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function network(t) {
  const outside = [];
  const pair = [];
  const outsideServer = await listen((req, res) => {
    outside.push({ path: req.url, host: req.headers.host, token: req.headers['x-usernode-token'] || null });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('outside');
  });
  outsideServer.server.on('connect', (_req, socket) => { outside.push({ tunnel: true }); socket.end(); });
  const pairServer = await listen((req, res) => {
    pair.push({ path: req.url, token: req.headers['x-usernode-token'] || null });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('pair');
  });
  t.after(() => { outsideServer.server.close(); pairServer.server.close(); });
  return { outside, pair, outsidePort: outsideServer.port, base: pairServer.origin };
}

async function startProxy(t, net_, { platformAssets = '1', memorySampleMs = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-proxy-egress-'));
  const ready = path.join(dir, 'proxy.ready');
  const notes = path.join(dir, 'notes.jsonl');
  fs.writeFileSync(notes, '');
  const ports = {
    member: await freePort(), read_only_admin: await freePort(), full_admin: await freePort(),
    guest: await freePort(),
  };
  const proxy = spawn(process.execPath, [
    '--require', path.join(__dirname, 'lib', 'shots-proxy-fake-network.js'),
    path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js'),
  ], {
    env: {
      PATH: process.env.PATH,
      SHOTS_ALLOWED_ORIGINS: JSON.stringify([net_.base, 'http://head.invalid:3000']),
      SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready,
      SHOTS_PLATFORM_ASSETS: platformAssets,
      ...(memorySampleMs ? { SHOTS_MEMORY_SAMPLE_MS: String(memorySampleMs) } : {}),
      SHOTS_PROXY_CONTROL_TOKEN: 'c'.repeat(64),
      SHOTS_MEMBER_TOKEN: 'member.fixture.jwt',
      SHOTS_ADMIN_TOKEN: 'admin.fixture.jwt',
      SHOTS_FULL_ADMIN_TOKEN: 'full-admin.fixture.jwt',
      SHOTS_GUEST_TOKEN: 'guest.fixture.jwt',
      SHOTS_PROXY_PERSONA_PORTS: JSON.stringify(ports),
      FAKE_DNS: JSON.stringify(FAKE_DNS),
      FAKE_ROUTES: JSON.stringify({ [PUBLIC]: net_.outsidePort }),
      FAKE_NOTES: notes,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = closedPromise(proxy);
  const stderr = [];
  proxy.stderr.on('data', (chunk) => stderr.push(chunk));
  t.after(async () => {
    await stopProxy(proxy, closed);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const shared = await waitForReady(proxy, ready, { output: () => Buffer.concat(stderr).toString() });
  return {
    shared,
    ports,
    notes: () => fs.readFileSync(notes, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    stderr: () => Buffer.concat(stderr).toString(),
    events: () => Buffer.concat(stderr).toString().trim().split('\n')
      .filter((line) => line.startsWith('__USERNODE_SHOTS_BROWSER__ '))
      .map((line) => JSON.parse(line.slice('__USERNODE_SHOTS_BROWSER__ '.length))),
  };
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

function send(port, url) {
  return new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: url }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', (error) => resolve({ error: error.code }));
    request.end();
  });
}

const blocked = (proxy) => proxy.events().filter((event) => event.kind === 'egress_blocked');

// A refusal's diagnostic reaches stderr on its own schedule, which can be
// after the refused client already has its answer.
async function diagnostics(proxy, kind, count) {
  const deadline = Date.now() + 3000;
  while (proxy.events().filter((event) => event.kind === kind).length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a public host is tunnelled to at the address that was checked, never looked up again', async (t) => {
  const net_ = await network(t);
  const proxy = await startProxy(t, net_);

  assert.equal(await connect(proxy.shared, 'cdn.example:443'), 'HTTP/1.1 200 Connection Established');
  assert.equal(await connect(proxy.shared, `${PUBLIC}:443`), 'HTTP/1.1 200 Connection Established');
  const notes = proxy.notes();
  assert.deepEqual(notes.filter((note) => note.resolve), [{ resolve: 'cdn.example', all: true, verbatim: true }],
    'one lookup, for every answer; an address is not looked up');
  assert.deepEqual(notes.filter((note) => note.connect).map((note) => note.connect),
    [`${PUBLIC}:443`, `${PUBLIC}:443`], 'the tunnel connects to the checked address, not the name');
  assert.deepEqual(blocked(proxy), []);
});

test('an internal destination, another port, or a name that does not resolve is refused and counted by reason', async (t) => {
  const net_ = await network(t);
  const proxy = await startProxy(t, net_);

  const refusals = [
    ['rebind.example:443', 'private_address'],
    ['internal.example:443', 'private_address'],
    ['metadata.example:80', 'private_address'],
    ['10.0.0.5:443', 'private_address'],
    ['127.0.0.1:443', 'private_address'],
    ['169.254.169.254:80', 'private_address'],
    ['[::1]:443', 'private_address'],
    ['[::ffff:10.0.0.5]:443', 'private_address'],
    ['cdn.example:22', 'port'],
    ['cdn.example:8443', 'port'],
    ['missing.example:443', 'dns'],
    ['not-approved.invalid:443', 'dns'],
    // The pair's own host on another port: a browser trying https:// first.
    ['head.invalid:443', 'dns'],
  ];
  for (const [authority] of refusals) {
    assert.match(await connect(proxy.shared, authority), /^HTTP\/1\.1 403/, authority);
  }
  for (const [url] of [['http://internal.example/'], ['http://10.0.0.5/'], ['http://cdn.example:8080/'],
    ['http://169.254.169.254/computeMetadata/v1/']]) {
    assert.equal((await send(proxy.ports.member, url)).status, 403, url);
  }
  assert.deepEqual(net_.outside, [], 'nothing refused reached anything');
  assert.deepEqual(proxy.notes().filter((note) => note.connect || note.request), []);

  // Each refusal is counted with its reason, and nothing that names it.
  await diagnostics(proxy, 'egress_blocked', refusals.length + 4);
  assert.deepEqual(blocked(proxy).map((event) => event.blockReason), [
    ...refusals.map(([, reason]) => reason), 'private_address', 'private_address', 'port', 'private_address',
  ]);
  // And the kind of host, in fixed words: the pair's own (127.0.0.1 is the
  // base here; head.invalid the head), a loopback address, or another.
  assert.deepEqual(blocked(proxy).map((event) => event.hostKind), [
    'other', 'other', 'other', 'other', 'pair_host', 'other', 'loopback', 'other', 'other', 'other', 'other', 'other',
    'pair_host', 'other', 'other', 'other', 'other',
  ]);
  assert.ok(blocked(proxy).every((event) => Object.keys(event).sort().join(',') === 'blockReason,hostKind,kind'));
  assert.doesNotMatch(proxy.stderr(), /rebind|internal\.example|metadata|10\.0\.0\.5|169\.254|missing|not-approved|computeMetadata/);
});

test('a page\'s request to a public host is pinned to the checked address and carries no identity', async (t) => {
  const net_ = await network(t);
  const proxy = await startProxy(t, net_);

  const outside = await send(proxy.ports.member, 'http://cdn.example/lib.js?v=2');
  assert.equal(outside.status, 200);
  assert.equal(outside.body, 'outside');
  const [pinned] = proxy.notes().filter((note) => note.request);
  assert.deepEqual(pinned, { request: 'cdn.example', pinned: { one: PUBLIC, all: [{ address: PUBLIC, family: 4 }] } });
  assert.deepEqual(net_.outside, [{ path: '/lib.js?v=2', host: 'cdn.example', token: null }],
    'the outside host sees its own name, and never a persona\'s identity');
  // Nor the guest's token.
  assert.equal((await send(proxy.ports.guest, 'http://cdn.example/lib.js?v=3')).status, 200);
  assert.equal(net_.outside.at(-1).token, null);

  // The pair is internal, and still reached by name, with the identity.
  assert.equal((await send(proxy.ports.member, `${net_.base}/`)).status, 200);
  assert.deepEqual(net_.pair, [{ path: '/', token: 'member.fixture.jwt' }]);
  assert.ok(!proxy.stderr().includes('member.fixture.jwt') && !proxy.stderr().includes('guest.fixture.jwt'));
});

test('the legacy Tailwind CDN is an ordinary public host now, for any pair, and still counted', async (t) => {
  for (const platformAssets of ['0', '1']) {
    const net_ = await network(t);
    const proxy = await startProxy(t, net_, { platformAssets });
    assert.equal(await connect(proxy.shared, 'cdn.tailwindcss.com:443'), 'HTTP/1.1 200 Connection Established');
    await diagnostics(proxy, 'legacy_tailwind_cdn', 1);
    assert.equal(proxy.events().filter((event) => event.kind === 'legacy_tailwind_cdn').length, 1, platformAssets);
  }
});

test('when the runner asks, the proxy samples the worker\'s memory into the trace, as numbers only', async (t) => {
  const net_ = await network(t);
  const quiet = await startProxy(t, net_);
  const sampled = await startProxy(t, net_, { memorySampleMs: 1000 });
  await diagnostics(sampled, 'worker_memory', 1);
  const [sample] = sampled.events().filter((event) => event.kind === 'worker_memory');
  assert.deepEqual(Object.keys(sample).sort(),
    ['browserProcesses', 'kind', 'limitMb', 'oomKills', 'peakMb', 'rssMb', 'usedMb']);
  for (const value of [sample.usedMb, sample.limitMb, sample.peakMb, sample.oomKills, sample.browserProcesses]) {
    assert.ok(value === null || Number.isSafeInteger(value), JSON.stringify(sample));
  }
  if (sample.rssMb) assert.deepEqual(Object.keys(sample.rssMb), ['browser', 'agent', 'mcp', 'proxy', 'other']);
  assert.deepEqual(quiet.events().filter((event) => event.kind === 'worker_memory'), [], 'off unless asked');
});

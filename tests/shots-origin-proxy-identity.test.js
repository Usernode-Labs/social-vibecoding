'use strict';

// A hosted app learns who is signed in only from the `?token=` on its first
// iframe load; its server refuses its own page without one ("Open this app
// inside Homeroom", services/template.js). The shots browser signs in once,
// so every later page the shots agent opened reached the app with no token
// (every signed-in hosted-app run on 2026-09-30 failed this way). The shots
// proxy now gives each fixture persona its own listener and adds that
// persona's token to requests for the pair's two origins.
//
// Pinned here: each listener attaches its own persona's token and no other;
// the shared listener (bootstrap, control plane) attaches none; only a
// hosted-app pair's own two origins receive it, never a hosted production
// app; a token the page sent itself is left alone; and the token never
// appears in anything the proxy writes out. The guest (a browser that is not
// signed in) has a listener too, which carries a guest token only when the
// platform minted one, and nothing otherwise.
//
// The header signed a page in on its server only. Apps that read who is
// signed in from the `?token=` Homeroom's frame opens them with looked signed
// out on the copies (homeroom-maps PR 36, proposal 7761; job-vacancy PR 27,
// proposal 7524), so a signed-in persona's page load with no token in its
// address is now sent to the same address with a display token: the real
// token's header and claims, a placeholder signature. Pinned below too: the
// address never holds the real token, the pair receives the real one in its
// place, the guest and Homeroom's own pairs are never sent on, and an app's
// own redirect that drops the token is followed, not looped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { closedPromise, waitForReady, stopProxy, startOnFreePorts } = require('./lib/shots-proxy');

const TOKENS = Object.freeze({
  member: 'member.fixture.jwt',
  read_only_admin: 'admin.fixture.jwt',
  full_admin: 'full-admin.fixture.jwt',
});
const GUEST_TOKEN = 'guest.fixture.jwt';
// What a page's address carries in place of each: the same header and
// claims, and a signature that signs nothing.
const DISPLAY = Object.freeze(Object.fromEntries(Object.entries(TOKENS)
  .map(([persona, token]) => [persona, `${token.split('.').slice(0, 2).join('.')}.shots-display-only`])));

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Three upstreams that record the identity header each request arrived with:
// the pair's base and head, and a hosted production app from the catalog.
// `answer` may answer a path itself (a redirect of the app's own).
async function upstreams(t, answer = () => false) {
  const seen = [];
  const make = async (name) => {
    const made = await listen((req, res) => {
      seen.push({ name, path: req.url, token: req.headers['x-usernode-token'] || null });
      if (answer(name, req, res)) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    t.after(() => made.server.close());
    return made.origin;
  };
  return { seen, base: await make('base'), head: await make('head'), hosted: await make('hosted') };
}

function startProxy(t, options) {
  return startOnFreePorts((ports) => startProxyOn(t, ports, options));
}

async function startProxyOn(t, ports, {
  base, head, hosted, platformAssets = '1', withPersonaPorts = true, guestToken = null,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-proxy-identity-'));
  const ready = path.join(dir, 'proxy.ready');
  const hostedFile = path.join(dir, 'hosted-origins.json');
  fs.writeFileSync(hostedFile, JSON.stringify({
    version: 2, baseOrigin: base, headOrigin: head, apps: [{ origin: hosted, slug: 'hosted-app' }],
  }));
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js')], {
    env: {
      PATH: process.env.PATH,
      SHOTS_ALLOWED_ORIGINS: JSON.stringify([base, head]),
      SHOTS_HOSTED_ORIGINS_FILE: hostedFile,
      SHOTS_PROXY_PORT: '0', SHOTS_PROXY_READY: ready,
      SHOTS_PLATFORM_ASSETS: platformAssets,
      SHOTS_PROXY_CONTROL_TOKEN: 'c'.repeat(64),
      SHOTS_MEMBER_TOKEN: TOKENS.member,
      SHOTS_ADMIN_TOKEN: TOKENS.read_only_admin,
      SHOTS_FULL_ADMIN_TOKEN: TOKENS.full_admin,
      ...(guestToken != null ? { SHOTS_GUEST_TOKEN: guestToken } : {}),
      ...(withPersonaPorts ? { SHOTS_PROXY_PERSONA_PORTS: JSON.stringify(ports) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = closedPromise(proxy);
  const output = [];
  proxy.stdout.on('data', (chunk) => output.push(chunk));
  proxy.stderr.on('data', (chunk) => output.push(chunk));
  t.after(async () => {
    await stopProxy(proxy, closed);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const shared = await waitForReady(proxy, ready, { output: () => Buffer.concat(output).toString() });
  return {
    shared,
    ports,
    output: () => Buffer.concat(output).toString(),
    events: () => Buffer.concat(output).toString().trim().split('\n')
      .filter((line) => line.startsWith('__USERNODE_SHOTS_BROWSER__ '))
      .map((line) => JSON.parse(line.slice('__USERNODE_SHOTS_BROWSER__ '.length))),
  };
}

// The status, and where a redirect sends the browser.
function exchange(port, url, headers = {}, method = 'GET') {
  return new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location || null }));
    });
    request.on('error', (error) => resolve({ status: error.code, location: null }));
    request.end();
  });
}

async function send(port, url, headers = {}, method = 'GET') {
  return (await exchange(port, url, headers, method)).status;
}

const DOCUMENT = Object.freeze({ 'sec-fetch-dest': 'document' });

test('each persona\'s listener signs the pair\'s pages in as that persona, and only that one', async (t) => {
  const up = await upstreams(t);
  const proxy = await startProxy(t, up);

  for (const persona of Object.keys(TOKENS)) {
    assert.equal(await send(proxy.ports[persona], `${up.head}/?coll=1&token=${DISPLAY[persona]}`, DOCUMENT), 200);
    assert.equal(await send(proxy.ports[persona], `${up.base}/api/items`), 200);
  }
  assert.deepEqual(up.seen.map(({ name, token }) => [name, token]), [
    ['head', TOKENS.member], ['base', TOKENS.member],
    ['head', TOKENS.read_only_admin], ['base', TOKENS.read_only_admin],
    ['head', TOKENS.full_admin], ['base', TOKENS.full_admin],
  ], 'the page and its API calls both carry the identity, on both sides');

  // The shared listener is the bootstrap's and the control plane's: nothing.
  up.seen.length = 0;
  assert.equal(await send(proxy.shared, `${up.head}/`), 200);
  assert.deepEqual(up.seen.map(({ token }) => token), [null]);
});

test('the identity reaches only the pair\'s own origins, and never overrides the page\'s own', async (t) => {
  const up = await upstreams(t);
  const proxy = await startProxy(t, up);

  // A hosted production app is a different app: its audience is not this one.
  assert.equal(await send(proxy.ports.member, `${up.hosted}/`), 200);
  // A token the page itself sends (the bootstrap's first load) stands.
  assert.equal(await send(proxy.ports.member, `${up.base}/`, { 'x-usernode-token': 'page.own.jwt' }), 200);
  assert.deepEqual(up.seen.map(({ name, token }) => [name, token]), [
    ['hosted', null],
    ['base', 'page.own.jwt'],
  ]);
});

test('the guest\'s listener carries no identity when there is no guest token', async (t) => {
  // Homeroom's own copies, a private child app, or no guest signer: the
  // guest browser is a visitor with nothing at all, on either side.
  for (const guestToken of [null, '']) {
    const up = await upstreams(t);
    const proxy = await startProxy(t, { ...up, guestToken });
    assert.equal(await send(proxy.ports.guest, `${up.head}/`, { 'sec-fetch-dest': 'document' }), 200);
    assert.equal(await send(proxy.ports.guest, `${up.base}/api/items`), 200);
    assert.deepEqual(up.seen.map(({ token }) => token), [null, null]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(proxy.events().filter((event) => event.kind === 'document_request')
      .map((event) => event.identityAttached), [false]);
  }
});

test('a guest token goes only out of the guest\'s listener, and only to a child-app pair\'s own origins', async (t) => {
  const up = await upstreams(t);
  const proxy = await startProxy(t, { ...up, guestToken: GUEST_TOKEN });
  assert.equal(await send(proxy.ports.guest, `${up.head}/`, { 'sec-fetch-dest': 'document' }), 200);
  assert.equal(await send(proxy.ports.guest, `${up.base}/api/items`), 200);
  // Never to a hosted production app, and never over the page's own token.
  assert.equal(await send(proxy.ports.guest, `${up.hosted}/`), 200);
  assert.equal(await send(proxy.ports.guest, `${up.base}/`, { 'x-usernode-token': 'page.own.jwt' }), 200);
  // No other listener carries it.
  for (const persona of Object.keys(TOKENS)) {
    assert.equal(await send(proxy.ports[persona], `${up.head}/`), 200);
  }
  assert.equal(await send(proxy.shared, `${up.head}/`), 200);
  assert.deepEqual(up.seen.map(({ name, token }) => [name, token]), [
    ['head', GUEST_TOKEN], ['base', GUEST_TOKEN],
    ['hosted', null], ['base', 'page.own.jwt'],
    ['head', TOKENS.member], ['head', TOKENS.read_only_admin], ['head', TOKENS.full_admin],
    ['head', null],
  ]);

  // The platform's own pairs are never sent one, even if one were given.
  const own = await upstreams(t);
  const ownProxy = await startProxy(t, { ...own, platformAssets: '0', guestToken: GUEST_TOKEN });
  assert.equal(await send(ownProxy.ports.guest, `${own.base}/`), 200);
  assert.deepEqual(own.seen.map(({ token }) => token), [null]);
});

test('the platform\'s own pairs get nothing: their sessions are cookies the bootstrap installs', async (t) => {
  const up = await upstreams(t);
  const proxy = await startProxy(t, { ...up, platformAssets: '0' });
  assert.equal(await send(proxy.ports.member, `${up.base}/`), 200);
  assert.deepEqual(up.seen.map(({ token }) => token), [null]);
});

test('the ready file appears whole: written under another name, then renamed into place', () => {
  // Every caller polls for the file and then reads the shared port out of
  // it. writeFileSync alone creates it empty before writing, and under the
  // full suite's load a reader once read '' as port 0 and was refused
  // (5 October, the test below).
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'shots-origin-proxy.js'), 'utf8');
  const body = src.slice(src.indexOf('function writeReady('), src.indexOf('Promise.all(['));
  assert.match(body, /fs\.writeFileSync\(partial, String\(sharedPort\)/);
  assert.match(body, /fs\.renameSync\(partial, readyFile\)/);
  assert.match(body, /const partial = `\$\{readyFile\}\.\$\{process\.pid\}\.tmp`/, 'beside it, so the rename stays on one filesystem');
  assert.doesNotMatch(src, /writeFileSync\(readyFile/);
  assert.match(src, /if \(readyFile\) writeReady\(sharedPort\);/);
});

test('without persona ports the proxy is the single shared listener it was, and attaches nothing', async (t) => {
  // The worker image's build-time verifiers start it this way.
  const up = await upstreams(t);
  const proxy = await startProxy(t, { ...up, withPersonaPorts: false });
  assert.equal(await send(proxy.shared, `${up.base}/`), 200);
  assert.deepEqual(up.seen.map(({ token }) => token), [null]);
  assert.notEqual(await send(proxy.ports.member, `${up.base}/`), 200, 'no persona listener exists');
});

test('the token never leaves the proxy: diagnostics carry a boolean, and the control plane stays on the shared port', async (t) => {
  const up = await upstreams(t);
  const proxy = await startProxy(t, { ...up, guestToken: GUEST_TOKEN });
  await send(proxy.ports.guest, `${up.base}/`);
  // The member's page load is sent on to its address with the display
  // token, and that load carries the identity.
  const { location } = await exchange(proxy.ports.member, `${up.head}/`, DOCUMENT);
  await send(proxy.ports.member, location, DOCUMENT);
  await send(proxy.shared, `${up.head}/`, DOCUMENT);
  // Control requests on a persona listener are refused before any check.
  assert.equal(await send(proxy.ports.member, '/__usernode_shots_control/request-failure',
    { 'x-shots-control-token': 'c'.repeat(64) }, 'POST'), 403);
  // Let the response diagnostics flush.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const out = proxy.output();
  for (const token of [...Object.values(TOKENS), GUEST_TOKEN]) {
    assert.ok(!out.includes(token), 'no token appears in anything the proxy writes');
  }
  const requests = proxy.events().filter((event) => event.kind === 'document_request');
  assert.deepEqual(requests.map((event) => event.identityAttached), [false, true, undefined],
    'a persona page load says whether it carried the identity; the shared listener says nothing');
  assert.deepEqual(requests.map((event) => event.identityRedirect), [true, undefined, undefined],
    'and the one sent on to its signed address says so');
  const responses = proxy.events().filter((event) => event.kind === 'document_response');
  assert.equal(responses[0].httpStatus, 302);
  assert.equal(responses[0].documentOrdinal, requests[0].documentOrdinal);
});

test('a signed-in persona\'s page load is sent to its own address with a display token, as Homeroom\'s frame opens it', async (t) => {
  // homeroom-maps decides who is signed in from location.search's token
  // (public/js/auth.js), so /#/sharing said "Location Sharing needs a
  // signed-in account" on the copies though its server would have taken the
  // member (PR 36, proposal 7761).
  const up = await upstreams(t);
  const proxy = await startProxy(t, up);

  for (const persona of Object.keys(TOKENS)) {
    const sent = await exchange(proxy.ports[persona], `${up.head}/?coll=1`, DOCUMENT);
    assert.equal(sent.status, 302);
    assert.equal(sent.location, `${up.head}/?coll=1&token=${DISPLAY[persona]}`,
      'the app\'s own query stands, with the token after it');
    assert.ok(!sent.location.includes(TOKENS[persona]), 'the address never holds the real token');
  }
  const bare = await exchange(proxy.ports.member, `${up.base}/`, DOCUMENT);
  assert.equal(bare.location, `${up.base}/?token=${DISPLAY.member}`);
  assert.deepEqual(up.seen, [], 'nothing reached the app before the browser followed');

  // The followed load, and what the page then sends with the token it read,
  // reach the pair with the real one in its place.
  assert.equal(await send(proxy.ports.member, bare.location, DOCUMENT), 200);
  assert.equal(await send(proxy.ports.member, `${up.base}/api/me`, { 'x-usernode-token': DISPLAY.member }), 200);
  assert.equal(await send(proxy.ports.member, `${up.base}/app-files/a.png?w=2&token=${DISPLAY.member}`), 200);
  assert.deepEqual(up.seen.map(({ name, path: route, token }) => [name, route, token]), [
    ['base', `/?token=${TOKENS.member}`, TOKENS.member],
    ['base', '/api/me', TOKENS.member],
    ['base', `/app-files/a.png?w=2&token=${TOKENS.member}`, TOKENS.member],
  ]);

  // An API call, and a page load that already has a token, go as they are.
  up.seen.length = 0;
  assert.equal(await send(proxy.ports.member, `${up.head}/api/items`), 200);
  assert.equal(await send(proxy.ports.member, `${up.head}/?token=page.own.jwt`, DOCUMENT), 200);
  assert.equal(await send(proxy.ports.member, `${up.head}/form`, DOCUMENT, 'POST'), 200);
  assert.deepEqual(up.seen.map(({ path: route }) => route), ['/api/items', '/?token=page.own.jwt', '/form']);
  assert.ok(!proxy.output().includes(TOKENS.member) && !proxy.output().includes(DISPLAY.member));
});

test('the guest, the shared listener, a hosted production app and Homeroom\'s own pairs keep their addresses', async (t) => {
  const up = await upstreams(t);
  const proxy = await startProxy(t, { ...up, guestToken: GUEST_TOKEN });
  // Homeroom's frame never has guests, and at an app's own address nobody's
  // token is in the query.
  assert.equal(await send(proxy.ports.guest, `${up.head}/`, DOCUMENT), 200);
  assert.equal(await send(proxy.shared, `${up.head}/`, DOCUMENT), 200);
  assert.equal(await send(proxy.ports.member, `${up.hosted}/`, DOCUMENT), 200);
  // A display token sent to a hosted production app is not swapped: it signs
  // nobody in there.
  assert.equal(await send(proxy.ports.member, `${up.hosted}/api/x`, { 'x-usernode-token': DISPLAY.member }), 200);
  assert.deepEqual(up.seen.map(({ name, path: route, token }) => [name, route, token]), [
    ['head', '/', GUEST_TOKEN], ['head', '/', null], ['hosted', '/', null], ['hosted', '/api/x', DISPLAY.member],
  ]);

  const own = await upstreams(t);
  const ownProxy = await startProxy(t, { ...own, platformAssets: '0' });
  assert.equal(await send(ownProxy.ports.member, `${own.base}/`, DOCUMENT), 200);
  assert.deepEqual(own.seen.map(({ path: route, token }) => [route, token]), [['/', null]]);
});

test('an app\'s own redirect that drops the token is followed as it is, not round again', async (t) => {
  // Homeroom's frame ends up with no token after such a redirect too.
  const up = await upstreams(t, (_name, req, res) => {
    const url = new URL(req.url, 'http://app.invalid');
    if (url.pathname === '/start' && url.searchParams.has('token')) {
      res.writeHead(302, { location: '/clean' });
      res.end();
      return true;
    }
    return false;
  });
  const proxy = await startProxy(t, up);

  const first = await exchange(proxy.ports.member, `${up.base}/start`, DOCUMENT);
  assert.equal(first.location, `${up.base}/start?token=${DISPLAY.member}`);
  const stripped = await exchange(proxy.ports.member, first.location, DOCUMENT);
  assert.deepEqual(stripped, { status: 302, location: '/clean' });
  assert.equal(await send(proxy.ports.member, `${up.base}/clean`, DOCUMENT), 200, 'kept as it is');
  assert.deepEqual(up.seen.map(({ path: route, token }) => [route, token]), [
    [`/start?token=${TOKENS.member}`, TOKENS.member],
    ['/clean', TOKENS.member],
  ], 'and the header still signs it in on the server');

  // Only that once: a later visit to the same address is sent on again.
  assert.equal((await exchange(proxy.ports.member, `${up.base}/clean`, DOCUMENT)).status, 302);
});

test('a redirect from the pair that names the real token reaches the browser with the display one', async (t) => {
  const up = await upstreams(t, (_name, req, res) => {
    const url = new URL(req.url, 'http://app.invalid');
    if (url.pathname === '/docs') {
      res.writeHead(301, { location: `/docs/${url.search}` });
      res.end();
      return true;
    }
    return false;
  });
  const proxy = await startProxy(t, up);
  const moved = await exchange(proxy.ports.member, `${up.head}/docs?token=${DISPLAY.member}`, DOCUMENT);
  assert.deepEqual(moved, { status: 301, location: `/docs/?token=${DISPLAY.member}` });
  assert.equal(up.seen[0].path, `/docs?token=${TOKENS.member}`);
});

test('each persona\'s browser is configured onto its own listener', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-mcp-config-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir);
    const hostedFile = path.join(stateDir, 'hosted-origins.json');
    fs.writeFileSync(hostedFile, JSON.stringify({
      version: 2, baseOrigin: 'http://base.example.invalid',
      headOrigin: 'http://head.example.invalid', apps: [],
    }));
    const write = (extra) => {
      const output = path.join(dir, `mcp-${Object.keys(extra).length}.json`);
      execFileSync(process.execPath, [path.join(__dirname, '..', 'worker', 'write-shots-mcp-config.js'), output], {
        env: {
          PATH: process.env.PATH,
          SHOTS_BROWSER_STATE_DIR: stateDir,
          SHOTS_PROXY_SERVER: 'http://127.0.0.1:17891',
          SHOTS_BASE_ORIGIN: 'http://base.example.invalid',
          SHOTS_HEAD_ORIGIN: 'http://head.example.invalid',
          SHOTS_HOSTED_ORIGINS_FILE: hostedFile,
          SHOTS_DIR: path.join(dir, 'shots'),
          ...extra,
        },
      });
      const { mcpServers } = JSON.parse(fs.readFileSync(output, 'utf8'));
      const proxyOf = (name) => {
        const args = mcpServers[name].args;
        return args[args.indexOf('--proxy-server') + 1];
      };
      return ['browser_member', 'browser_admin', 'browser_full_admin', 'browser_guest'].map(proxyOf);
    };
    assert.deepEqual(write({
      SHOTS_PROXY_PERSONA_PORTS: '{"member":17892,"read_only_admin":17893,"full_admin":17894,"guest":17895}',
    }), ['http://127.0.0.1:17892', 'http://127.0.0.1:17893', 'http://127.0.0.1:17894', 'http://127.0.0.1:17895']);
    assert.deepEqual(write({}), Array(4).fill('http://127.0.0.1:17891'),
      'without ports every browser keeps the shared listener');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const runner = fs.readFileSync(path.join(__dirname, '..', 'worker', 'run-cc.sh'), 'utf8');
  const exported = /export SHOTS_PROXY_PERSONA_PORTS='([^']+)'/.exec(runner);
  assert.ok(exported, 'the runner names the persona ports');
  assert.deepEqual(Object.keys(JSON.parse(exported[1])).sort(), ['full_admin', 'guest', 'member', 'read_only_admin']);
  // The proxy starts before the runner drops the tokens from its environment.
  assert.ok(runner.indexOf('node /usr/local/bin/shots-origin-proxy.js &')
    < runner.indexOf('unset SHOTS_MEMBER_TOKEN SHOTS_ADMIN_TOKEN SHOTS_FULL_ADMIN_TOKEN SHOTS_GUEST_TOKEN'));
  assert.ok(runner.indexOf("export SHOTS_PROXY_PERSONA_PORTS=")
    < runner.indexOf('node /usr/local/bin/shots-origin-proxy.js &'));
});

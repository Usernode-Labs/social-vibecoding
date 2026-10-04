// The Kubernetes app-host gate proxy (scripts/app-gate.js) and the routing
// that puts it in front of every app (services/kubernetes.js).
//
// Production routing cannot be exercised here, so this runs the real proxy
// over real sockets between a fake platform (which answers
// /__caddy/access the way src/services/edge-gate.js does) and a fake app,
// and asserts what each side sees: what the platform is asked, what reaches
// the app, and what the visitor gets back. The decision itself is pinned in
// tests/edge-gate.test.js.
//
// Run with: node --test tests/app-gate-proxy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { createGate, HEALTH_PATH } = require('../scripts/app-gate');
const kubernetes = require('../src/services/kubernetes');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => {
  server.close(() => resolve());
  // Keep-alive sockets (ours, and the gate's own agents) would hold close open.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
});

let platform; let platformPort;
let app; let appPort;
let gate; let gatePort;
let deadPort;
const asked = [];
const openSockets = [];
const unavailableHosts = [];
const silent = { error() {}, warn() {} };

test.before(async () => {
  platform = http.createServer((req, res) => {
    if (req.url === '/__app_unavailable') {
      unavailableHosts.push(req.headers.host);
      res.writeHead(503, { 'content-type': 'text/html' });
      return res.end('restarting');
    }
    asked.push({ url: req.url, headers: req.headers });
    const uri = req.headers['x-forwarded-uri'] || '/';
    if (uri.startsWith('/deny')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    if (uri.startsWith('/redirect')) {
      res.writeHead(302, { location: 'https://apex.example/__access/authorize?x=1', 'set-cookie': ['__Host-usernode_access=new; Path=/; Secure; HttpOnly'], 'x-secret': 'never relayed' });
      return res.end();
    }
    const headers = { 'content-type': 'text/plain' };
    if (uri.startsWith('/bad-upstream')) headers['x-usernode-upstream'] = 'Bad_Name';
    else if (uri.startsWith('/dead')) headers['x-usernode-upstream'] = 'app-dead';
    else headers['x-usernode-upstream'] = 'app-a';
    if (uri.startsWith('/ident') || uri.startsWith('/ws')) headers['x-usernode-identity'] = 'IDENT';
    headers['x-usernode-applink'] = 'https://apex.example/#app/a/full';
    res.writeHead(200, headers);
    return res.end('ok');
  });
  platformPort = await listen(platform);

  app = http.createServer((req, res) => {
    if (req.url.startsWith('/rescue')) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('no'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['app=1; Path=/'] });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  app.on('upgrade', (req, socket) => {
    openSockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'
      + `x-seen-token: ${req.headers['x-usernode-token'] || ''}\r\n`
      + `x-seen-identity: ${req.headers['x-usernode-identity'] || ''}\r\n\r\n`);
    socket.on('data', (d) => socket.write(`echo:${d}`));
  });
  appPort = await listen(app);

  const dead = net.createServer();
  deadPort = await listen(dead);
  await close(dead);

  gate = createGate({
    platformUrl: `http://127.0.0.1:${platformPort}`,
    resolveUpstream: (name) => ({ host: '127.0.0.1', port: name === 'app-dead' ? deadPort : appPort }),
    retryWindowMs: 300,
    // The fake platform answers by path; the real one answers an anonymous
    // read the same way whatever the path, which is what the cache relies
    // on. Its own test is below.
    anonCacheMs: 0,
    log: silent,
  });
  gatePort = await listen(gate);
});

test.after(async () => {
  for (const s of openSockets) s.destroy();
  await close(gate);
  await close(platform);
  await close(app);
});

test.beforeEach(() => { asked.length = 0; unavailableHosts.length = 0; });

function through(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: gatePort, path: pathname, method,
      headers: { host: 'a.onhomeroom.com', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not the app */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('it asks the platform the way Caddy forward_auth does, and says it is the Kubernetes gate', async () => {
  await through('/page?q=1', {
    headers: { cookie: 'a=1', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'sec-fetch-dest': 'document' },
  });
  assert.equal(asked.length, 1);
  const h = asked[0].headers;
  assert.equal(asked[0].url, '/__caddy/access');
  assert.equal(h['x-forwarded-host'], 'a.onhomeroom.com');
  assert.equal(h['x-forwarded-method'], 'GET');
  assert.equal(h['x-forwarded-uri'], '/page?q=1');
  assert.equal(h['x-usernode-gate'], 'kubernetes');
  assert.match(h['x-forwarded-for'], /^203\.0\.113\.9, /);
  assert.equal(h.cookie, 'a=1', 'the visitor’s cookies reach the decision');
  assert.equal(h['sec-fetch-dest'], 'document');
  assert.equal(h.host, `127.0.0.1:${platformPort}`);
});

test('an allowed request reaches the app with the identity, and without the gate’s cookies', async () => {
  const r = await through('/ident', {
    headers: { cookie: 'app=1; __Host-usernode_access=secret; __Host-usernode_anon=1; theme=dark' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.headers['x-usernode-token'], 'IDENT');
  assert.equal(r.json.headers['x-usernode-identity'], undefined);
  assert.equal(r.json.headers.cookie, 'app=1; theme=dark');
  assert.equal(r.json.headers.host, 'a.onhomeroom.com', 'the app sees its own host');
  assert.equal(r.json.headers['x-forwarded-host'], 'a.onhomeroom.com');
  assert.deepEqual(r.headers['set-cookie'], ['app=1; Path=/'], 'the app’s own response passes through');
});

test('a token the request carries itself reaches the app untouched when the platform adds none', async () => {
  const r = await through('/plain', { headers: { 'x-usernode-token': 'OWN', cookie: '__usernode_access=x' } });
  assert.equal(r.json.headers['x-usernode-token'], 'OWN');
  assert.equal(r.json.headers.cookie, undefined, 'nothing left after the gate cookie is removed');
});

test('identity and routing headers a client sends are discarded everywhere', async () => {
  const r = await through('/plain', {
    headers: { 'x-usernode-identity': 'FORGED', 'x-usernode-upstream': 'other-app', 'x-usernode-gate': 'x', 'x-usernode-applink': 'https://evil' },
  });
  assert.equal(asked[0].headers['x-usernode-identity'], undefined);
  assert.equal(asked[0].headers['x-usernode-upstream'], undefined);
  assert.equal(asked[0].headers['x-usernode-gate'], 'kubernetes');
  assert.equal(r.json.headers['x-usernode-token'], undefined, 'a forged identity never becomes a token');
  assert.equal(r.json.headers['x-usernode-identity'], undefined);
  assert.equal(r.json.headers['x-usernode-upstream'], undefined);
});

test('a write’s body is passed through', async () => {
  const r = await through('/plain', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
  assert.equal(r.json.method, 'POST');
  assert.equal(r.json.body, 'hello');
  assert.equal(asked[0].headers['x-forwarded-method'], 'POST');
  assert.equal(asked[0].headers['content-length'], undefined, 'the decision is asked without the body');
});

test('a refusal is the visitor’s answer, and only its safe headers travel', async () => {
  const redirect = await through('/redirect');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, 'https://apex.example/__access/authorize?x=1');
  assert.deepEqual(redirect.headers['set-cookie'], ['__Host-usernode_access=new; Path=/; Secure; HttpOnly']);
  assert.equal(redirect.headers['x-secret'], undefined);
  const denied = await through('/deny');
  assert.equal(denied.status, 404);
  assert.equal(denied.text, 'Not found');
});

test('an invalid Service name is never dialled', async () => {
  assert.equal((await through('/bad-upstream')).status, 502);
});

test('an app that is down gets the platform’s restarting page, for its own host', async () => {
  const r = await through('/dead', { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(r.status, 503);
  assert.equal(r.text, 'restarting');
  assert.deepEqual(unavailableHosts, ['a.onhomeroom.com']);
});

test('a 401 to a top-level visit becomes the chromeless view; to anything else it passes', async () => {
  const visit = await through('/rescue/x?y=1', { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(visit.status, 302);
  assert.equal(visit.headers.location, 'https://apex.example/#app/a/full?path=/rescue/x?y=1');
  const fetchR = await through('/rescue/x', { headers: { 'sec-fetch-dest': 'empty' } });
  assert.equal(fetchR.status, 401);
});

test('the platform unreachable: 503, never the app', async () => {
  const lonely = createGate({
    platformUrl: `http://127.0.0.1:${deadPort}`,
    resolveUpstream: () => ({ host: '127.0.0.1', port: appPort }),
    retryWindowMs: 200,
    log: silent,
  });
  const port = await listen(lonely);
  const r = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'a.onhomeroom.com' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
  await close(lonely);
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.text, /—/);
});

test('anonymous reads of a public app are asked once per few seconds; nothing else is cached', async () => {
  const { anonymousRead } = require('../scripts/app-gate');
  const req = (over = {}) => ({ method: 'GET', url: '/app.js', headers: { host: 'a.x', ...over.headers }, ...over });
  assert.equal(anonymousRead(req()), true);
  assert.equal(anonymousRead(req({ headers: { cookie: 'theme=dark' } })), true, 'the app’s own cookies do not matter');
  assert.equal(anonymousRead(req({ headers: { cookie: 'a=1; __Host-usernode_access=x' } })), false, 'the gate cookie does');
  assert.equal(anonymousRead(req({ headers: { 'x-usernode-token': 't' } })), false);
  assert.equal(anonymousRead(req({ url: '/?token=t' })), false);
  assert.equal(anonymousRead(req({ headers: { 'sec-fetch-dest': 'document' } })), false, 'a visit may hop');
  assert.equal(anonymousRead(req({ url: '/__usernode_access?code=x' })), false);
  assert.equal(anonymousRead(req({ method: 'POST' })), false);
  assert.equal(anonymousRead(req({ headers: { 'sec-websocket-key': 'k' } })), false);

  const cached = createGate({
    platformUrl: `http://127.0.0.1:${platformPort}`,
    resolveUpstream: () => ({ host: '127.0.0.1', port: appPort }),
    log: silent,
  });
  const port = await listen(cached);
  const hit = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: 'cached.onhomeroom.com', ...headers } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  try {
    await hit('/one.js');
    await hit('/two.css');
    assert.equal(asked.length, 1, 'two anonymous asset reads, one question');
    await hit('/ident', { cookie: '__Host-usernode_access=x' });
    await hit('/ident', { cookie: '__Host-usernode_access=x' });
    assert.equal(asked.length, 3, 'a signed-in request is always asked');
    await hit('/page', { 'sec-fetch-dest': 'document' });
    assert.equal(asked.length, 4, 'a visit is always asked');
  } finally {
    await close(cached);
  }
});

test('its own health path answers without asking anyone', async () => {
  const r = await through(HEALTH_PATH);
  assert.equal(r.status, 200);
  assert.equal(asked.length, 0);
});

function upgrade(pathname, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(gatePort, '127.0.0.1', () => {
      openSockets.push(socket);
      const lines = [`GET ${pathname} HTTP/1.1`, 'host: a.onhomeroom.com', 'connection: Upgrade', 'upgrade: websocket',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version: 13', 'origin: https://a.onhomeroom.com',
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`)];
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let data = '';
    socket.on('data', (d) => {
      data += d;
      if (data.includes('\r\n\r\n') && !data.includes('echo:') && data.startsWith('HTTP/1.1 101')) socket.write('ping');
      if (data.includes('echo:ping') || (data.includes('\r\n\r\n') && !data.startsWith('HTTP/1.1 101'))) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', reject);
  });
}

test('a WebSocket handshake is decided, carries the identity, and is then piped both ways', async () => {
  const data = await upgrade('/ws', { 'x-usernode-identity': 'FORGED' });
  assert.match(data, /^HTTP\/1\.1 101/);
  assert.match(data, /x-seen-token: IDENT/);
  assert.match(data, /x-seen-identity: \r\n/);
  assert.match(data, /echo:ping/);
  // The decision saw the handshake for what it is, without the hop-by-hop pair.
  assert.ok(asked[0].headers['sec-websocket-key']);
  assert.equal(asked[0].headers.upgrade, undefined);
  assert.equal(asked[0].headers['x-usernode-identity'], undefined);
});

test('a refused WebSocket handshake gets the refusal and nothing else', async () => {
  const data = await upgrade('/deny');
  assert.match(data, /^HTTP\/1\.1 404/);
  assert.match(data, /Not found$/);
});

// ── Routing: the switch, and what it writes ─────────────────────────────

const CFG = { ingressClassName: 'cilium', appTlsSecretName: 'social-apps-wildcard-tls' };

test('APP_GATE is off unless it says on', () => {
  assert.equal(kubernetes.appGateMode({ kubernetes: {} }), 'off');
  assert.equal(kubernetes.appGateMode({ kubernetes: { appGate: 'yes' } }), 'off');
  assert.equal(kubernetes.appGateMode({ kubernetes: { appGate: 'on' } }), 'on');
  const saved = process.env.APP_GATE;
  process.env.APP_GATE = ' ON ';
  try {
    delete require.cache[require.resolve('../src/config')];
    const src = require('node:fs').readFileSync(require.resolve('../src/config'), 'utf8');
    assert.match(src, /appGate: \(process\.env\.APP_GATE \|\| 'off'\)\.trim\(\)\.toLowerCase\(\) === 'on' \? 'on' : 'off'/);
  } finally {
    if (saved === undefined) delete process.env.APP_GATE; else process.env.APP_GATE = saved;
  }
});

test('an app Ingress’s catch-all goes through the gate only when it is up', () => {
  const base = { name: 'sv-app-3-todo', namespace: 'social-apps', hostname: 'todo.onhomeroom.com', resourceLabels: {}, cfg: CFG, assetBackend: kubernetes.PLATFORM_ASSET_NAME };
  const direct = kubernetes._appIngressManifestForTest(base).spec.rules[0].http.paths;
  assert.equal(direct.at(-1).backend.service.name, 'sv-app-3-todo');
  const gated = kubernetes._appIngressManifestForTest({ ...base, gateBackend: kubernetes.APP_GATE_NAME }).spec.rules[0].http.paths;
  assert.equal(gated.at(-1).path, '/');
  assert.equal(gated.at(-1).backend.service.name, 'usernode-app-gate');
  // The asset prefixes never cross the gate.
  for (const prefix of kubernetes.PLATFORM_ASSET_PREFIXES) {
    assert.equal(gated.find((p) => p.path === prefix).backend.service.name, kubernetes.PLATFORM_ASSET_NAME);
  }
});

test('the switch repoints only the catch-all, between the two names it writes', () => {
  const ingress = kubernetes._appIngressManifestForTest({
    name: 'sv-app-3-todo', namespace: 'social-apps', hostname: 'todo.onhomeroom.com', resourceLabels: {}, cfg: CFG,
    assetBackend: kubernetes.PLATFORM_ASSET_NAME,
  });
  const on = kubernetes._ingressWithGateRouteForTest(ingress, 'on');
  assert.equal(on.spec.rules[0].http.paths.at(-1).backend.service.name, 'usernode-app-gate');
  assert.deepEqual(on.spec.rules[0].http.paths.slice(0, -1), ingress.spec.rules[0].http.paths.slice(0, -1));
  assert.equal(kubernetes._ingressWithGateRouteForTest(on, 'on'), null, 'already there: nothing to write');
  const off = kubernetes._ingressWithGateRouteForTest(on, 'off');
  assert.equal(off.spec.rules[0].http.paths.at(-1).backend.service.name, 'sv-app-3-todo');
  // A catch-all pointing somewhere this code never writes is left alone.
  const foreign = JSON.parse(JSON.stringify(ingress));
  foreign.spec.rules[0].http.paths.at(-1).backend.service.name = 'hand-made';
  assert.equal(kubernetes._ingressWithGateRouteForTest(foreign, 'on'), null);
});

test('the gate Deployment: two replicas, never both down, no credentials, asks only the platform', () => {
  const d = kubernetes._appGateDeploymentManifestForTest({
    namespace: 'social-apps', image: 'registry/platform@sha256:abc',
    cfg: { generatedAppServiceAccount: 'social-generated-app' },
    platformUrl: 'http://social-vibecoding.social-platform.svc.cluster.local:3000',
  });
  assert.equal(d.metadata.name, 'usernode-app-gate');
  assert.equal(d.spec.replicas, 2);
  assert.deepEqual(d.spec.strategy.rollingUpdate, { maxUnavailable: 0, maxSurge: 1 });
  const pod = d.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  const c = pod.containers[0];
  assert.deepEqual(c.command, ['node', 'scripts/app-gate.js']);
  assert.deepEqual(c.env.map((e) => e.name).sort(), ['GATE_PLATFORM_URL', 'GATE_UPSTREAM_PORT']);
  assert.equal(c.readinessProbe.httpGet.path, HEALTH_PATH);
  assert.equal(d.spec.template.metadata.labels['app.kubernetes.io/name'], 'usernode-app-gate');
  assert.notEqual(d.metadata.labels['app.kubernetes.io/managed-by'], 'social-vibecoding-runtime',
    'not listed as an app');
});

function fakeNetworking(ingresses) {
  const replaced = [];
  return {
    replaced,
    networking: {
      listNamespacedIngress: async () => ({ items: ingresses }),
      replaceNamespacedIngress: async ({ name, body }) => { replaced.push({ name, body }); return body; },
    },
  };
}

test('off: every managed Ingress goes straight back to its own Service, nothing needs to be up', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const gated = (name) => ({
    metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'social-vibecoding-runtime' } },
    spec: { rules: [{ host: `${name}.x`, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'usernode-app-gate', port: { number: 3000 } } } }] } }] },
  });
  const unmanaged = { ...gated('other'), metadata: { name: 'other', labels: {} } };
  const fake = fakeNetworking([gated('sv-app-1-a'), gated('sv-preview-1-s2'), unmanaged]);
  kubernetes._setClientsForTest({ networking: fake.networking });
  const r = await kubernetes.reconcileAppGateIngresses({ kubernetes: { appNamespace: 'social-apps', appGate: 'off' } });
  assert.deepEqual(r, { mode: 'off', updated: 2 });
  assert.deepEqual(fake.replaced.map((x) => [x.name, x.body.spec.rules[0].http.paths[0].backend.service.name]),
    [['sv-app-1-a', 'sv-app-1-a'], ['sv-preview-1-s2', 'sv-preview-1-s2']]);
});

test('on: nothing is repointed until the gate is up and ready', async (t) => {
  t.after(() => { kubernetes._setClientsForTest(null); kubernetes._resetAppGateForTest(); });
  kubernetes._resetAppGateForTest();
  const saved = process.env.PLATFORM_INTERNAL_URL;
  process.env.PLATFORM_INTERNAL_URL = 'http://platform.internal:3000';
  t.after(() => { if (saved === undefined) delete process.env.PLATFORM_INTERNAL_URL; else process.env.PLATFORM_INTERNAL_URL = saved; });
  const direct = {
    metadata: { name: 'sv-app-1-a', labels: { 'app.kubernetes.io/managed-by': 'social-vibecoding-runtime' } },
    spec: { rules: [{ host: 'a.x', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'sv-app-1-a', port: { number: 3000 } } } }] } }] },
  };
  const fake = fakeNetworking([direct]);
  const notFound = () => { const e = new Error('nf'); e.code = 404; throw e; };
  const created = [];
  let ready = false;
  kubernetes._setClientsForTest({
    networking: fake.networking,
    core: { readNamespacedService: notFound, createNamespacedService: async ({ body }) => { created.push(body.kind); return body; } },
    apps: {
      readNamespacedDeployment: async ({ name }) => {
        if (name === 'social-vibecoding') return { spec: { template: { spec: { containers: [{ name: 'platform', image: 'img@sha256:1' }] } } } };
        if (!ready) notFound();
        return { metadata: { generation: 1 }, spec: { replicas: 2 }, status: { observedGeneration: 1, updatedReplicas: 2, replicas: 2, readyReplicas: 2, availableReplicas: 2 } };
      },
      createNamespacedDeployment: async ({ body }) => { created.push(body.kind); ready = true; return body; },
    },
  });
  const r = await kubernetes.reconcileAppGateIngresses({
    kubernetes: { appNamespace: 'social-apps', appGate: 'on', generatedAppServiceAccount: 'sa' },
  });
  assert.deepEqual(created, ['Service', 'Deployment']);
  assert.deepEqual(r, { mode: 'on', updated: 1 });
  assert.equal(fake.replaced[0].body.spec.rules[0].http.paths[0].backend.service.name, 'usernode-app-gate');
});

test('on, but the gate cannot come up: every app keeps its direct route', async (t) => {
  t.after(() => { kubernetes._setClientsForTest(null); kubernetes._resetAppGateForTest(); });
  kubernetes._resetAppGateForTest();
  delete process.env.PLATFORM_INTERNAL_URL;
  const fake = fakeNetworking([{ metadata: { name: 'x', labels: { 'app.kubernetes.io/managed-by': 'social-vibecoding-runtime' } }, spec: { rules: [] } }]);
  kubernetes._setClientsForTest({ networking: fake.networking });
  await assert.rejects(
    kubernetes.reconcileAppGateIngresses({ kubernetes: { appNamespace: 'social-apps', appGate: 'on' } }),
    /PLATFORM_INTERNAL_URL/
  );
  assert.equal(fake.replaced.length, 0);
});

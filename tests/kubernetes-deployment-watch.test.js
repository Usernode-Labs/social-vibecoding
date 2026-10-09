const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const kubernetes = require('../src/services/kubernetes');
const { watchDeployment } = require('../src/services/kubernetes-deployment-watch');

const wait = kubernetes._waitForDeploymentForTest;
const flush = () => new Promise(setImmediate);
const snapshot = (ready = false, metadata = {}, status = {}, spec = {}) => ({
  metadata: { name: 'demo', namespace: 'apps', uid: 'current', generation: 2, resourceVersion: 'opaque/start', ...metadata },
  spec: { replicas: 1, ...spec },
  status: { observedGeneration: 2, updatedReplicas: 1, replicas: 1,
    readyReplicas: ready ? 1 : 0, availableReplicas: ready ? 1 : 0, ...status },
});
test.afterEach(() => kubernetes._setClientsForTest(null));

test('watch covers the initial-read race and confirms through an authoritative GET', async () => {
  let reads = 0;
  let aborts = 0;
  const current = snapshot(true, { resourceVersion: 'opaque/next' });
  kubernetes._setClientsForTest({ apps: { async readNamespacedDeployment() { return ++reads === 1 ? snapshot() : current; } },
    watchDeployment(options, event) {
      assert.equal(options.resourceVersion, 'opaque/start');
      assert.equal(options.namespace, 'apps');
      event('MODIFIED', current); // It can arrive before the handle is returned.
      return { abort() { aborts++; } };
    },
  });
  assert.equal(await wait('apps', 'demo', { generation: 2 }), current);
  assert.equal(reads, 2);
  assert.equal(aborts, 1);
});

test('stale generations, UIDs, names, zero/deleting and partial rollouts cannot wake completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let event;
  let reads = 0;
  let aborts = 0;
  kubernetes._setClientsForTest({ apps: { async readNamespacedDeployment() { reads++; return snapshot(); } },
    watchDeployment(options, callback) { event = callback; return { abort() { aborts++; } }; },
  });
  const pending = assert.rejects(wait('apps', 'demo', { generation: 2, timeoutMs: 1000 }), /Timed out/);
  await flush();
  for (const bad of [
    snapshot(true, { generation: 1 }, { observedGeneration: 1 }),
    snapshot(true, { uid: 'old', resourceVersion: 'new' }),
    snapshot(true, { name: 'other', resourceVersion: 'new' }),
    snapshot(true, { resourceVersion: 'new', deletionTimestamp: 'now' }),
    snapshot(true, { resourceVersion: 'new' }, {}, { replicas: 0 }),
    ...['updatedReplicas', 'readyReplicas', 'availableReplicas'].map(key => snapshot(true, { resourceVersion: 'new' }, { [key]: 0 })),
    snapshot(true, { resourceVersion: 'new' }, { replicas: 2 }),
    snapshot(true), // An event at the initial resourceVersion is not new.
  ]) event('MODIFIED', bad);
  await flush();
  assert.equal(reads, 1);
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(aborts, 1);
});

test('a backlogged ready event cannot bypass a newer incomplete authoritative state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let event;
  let reads = 0;
  kubernetes._setClientsForTest({ apps: { async readNamespacedDeployment() { reads++; return snapshot(); } },
    watchDeployment(options, callback) { event = callback; return { abort() {} }; },
  });
  const pending = assert.rejects(wait('apps', 'demo', { timeoutMs: 1000 }), /Timed out/);
  await flush();
  event('MODIFIED', snapshot(true, { resourceVersion: 'next' }));
  await flush();
  assert.equal(reads, 2);
  t.mock.timers.tick(1000);
  await pending;
});

test('a recreated Deployment cannot satisfy the UID from the write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let watches = 0;
  kubernetes._setClientsForTest({ apps: { async readNamespacedDeployment() { return snapshot(true, { uid: 'replacement' }); } },
    watchDeployment() { watches++; },
  });
  const pending = assert.rejects(wait('apps', 'demo', { uid: 'current', timeoutMs: 1000 }), /Timed out/);
  await flush();
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(watches, 0);
});

for (const mode of ['polling', 'watch', 'startup-failure', 'disconnect', '410', '403', 'deletion']) {
  test(`rejected Pod-list promises remain best effort with ${mode}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let reads = 0;
    let podReads = 0;
    let watches = 0;
    let callback;
    let close;
    let aborts = 0;
    const api = { apps: { async readNamespacedDeployment() { return snapshot(++reads > 1); } },
      core: { async listNamespacedPod() { podReads++; throw new Error('transient API failure'); } } };
    if (mode !== 'polling') api.watchDeployment = (options, event, done) => {
      watches++;
      if (mode === 'startup-failure') throw new Error('auth setup failed');
      callback = event; close = done;
      return { abort() { aborts++; } };
    };
    kubernetes._setClientsForTest(api);
    const pending = wait('apps', 'demo', { terminalPodFilter: { imageRef: 'new', environmentChecksum: 'env' } });
    await flush();
    assert.equal(podReads, 1);
    if (mode === 'watch') callback('MODIFIED', snapshot(true, { resourceVersion: 'next' }));
    else {
      if (mode === 'disconnect') close(new Error('closed'));
      if (mode === '410' || mode === '403') callback('ERROR', { code: Number(mode) });
      if (mode === 'deletion') callback('DELETED', snapshot());
      t.mock.timers.tick(1000);
    }
    assert.equal((await pending).status.availableReplicas, 1);
    assert.equal(watches, mode === 'polling' ? 0 : 1);
    assert.equal(aborts, ['polling', 'startup-failure'].includes(mode) ? 0 : 1);
  });
}

test('terminal Pod diagnosis filters old image/environment/deleting Pods and cleans the watch', async () => {
  let aborts = 0;
  const pod = (image, env, deletionTimestamp) => ({ metadata: { deletionTimestamp,
    annotations: { 'social.usernode.io/env-checksum': env } },
    spec: { containers: [{ name: 'app', image }] },
    status: { containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CreateContainerConfigError' } } }] } });
  let pods = [pod('old', 'env'), pod('new', 'old'), pod('new', 'env', 'now')];
  assert.deepEqual(kubernetes._terminalPodFailureDetailsForTest(pods, { imageRef: 'new', environmentChecksum: 'env' }), []);
  pods.push(pod('new', 'env'));
  kubernetes._setClientsForTest({ apps: { async readNamespacedDeployment() { return snapshot(); } },
    core: { async listNamespacedPod() { return { items: pods }; } },
    watchDeployment() { return { abort() { aborts++; } }; },
  });
  await assert.rejects(wait('apps', 'demo', { terminalPodFilter: { imageRef: 'new', environmentChecksum: 'env' } }),
    error => error.terminalPodFailure && /cannot start/.test(error.message));
  assert.equal(aborts, 1);
});

test('authoritative Deployment read errors propagate and cancel the watch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let aborts = 0;
  kubernetes._setClientsForTest({ apps: { async readNamespacedDeployment() {
    if (++reads === 1) return snapshot(); throw new Error('GET failed');
  } }, watchDeployment() { return { abort() { aborts++; } }; } });
  const pending = assert.rejects(wait('apps', 'demo'), /GET failed/);
  await flush();
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(aborts, 1);
});

async function serverFixture(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  let agent;
  const kc = { getCurrentCluster() { return { server: `http://127.0.0.1:${server.address().port}/prefix` }; },
    async applyToHTTPSOptions(options) { options.headers = { Authorization: 'Bearer test-only' }; options.agent = agent = new http.Agent(); } };
  return { kc, server, sockets, getAgent: () => agent };
}

test('real HTTP watch preserves server prefix, opaque RV, auth and split UTF8 JSON; abort closes the socket', async t => {
  let observed;
  const fixture = await serverFixture(t, (req, res) => {
    const url = new URL(req.url, 'http://test');
    assert.equal(url.pathname, '/prefix/apis/apps/v1/namespaces/apps/deployments');
    assert.equal(url.searchParams.get('fieldSelector'), 'metadata.name=demo');
    assert.equal(url.searchParams.get('resourceVersion'), 'opaque/start');
    assert.equal(req.headers.authorization, 'Bearer test-only');
    const bytes = Buffer.from(JSON.stringify({ type: 'MODIFIED', object: { message: '✓' } }) + '\n');
    res.writeHead(200);
    const split = bytes.indexOf(Buffer.from('✓')) + 1;
    res.write(bytes.subarray(0, split));
    setImmediate(() => res.write(bytes.subarray(split)));
  });
  const received = new Promise(resolve => { observed = resolve; });
  const handle = watchDeployment(fixture.kc, { namespace: 'apps', name: 'demo', resourceVersion: 'opaque/start', timeoutMs: 2000 },
    (type, object) => observed({ type, object }), () => assert.fail('healthy stream should not fail'));
  assert.deepEqual(await received, { type: 'MODIFIED', object: { message: '✓' } });
  handle.abort();
  await flush(); await flush();
  assert.equal(Object.keys(fixture.getAgent().sockets).length, 0);
});

for (const code of [403, 410]) test(`real HTTP ${code} response falls back and closes transport`, async t => {
  const fixture = await serverFixture(t, (req, res) => { res.writeHead(code); res.end('error'); });
  const error = await new Promise(resolve => watchDeployment(fixture.kc,
    { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 2000 }, () => assert.fail(), resolve));
  assert.equal(error.statusCode, code);
});

test('abort during authentication never opens a late connection and destroys its late agent', async () => {
  let release;
  let destroyed = 0;
  const kc = { getCurrentCluster() { return { server: 'https://unused.invalid' }; },
    async applyToHTTPSOptions(options) { await new Promise(resolve => { release = resolve; }); options.agent = { destroy() { destroyed++; } }; } };
  const handle = watchDeployment(kc, { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 2000 },
    () => assert.fail(), () => assert.fail());
  handle.abort(); release(); await flush();
  assert.equal(destroyed, 1);
});

test('deadline aborts an HTTP request that never receives headers', async t => {
  const fixture = await serverFixture(t, () => {});
  const error = await new Promise(resolve => watchDeployment(fixture.kc,
    { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 30 }, () => assert.fail(), resolve));
  assert.match(error.message, /expired/);
});

for (const protocol of ['http:', 'https:']) {
  for (const cancellation of ['abort', 'deadline']) {
    test(`${protocol} proxy setup is excluded before CONNECT on ${cancellation}`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
      const { KubeConfig } = require('@kubernetes/client-node');
      let requests = 0;
      for (const transport of [require('node:http'), require('node:https')]) {
        t.mock.method(transport, 'request', () => { requests++; assert.fail('no outer watch or nested CONNECT may be attempted'); });
      }
      const kc = new KubeConfig();
      kc.loadFromOptions({
        clusters: [{ name: 'fixture', server: `${protocol}//apiserver.invalid`, skipTLSVerify: true,
          proxyUrl: 'http://proxy.invalid:8080' }],
        users: [{ name: 'fixture', token: 'test-only-token' }],
        contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }], currentContext: 'fixture',
      });
      let agents = 0;
      const applyOptions = kc.applyToHTTPSOptions.bind(kc);
      t.mock.method(kc, 'applyToHTTPSOptions', async options => { agents++; return applyOptions(options); });
      let finishes = 0;
      const handle = watchDeployment(kc,
        { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 30 }, () => assert.fail(),
        error => { finishes++; assert.match(error.message, /configured proxy/); });
      if (cancellation === 'abort') handle.abort();
      await flush();
      t.mock.timers.tick(30);
      await flush();
      assert.equal(requests, 0, 'no CONNECT request, socket or listeners can survive when none are created');
      assert.equal(agents, 0, 'exclude before creating the uncancellable proxy agent');
      assert.equal(finishes, cancellation === 'abort' ? 0 : 1, 'fallback clears the deadline timer');
    });
  }
}

test('a configured proxy retains ordinary readiness polling after watch exclusion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { KubeConfig } = require('@kubernetes/client-node');
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'fixture', server: 'https://unused.invalid', proxyUrl: 'http://proxy.invalid:8080' }],
    users: [{ name: 'fixture' }], contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }], currentContext: 'fixture',
  });
  let reads = 0;
  kubernetes._setClientsForTest({ kc, apps: { async readNamespacedDeployment() { return snapshot(++reads > 1); } } });
  const pending = wait('apps', 'demo', { timeoutMs: 2000 });
  await flush();
  assert.equal(reads, 1);
  t.mock.timers.tick(1000);
  assert.equal((await pending).status.availableReplicas, 1);
  assert.equal(reads, 2);
});

test('pinned real KubeConfig authenticates a direct watch with its bearer credential', async t => {
  const { KubeConfig } = require('@kubernetes/client-node');
  let auth;
  const fixture = await serverFixture(t, (req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200);
    res.write('{"type":"MODIFIED","object":{}}\n');
  });
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'fixture', server: fixture.kc.getCurrentCluster().server, skipTLSVerify: true }],
    users: [{ name: 'fixture', token: 'test-only-token' }],
    contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }], currentContext: 'fixture',
  });
  let handle;
  await new Promise((resolve, reject) => {
    handle = watchDeployment(kc, { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 2000 }, resolve, reject);
  });
  handle.abort();
  assert.equal(auth, 'Bearer test-only-token');
});

test('pinned KubeConfig TLS options reach the native HTTPS request', async t => {
  const { KubeConfig } = require('@kubernetes/client-node');
  const { EventEmitter } = require('node:events');
  let captured;
  let requestDestroyed = 0;
  t.mock.method(require('node:https'), 'request', (url, options) => {
    captured = options;
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = () => { requestDestroyed++; };
    return request;
  });
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'fixture', server: 'https://unused.invalid', skipTLSVerify: true,
      tlsServerName: 'api.internal', caData: Buffer.from('test-ca').toString('base64') }],
    users: [{ name: 'fixture', certData: Buffer.from('test-cert').toString('base64'), keyData: Buffer.from('test-key').toString('base64') }],
    contexts: [{ name: 'fixture', cluster: 'fixture', user: 'fixture' }], currentContext: 'fixture',
  });
  const handle = watchDeployment(kc, { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 2000 },
    () => assert.fail(), () => assert.fail());
  await flush();
  assert.equal(captured.servername, 'api.internal');
  assert.equal(captured.rejectUnauthorized, false);
  assert.equal(captured.ca.toString(), 'test-ca');
  assert.equal(captured.cert.toString(), 'test-cert');
  assert.equal(captured.key.toString(), 'test-key');
  assert.ok(captured.agent);
  handle.abort();
  assert.equal(requestDestroyed, 1);
});

for (const kind of ['error-event', 'malformed-event', 'closed-stream']) {
  test(`real ${kind} cleans the transport and reports fallback once`, async t => {
    const fixture = await serverFixture(t, (req, res) => {
      res.writeHead(200);
      if (kind === 'error-event') res.write('{"type":"ERROR","object":{"code":410}}\n');
      if (kind === 'malformed-event') res.write('invalid-json\n');
      res.end();
    });
    let finishes = 0;
    await new Promise(resolve => watchDeployment(fixture.kc,
      { namespace: 'apps', name: 'demo', resourceVersion: 'opaque', timeoutMs: 2000 }, () => assert.fail(),
      error => { finishes++; assert.ok(error); resolve(); }));
    await flush();
    assert.equal(finishes, 1);
    assert.ok(Object.values(fixture.getAgent().sockets).flat().every(socket => socket.destroyed),
      'all owned client sockets are destroyed; close-event bookkeeping can finish later');
  });
}

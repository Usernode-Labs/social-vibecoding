'use strict';

// The Kubernetes client is loaded on first use (src/services/kubernetes.js and
// kubernetes-buildkit.js), not whenever one of those files is required.
//
// Every other suite hands the service fake clients, so until this one no test
// built the real client at all. These run each place that takes something
// from the package with the real package: the API clients, the log helper and
// a worker exec. The image builder's patch options are the fourth place, and
// tests/kubernetes-buildkit-build.test.js already reaches that one for real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// getClients() reads a kube config the way the platform does outside a
// cluster. Point it at an empty home so it finds none and never reads, or
// runs the login helper of, a real one on the machine running the suite.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kubernetes-client-lazy-'));
process.env.HOME = HOME;
delete process.env.KUBECONFIG;
delete process.env.KUBERNETES_SERVICE_HOST;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const kubernetes = require('../src/services/kubernetes');

test('requiring the service files, or a module that leads to them, does not load the client', () => {
  // A process of its own: this one loads the client further down.
  const script = `
    const Module = require('node:module');
    let requested = 0;
    const load = Module._load;
    Module._load = function counted(request, ...rest) {
      if (request === '@kubernetes/client-node') requested += 1;
      return load.call(this, request, ...rest);
    };
    const kubernetes = require('./src/services/kubernetes');
    require('./src/services/kubernetes-buildkit');
    require('./src/services/application-runtime');
    const afterRequire = requested;
    kubernetes._getClients();
    process.stdout.write(JSON.stringify({ afterRequire, afterFirstUse: requested }));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.deepEqual(out, { afterRequire: 0, afterFirstUse: 1 });
});

test('getClients builds a real config and the five real API clients, once', (t) => {
  t.after(() => kubernetes._setClientsForTest(undefined));
  const clients = kubernetes._getClients();
  assert.equal(typeof clients.kc.makeApiClient, 'function');
  // One call the service makes on each client.
  assert.equal(typeof clients.core.listNamespacedPod, 'function');
  assert.equal(typeof clients.apps.readNamespacedDeployment, 'function');
  assert.equal(typeof clients.batch.createNamespacedJob, 'function');
  assert.equal(typeof clients.networking.readNamespacedIngress, 'function');
  assert.equal(typeof clients.custom.getNamespacedCustomObject, 'function');
  assert.equal(kubernetes._getClients(), clients, 'cached after the first call');
});

test('the log helper builds a real Log from the config, and prefers an injected one', (t) => {
  t.after(() => kubernetes._setClientsForTest(undefined));
  const { kc } = kubernetes._getClients();
  const clients = { kc };
  const logs = kubernetes._clientsLogApiForTest(clients);
  assert.equal(typeof logs.log, 'function');
  assert.equal(clients.logs, logs, 'kept on the clients for the next follow');
  const injected = { log: async () => {} };
  assert.equal(kubernetes._clientsLogApiForTest({ kc, logs: injected }), injected);
  assert.equal(kubernetes._clientsLogApiForTest({}), null);
  assert.equal(kubernetes._clientsLogApiForTest(null), null);
});

test('a worker exec builds a real Exec and dials the pod through it', async (t) => {
  // A stand-in API server that refuses the upgrade: enough to see what the
  // real Exec asked for without a cluster.
  let asked = null;
  const server = http.createServer((req, res) => { res.statusCode = 400; res.end(); });
  server.on('upgrade', (req, socket) => {
    asked = req.url;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => { kubernetes._setClientsForTest(undefined); server.close(); });

  const { KubeConfig } = require('@kubernetes/client-node');
  const kc = new KubeConfig();
  kc.loadFromOptions({
    // The client refuses plain HTTP unless the cluster entry says so.
    clusters: [{ name: 'local', server: `http://127.0.0.1:${server.address().port}`, skipTLSVerify: true }],
    users: [{ name: 'nobody' }],
    contexts: [{ name: 'local', cluster: 'local', user: 'nobody' }],
    currentContext: 'local',
  });
  kubernetes._setClientsForTest({
    kc,
    core: { listNamespacedPod: async () => ({ items: [{ metadata: { name: 'worker-pod' } }] }) },
  });

  await assert.rejects(
    kubernetes.execInWorker({ kubernetes: { workerNamespace: 'workers' } }, 'runtime-1', ['true'], null, { timeoutMs: 10000 }),
    (err) => {
      assert.ok(!(err instanceof ReferenceError) && !(err instanceof TypeError), `${err.name}: ${err.message}`);
      assert.notEqual(err.code, 'ETIMEDOUT', 'refused by the server, not left waiting');
      return true;
    },
  );
  assert.match(asked, /^\/api\/v1\/namespaces\/workers\/pods\/worker-pod\/exec\?/);
  assert.match(asked, /container=worker/);
  assert.match(asked, /command=true/);
});

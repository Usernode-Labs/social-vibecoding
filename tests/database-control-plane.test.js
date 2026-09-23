'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { validatePolicy, submitRequest, reconcileRequest, createStore, REQUESTS, CLUSTERS, OWNER_LABEL } = require('../src/services/database-control-plane');
const { bindingConnectionUrl } = require('../src/services/database-binding');
const { registerDatabaseRoutes } = require('../src/routes/admin-databases');
const { adminMiddleware, requireAdminWrite } = require('../src/middleware/admin');

const policy = { namespace: 'social-platform', targets: [{ id: 'previews', namespace: 'sv-db-preview',
  clusterName: 'previews', profile: 'preview', composition: 'sv-preview-cluster' }] };

function memoryStore() {
  const objects = new Map();
  let creates = 0;
  const key = (plural, namespace, name) => `${plural}/${namespace}/${name}`;
  const copy = (value) => value ? structuredClone(value) : null;
  return {
    objects,
    get creates() { return creates; },
    async get(plural, namespace, name) { return copy(objects.get(key(plural, namespace, name))); },
    async list() { return [...objects].filter(([k]) => k.startsWith(REQUESTS)).map(([, v]) => copy(v)); },
    async create(plural, namespace, object) {
      const k = key(plural, namespace, object.metadata.name);
      if (objects.has(k)) throw Object.assign(new Error('conflict'), { code: 409 });
      const created = copy(object);
      created.metadata = { ...created.metadata, uid: `uid-${++creates}`, resourceVersion: '1', generation: 1 };
      objects.set(k, created);
      return copy(created);
    },
    async setStatus(request, status) {
      const existing = objects.get(key(REQUESTS, request.metadata.namespace, request.metadata.name));
      if (existing.metadata.resourceVersion !== request.metadata.resourceVersion) {
        throw Object.assign(new Error('conflict'), { code: 409 });
      }
      existing.status = copy(status);
      existing.metadata.resourceVersion = String(Number(existing.metadata.resourceVersion) + 1);
    },
  };
}

test('policy rejects production, missing fields, privileged namespaces and aliases', () => {
  assert.equal(validatePolicy(policy), policy);
  for (const change of [{ profile: 'production' }, { id: undefined }, { namespace: 'social-refresh' },
    { composition: 'arbitrary' }, { clusterName: '../postgres' }]) {
    assert.throws(() => validatePolicy({ ...policy, targets: [{ ...policy.targets[0], ...change }] }));
  }
  assert.throws(() => validatePolicy({ targets: [] }));
  assert.throws(() => validatePolicy({ ...policy, targets: [...policy.targets, ...policy.targets] }));
});

test('simultaneous API retries reserve one immutable request', async () => {
  const store = memoryStore();
  const [a, b] = await Promise.all([submitRequest(store, policy, 'previews', 1), submitRequest(store, policy, 'previews', 2)]);
  assert.equal(a.metadata.uid, b.metadata.uid);
  assert.equal(store.creates, 1);
  assert.equal(a.spec.requestedBy, '1');
  await assert.rejects(submitRequest(store, policy, 'platform', 1));
});

test('restarts reserve, create once, wait for current readiness, and detect loss', async () => {
  const store = memoryStore();
  await submitRequest(store, policy, 'previews', 1);
  const request = () => store.get(REQUESTS, policy.namespace, 'previews');
  await reconcileRequest(store, policy, await request());
  assert.equal((await request()).status.reason, 'DestinationReserved');
  assert.equal(store.creates, 1, 'reservation is persisted before creating the composite');
  await reconcileRequest(store, policy, await request());
  assert.equal(store.creates, 2);
  const composite = store.objects.get(`${CLUSTERS}/sv-db-preview/previews`);
  assert.equal(composite.metadata.labels[OWNER_LABEL], (await request()).metadata.uid);
  // A worker restart after the create but before status is acknowledged must
  // discover its existing composite and never create another cluster.
  const storedRequest = store.objects.get(`${REQUESTS}/social-platform/previews`);
  delete storedRequest.status.compositeUid;
  await reconcileRequest(store, policy, await request());
  assert.equal(store.creates, 2);
  composite.metadata.generation = 2;
  composite.status = { conditions: ['Ready', 'Synced'].map((type) => ({ type, status: 'True', observedGeneration: 1 })) };
  await reconcileRequest(store, policy, await request());
  assert.equal((await request()).status.phase, 'Provisioning', 'stale Ready must not pass');
  composite.status.conditions.forEach((c) => { c.observedGeneration = 2; });
  await reconcileRequest(store, policy, await request());
  const ready = await request();
  assert.equal(ready.status.phase, 'Ready');
  await reconcileRequest(store, policy, ready);
  assert.equal((await request()).metadata.resourceVersion, ready.metadata.resourceVersion, 'idle polls avoid writes');
  store.objects.delete(`${CLUSTERS}/sv-db-preview/previews`);
  await reconcileRequest(store, policy, await request());
  assert.equal((await request()).status.phase, 'RecoveryRequired');
  assert.equal(store.creates, 2, 'never replace a previously observed composite silently');
});

test('refuses foreign resources and configuration-driven moves', async () => {
  const store = memoryStore();
  await submitRequest(store, policy, 'previews', 1);
  const request = () => store.get(REQUESTS, policy.namespace, 'previews');
  await reconcileRequest(store, policy, await request());
  await store.create(CLUSTERS, 'sv-db-preview', { metadata: { name: 'previews' }, spec: { profile: 'preview' } });
  await reconcileRequest(store, policy, await request());
  assert.equal((await request()).status.reason, 'ResourceOwnershipConflict');
  const changed = { ...policy, targets: [{ ...policy.targets[0], namespace: 'sv-db-other' }] };
  await reconcileRequest(store, changed, await request());
  assert.equal((await request()).status.reason, 'DestinationChanged');
  assert.equal(store.creates, 2);
});

test('concurrent worker status writes use optimistic concurrency', async () => {
  const store = memoryStore();
  const request = await submitRequest(store, policy, 'previews', 1);
  const results = await Promise.allSettled([reconcileRequest(store, policy, request), reconcileRequest(store, policy, request)]);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 409).length, 1);
});

test('store paginates and applies a deadline to Kubernetes requests', async () => {
  const calls = [];
  const store = createStore({ async listNamespacedCustomObject(args, options) {
    calls.push(args);
    let signal;
    await options.promiseMiddleware[0].pre({ setSignal(value) { signal = value; } });
    assert.ok(signal instanceof AbortSignal);
    return args._continue ? { items: [2], metadata: {} } : { items: [1], metadata: { continue: 'next' } };
  } });
  assert.deepEqual(await store.list('social-platform'), [1, 2]);
  assert.equal(calls[1]._continue, 'next');
});

test('binding URL never inherits the platform endpoint or administrative identity', () => {
  const binding = { database: 'app_notes', owner: 'app_notes_owner', host: 'apps-rw.sv-db-a.svc.cluster.local', port: 5432, sslMode: 'require' };
  const url = new URL(bindingConnectionUrl(binding, 'p@ss/word:?#'));
  assert.equal(url.hostname, binding.host);
  assert.equal(decodeURIComponent(url.password), 'p@ss/word:?#');
  assert.equal(url.username, binding.owner);
  assert.equal(url.pathname, '/app_notes');
  for (const bad of [{ host: 'evil/host' }, { host: 'a..b' }, { port: 0 }, { database: 'x;drop' },
    { database: undefined }, { owner: undefined }, { sslMode: 'disable' }]) {
    assert.throws(() => bindingConnectionUrl({ ...binding, ...bad }, 'password'));
  }
  assert.throws(() => bindingConnectionUrl(binding, ''));
  const dbManager = require('../src/services/db-manager');
  assert.equal(dbManager.connectionUrl(binding.database, 'password', binding), bindingConnectionUrl(binding, 'password'));
  assert.throws(() => dbManager.connectionUrl('app_other', 'password', binding), /does not match/);
});

test('HTTP API requires admin reads and full-admin writes; rejects arbitrary manifests', async (t) => {
  const store = memoryStore();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 7, isAdmin: ['read', 'write'].includes(req.headers['x-test-role']), canAdminWrite: req.headers['x-test-role'] === 'write' };
    next();
  });
  app.use('/api/admin', adminMiddleware);
  registerDatabaseRoutes(app, { requireAdminWrite, getPolicy: () => policy, getStore: () => store });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/database-clusters`;
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(url, { headers: { 'x-test-role': 'read' } })).status, 200);
  const post = (role, body) => fetch(url, { method: 'POST', headers: { 'x-test-role': role, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('read', { target: 'previews' })).status, 403);
  assert.equal((await post('write', { target: 'previews', namespace: 'social-refresh' })).status, 400);
  assert.equal((await post('write', { target: 'platform' })).status, 400);
  assert.equal((await post('write', { target: 'previews' })).status, 202);
  assert.equal((await post('write', { target: 'previews' })).status, 202);
  assert.equal(store.creates, 1);
});

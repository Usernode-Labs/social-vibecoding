'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMigrations, reconcile } = require('../src/services/database-migrations');
const { registerMigrationRoutes } = require('../src/routes/admin-database-migrations');
const express = require('express');
const { adminMiddleware } = require('../src/middleware/admin');

const policy = { namespace: 'social-platform', bindingTargets: [{ bindingName: 'app-4-production', slug: 'fixture', database: 'app_fixture' }],
  targets: [{ id: 'retained', profile: 'retained' }], runtimeTargets: [{ id: 'retained' }] };
const request = { id: 'sv-move-20260924-abcdef12', binding: 'app-4-production', target: 'retained', expectedRevision: 4, confirmation: 'fixture' };
function fixture() {
  const objects = [];
  let job = false;
  const store = {
    binding: async () => ({ metadata: {}, spec: { database: 'app_fixture' }, status: { phase: 'Ready', current: { targetId: 'central', revision: 4 } } }),
    list: async () => objects,
    get: async id => objects.find(o => o.metadata.name === id),
    create: async (id, spec) => { const o = { metadata: { name: id }, spec }; objects.push(o); return o; },
    update: async (o, spec) => Object.assign(o, { spec }),
    status: async (o, status) => Object.assign(o, { status }),
    hasJob: async () => job,
  };
  const executions = [];
  const execute = async (command, args) => { executions.push({ command, args }); job = true; return { current: { targetId: args.target, revision: 5 } }; };
  return { objects, store, execute, executions, service: createMigrations({ store, execute, getPolicy: () => policy }) };
}

test('submit is durable and retries do not create a second migration', async () => {
  const f = fixture();
  await f.service.submit(request, 7);
  await f.service.submit(request, 7);
  assert.equal(f.objects.length, 1); assert.equal(f.executions.length, 0);
  assert.equal(f.objects[0].spec.requestedBy, '7');
  await assert.rejects(f.service.submit(request, 8), /another request/);
});
test('unknown app, disposable target, stale revision and missing confirmation fail closed', async () => {
  for (const patch of [{ binding: 'unknown' }, { target: 'previews' }, { expectedRevision: 3 }, { confirmation: '' }]) {
    const f = fixture(); await assert.rejects(f.service.submit({ ...request, ...patch }, 7)); assert.equal(f.objects.length, 0);
  }
});
test('a pending migration blocks another submission', async () => {
  const f = fixture(); await f.service.submit(request, 7);
  await assert.rejects(f.service.submit({ ...request, id: 'sv-move-20260924-abcdef13' }, 7), /active migration/);
});
test('restart requires explicit recovery without invoking the operator', async () => {
  const f = fixture(); await f.service.submit(request, 7);
  f.objects[0].status = { phase: 'Running', observedAttempt: 1 };
  await reconcile(f.objects[0], f);
  assert.equal(f.executions.length, 0); assert.equal(f.objects[0].status.phase, 'NeedsAttention');
  await f.service.action(request.id, { action: 'resume', attempt: 1 });
  await reconcile(f.objects[0], f);
  assert.equal(f.executions[0].command, 'start'); // No Job existed before restart.
  assert.equal(f.executions[0].args.expectedRevision, 4);
  assert.equal(f.objects[0].status.phase, 'Completed');
});
test('operator failure retains intent and recovery requires current attempt', async () => {
  const f = fixture(); await f.service.submit(request, 7);
  await reconcile(f.objects[0], { ...f, execute: async () => { throw Error('secret-bearing diagnostic'); } });
  assert.equal(f.objects[0].status.phase, 'NeedsAttention');
  assert.doesNotMatch(JSON.stringify(await f.service.inventory()), /secret-bearing/);
  await assert.rejects(f.service.action(request.id, { action: 'resume', attempt: 0 }), /changed/);
});
test('abort before a Job exists cancels without invoking SQL operator', async () => {
  const f = fixture(); await f.service.submit(request, 7);
  f.objects[0].status = { phase: 'NeedsAttention', observedAttempt: 1 };
  await f.service.action(request.id, { action: 'abort', attempt: 1 });
  await reconcile(f.objects[0], f);
  assert.equal(f.objects[0].status.phase, 'Aborted'); assert.equal(f.executions.length, 0);
});
test('moving bindings are still visible to the maintenance page', async () => {
  const f = fixture(); f.store.binding = async () => ({ metadata: {}, spec: { database: 'app_fixture' }, status: { phase: 'Moving', current: { targetId: 'central', revision: 4 } } });
  assert.equal((await f.service.inventory()).bindings[0].phase, 'Moving');
});
test('HTTP mutations require full admin, JSON, and exact same origin', async t => {
  const f = fixture(); const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7, isAdmin: req.get('x-test-role') !== 'user', canAdminWrite: req.get('x-test-role') === 'write' }; next(); });
  app.use(adminMiddleware); registerMigrationRoutes(app, f.service, { origin: 'https://staging.example' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/admin/database-migrations`;
  for (const role of ['user', 'read']) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://staging.example', 'x-test-role': role }, body: JSON.stringify(request) });
    assert.equal(r.status, 403);
  }
  for (const origin of ['', 'https://attacker.example']) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-test-role': 'write' }, body: JSON.stringify(request) }); assert.equal(r.status, 403);
  }
  const read = await fetch(url, { headers: { 'x-test-role': 'read' } }); assert.equal(read.status, 200); assert.equal((await read.json()).canWrite, false);
  const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://staging.example', 'x-test-role': 'write' }, body: JSON.stringify(request) }); assert.equal(ok.status, 202);
});

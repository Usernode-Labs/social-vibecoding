'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { fixtureFor } = require('./lib/complete-preparation-fixture');
const { addHandoffColumns, handoffWorker } = require('./lib/cli-handoff-fixture');
const { sanitizedEnvironment } = require('./lib/isolated-kpack-fixture');
const { createExecutionWorker } = require('../src/services/execution/worker');
const { CONTINUE } = require('../src/services/cli-preview-handoff/work');
const { bindingRef, createBindingAdapters } = require('../src/services/preview-flow/binding-adapters');

async function interrupt(t, f, phase) {
  const child = fork(require.resolve('./lib/cli-handoff-child'), [], {
    execArgv: [], env: sanitizedEnvironment(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const paused = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', code => reject(new Error(`C8 child exited ${code} before ${phase}`)));
  });
  child.send({ databaseUrl: f.url, sessionId: f.sessionId, phase });
  assert.deepEqual(await paused, { phase });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await f.pool.query(`UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second',
    due_at = clock_timestamp() WHERE status = 'running'`);
}

async function resourceIdentity(f, flowId) {
  const intent = await f.owner.readResourceIntent(f.sessionId, flowId);
  const clone = await f.clones.inspect(intent);
  const image = await f.images.inspect(intent);
  const runtime = await f.runtimes.inspect(f.config, intent);
  assert.equal(runtime.status, 'healthy');
  const runtimeUids = {};
  for (const kind of ['secret', 'service', 'deployment']) {
    const api = kind === 'deployment' ? f.clients.apps : f.clients.core;
    const method = { secret: 'readNamespacedSecret', service: 'readNamespacedService', deployment: 'readNamespacedDeployment' }[kind];
    const object = await api[method]({ namespace: intent.namespace,
      name: kind === 'secret' ? `${intent.runtimeName}-env` : intent.runtimeName });
    assert.equal(object.metadata.uid, intent.runtimeOperation.resources[kind].uid);
    runtimeUids[kind] = object.metadata.uid;
  }
  return { databaseOid: clone.databaseOid, buildUid: image.uid, imageRef: image.imageRef, runtimeUids };
}

test('C8 actual preparation + conditional Ingress activation survive admission, candidate and activation process loss', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  const f = await fixtureFor(t);
  await addHandoffColumns(f.pool);
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = $2', [f.fixture.preparationSource.revision, f.sessionId]);
  const oldLifecycle = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  t.after(() => {
    if (oldLifecycle === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = oldLifecycle;
  });
  let work = handoffWorker(f);
  const servingBefore = await f.clients.apps.readNamespacedDeployment({ namespace: f.serving.namespace, name: f.serving.runtimeName });
  const app = { id: 1, slug: 'demo' };
  const activationConfig = { ...f.config, selfAppSlug: 'demo', kubernetes: { ...f.config.kubernetes, appDomain: 'fixture.invalid' } };
  const ref = bindingRef(activationConfig, app, f.sessionId);
  // Real stable binding initially points at the independently healthy sentinel.
  const ingress = require('../src/services/kubernetes').appIngressManifest({
    name: ref.runtimeName, namespace: ref.namespace, hostname: ref.hostname,
    resourceLabels: { 'social.usernode.io/session-id': String(f.sessionId) }, cfg: activationConfig.kubernetes, assetBackend: null,
  });
  ingress.spec.rules[0].http.paths.find(path => path.path === '/').backend.service.name = f.serving.runtimeName;
  const oldIngress = await f.clients.networking.createNamespacedIngress({ namespace: ref.namespace, body: ingress });
  const routes = createBindingAdapters({ clients: () => f.clients });
  const before = await routes.inspect(activationConfig, ref);
  await interrupt(t, f, 'admitted');
  const admitted = await work.admit({ session: (await f.pool.query('SELECT * FROM chat_sessions WHERE id = $1', [f.sessionId])).rows[0], headSha: f.fixture.preparationSource.revision });
  assert.equal(admitted.replayed, true, 'Lost admission reply joins persisted preparation');
  await f.assertServing();
  await interrupt(t, f, 'candidate_committed');
  const state = await f.owner.read(f.sessionId);
  assert.equal(state.flow.state, 'candidate');
  const identities = await resourceIdentity(f, state.flow.id);
  assert.ok(identities.databaseOid && identities.buildUid && identities.imageRef);
  assert.deepEqual(await routes.inspect(activationConfig, ref), before, 'Preparation preserves serving binding');
  await f.assertServing();
  const finish = await work.recover(f.sessionId);
  assert.equal(finish.workflow, CONTINUE);
  await interrupt(t, f, 'activation_reply_lost');
  assert.equal((await f.owner.read(f.sessionId)).flow.state, 'activating');
  await interrupt(t, f, 'activated');
  const afterActivation = await routes.inspect(activationConfig, ref);
  assert.equal(afterActivation.uid, oldIngress.metadata.uid, 'Conditional activation updates the same stable binding');
  assert.equal(afterActivation.target, state.resource.intent.runtimeName);
  assert.equal((await f.owner.read(f.sessionId)).flow.state, 'ready');
  work = handoffWorker(f, { activation: async () => assert.fail('Observed activation must be adopted') });
  await interrupt(t, f, 'checks_stored');
  const worker = createExecutionWorker({ store: work.store, handlers: { [CONTINUE]: work.handlers[CONTINUE] }, concurrency: 1 });
  await worker.tick();
  await worker.drain();
  assert.equal((await work.recover(f.sessionId)).status, 'succeeded');
  assert.equal((await work.owner.read(f.sessionId)).handoff.phase, 'complete');
  assert.deepEqual(await resourceIdentity(f, state.flow.id), identities, 'No clone/Build/runtime recreation across the handoff');
  assert.deepEqual(await routes.inspect(activationConfig, ref), afterActivation);
  assert.equal(await f.probe(f.config, f.serving), true, 'Previously serving runtime stays healthy');
  const servingAfter = await f.clients.apps.readNamespacedDeployment({ namespace: f.serving.namespace, name: f.serving.runtimeName });
  assert.equal(servingAfter.metadata.uid, servingBefore.metadata.uid);
  assert.deepEqual(servingAfter.spec, servingBefore.spec);
  t.diagnostic(JSON.stringify({ preparationWork: admitted.work.id, continuationWork: finish.id, identities,
    ingressUid: afterActivation.uid, checks: 'injected executor; actual guarded PostgreSQL verdict' }));
});

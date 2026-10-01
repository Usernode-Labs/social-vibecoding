'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { sanitizedEnvironment } = require('./lib/isolated-kpack-fixture');
const { runtimeTestWorker } = require('./lib/runtime-test-worker');
const { runtimeManifests } = require('../src/services/preview-flow/runtime-intent');
const { setTimeout: delay } = require('node:timers/promises');
const { createExecutionWorker } = require('../src/services/execution/worker');
const { PREPARE_RUNTIME } = require('../src/services/preview-flow/work');

const { fixtureFor, cleanupPass, assertCandidate } = require('./lib/runtime-integration-fixture');

for (const pauseAt of ['created_secret', 'created_service', 'healthy']) {
  test(`actual Kubernetes + PostgreSQL: worker interruption at ${pauseAt}, lost replies and healthy adoption preserve serving`, {
    skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
  }, async t => {
    const f = await fixtureFor(t);
    const admitted = await f.admit();
    const child = fork(require.resolve('./lib/recoverable-runtime-child'), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: sanitizedEnvironment(),
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const paused = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', code => reject(new Error(`Child exited before interruption: ${code}`)));
    });
    child.send({ databaseUrl: f.url, pauseAt });
    assert.deepEqual(await paused, { phase: pauseAt });
    const before = await f.runtimes.inventory((await f.owner.read(f.sessionId)).resource.intent);
    assert.equal(before.status, 'inspected');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await f.pool.query('UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL \'1 second\' WHERE id = $1', [admitted.work.id]);
    await f.assertServing();

    let lostReceipt = false;
    const record = f.owner.recordRuntime;
    f.owner.recordRuntime = async (...args) => {
      const receipt = await record(...args);
      if (!lostReceipt) { lostReceipt = true; throw new Error('Injected lost runtime-receipt reply after actual SQL commit'); }
      return receipt;
    };
    const loseCreate = pauseAt === 'created_secret' ? 'service' : pauseAt === 'created_service' ? 'deployment' : null;
    const recovery = runtimeTestWorker(f.pool, f.fixture, f.clients, { owner: f.owner, loseCreate });
    await f.poll(recovery.work, admitted.work.id);
    const state = await f.owner.read(f.sessionId);
    assert.equal(state.flow.state, 'candidate');
    const after = await recovery.runtimes.inventory(state.resource.intent);
    assert.equal(after.status, 'inspected');
    for (const kind of ['secret', 'service', 'deployment']) {
      assert.ok(state.resource.intent.runtimeOperation.resources[kind].uid);
      if (before.resources[kind]) {
        assert.equal(after.resources[kind].metadata.uid, before.resources[kind].metadata.uid);
        assert.equal(recovery.counts[kind], 0, 'existing objects must not be recreated');
      } else assert.equal(recovery.counts[kind], 1);
    }
    assert.equal(lostReceipt, true);
    assert.equal((await recovery.runtimes.inspect(recovery.config, state.resource.intent)).status, 'healthy');
    await f.assertServing();
    t.diagnostic(`Recovered ${pauseAt}: ${JSON.stringify(state.resource.intent.runtimeOperation.resources)}, serving ${f.serving.runtimeName} unchanged`);
  });
}

for (const delayed of [false, true]) {
  test(`actual Kubernetes + PostgreSQL: ${delayed ? 'late Deployment after absence' : 'healthy predecessor retirement'} preserves successor`, {
    skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
  }, async t => {
    const f = await fixtureFor(t);
    const admitted = await f.admit();
    let pendingCreate;
    const delayedClients = {
      ...f.clients,
      apps: new Proxy(f.clients.apps, {
        get(target, key) {
          if (key === 'createNamespacedDeployment') return async (...args) => {
            // Inject external timing at the service boundary. The later POST,
            // resulting controller objects and deletion are actual resources.
            pendingCreate = () => target[key](...args);
            throw new Error('Injected external creation remains outstanding');
          };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    };
    const predecessor = delayed ? runtimeTestWorker(f.pool, f.fixture, delayedClients, { owner: f.owner }) : f;
    if (delayed) {
      const worker = createExecutionWorker({ store: predecessor.work.store, handlers: {
        [PREPARE_RUNTIME]: predecessor.work.handlers[PREPARE_RUNTIME],
      }, concurrency: 1 });
      await worker.tick();
      await worker.drain();
      assert.ok(pendingCreate);
    } else await f.poll(f.work, admitted.work.id);
    const old = await f.owner.read(f.sessionId);
    assert.equal(old.resource.intent.runtimeOperation.resources.deployment.submitted, true);

    const next = await f.admit();
    await f.poll(f.work, next.work.id);
    const successor = await f.owner.read(f.sessionId);
    const successorObserved = await f.runtimes.inspect(f.config, successor.resource.intent);
    assert.equal(successorObserved.status, 'healthy');
    assert.notEqual(successor.resource.intent.runtimeName, old.resource.intent.runtimeName);

    await cleanupPass(f, f.work, old.flow.id);
    if (delayed) {
      const absent = await f.runtimes.inventory(await f.owner.readResourceIntent(f.sessionId, old.flow.id), { retiring: true });
      assert.equal(absent.status, 'inspected');
      assert.ok(Object.values(absent.resources).every(resource => resource === null));
      const created = await pendingCreate();
      assert.ok(created.metadata.uid);
      t.diagnostic(`Actual late Deployment ${created.metadata.uid} created after absence; retirement remains discoverable`);
    }

    const deadline = Date.now() + 120000;
    let remaining;
    do {
      await cleanupPass(f, f.work, old.flow.id);
      const intent = await f.owner.readResourceIntent(f.sessionId, old.flow.id);
      remaining = await f.runtimes.inventory(intent, { retiring: true });
      assert.equal(remaining.status, 'inspected');
      await assertCandidate(f, successor.resource.intent, successorObserved.uids);
      assert.ok(Date.now() < deadline, 'owned runtime objects must eventually retire');
      if (Object.values(remaining.resources).some(Boolean)) await delay(1000);
    } while (Object.values(remaining.resources).some(Boolean));
    await cleanupPass(f, f.work, old.flow.id);
    const { rows: [resource] } = await f.pool.query('SELECT cleanup_completed_at, intent FROM preview_flow_resources WHERE flow_id = $1', [old.flow.id]);
    assert.equal(resource.cleanup_completed_at, null);
    assert.ok(f.counts.cloneRemovals > 0);
    assert.ok(resource.intent.runtimeOperation.resources.deployment.uid, 'late physical UID must be journaled');
    const stale = await f.owner.apply({
      type: 'RequestCandidateRuntimeResourceCreation', actionId: randomUUID(), sessionId: f.sessionId,
      flowId: old.flow.id, generation: old.flow.generation, headSha: old.flow.headSha,
      operationId: old.resource.intent.attemptId, resource: 'deployment',
    });
    assert.equal(stale.decision.accepted, false);
    await assertCandidate(f, successor.resource.intent, successorObserved.uids);
    t.diagnostic(`Retired ${old.resource.intent.runtimeName}; successor ${JSON.stringify(successorObserved.uids)} and serving preview unchanged; database release reported separately`);
  });
}

test('actual Kubernetes + PostgreSQL: conflicting physical Service ownership blocks recovery and cleanup', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  const f = await fixtureFor(t);
  const admitted = await f.admit();
  await f.poll(f.work, admitted.work.id);
  const old = await f.owner.read(f.sessionId);
  const before = await f.runtimes.inventory(old.resource.intent);
  assert.equal(before.status, 'inspected');
  const service = before.resources.service;
  await f.clients.core.deleteNamespacedService({
    namespace: old.resource.intent.namespace,
    name: service.metadata.name,
    body: { preconditions: { uid: service.metadata.uid, resourceVersion: service.metadata.resourceVersion } },
  });
  const replacement = await f.clients.core.createNamespacedService({
    namespace: old.resource.intent.namespace,
    body: runtimeManifests(old.resource.intent, f.config.dataEncryptionKey).service,
  });
  assert.notEqual(replacement.metadata.uid, service.metadata.uid);
  assert.equal((await f.runtimes.inspect(f.config, old.resource.intent)).reason, 'ownership_conflict');
  const fact = await f.owner.apply({
    type: 'CandidateRuntimeResourceObserved', actionId: randomUUID(), sessionId: f.sessionId,
    flowId: old.flow.id, generation: old.flow.generation, headSha: old.flow.headSha,
    operationId: old.resource.intent.attemptId, resource: 'service', uid: replacement.metadata.uid,
  });
  assert.equal(fact.decision.reason, 'runtime_uid_conflict');

  const next = await f.admit();
  await f.poll(f.work, next.work.id);
  const successor = await f.owner.read(f.sessionId);
  const expected = await f.runtimes.inspect(f.config, successor.resource.intent);
  assert.equal(expected.status, 'healthy');
  await cleanupPass(f, f.work, old.flow.id);
  const remainingService = await f.clients.core.readNamespacedService({ namespace: old.resource.intent.namespace, name: service.metadata.name });
  const remainingDeployment = await f.clients.apps.readNamespacedDeployment({ namespace: old.resource.intent.namespace, name: old.resource.intent.runtimeName });
  assert.equal(remainingService.metadata.uid, replacement.metadata.uid);
  assert.equal(remainingDeployment.metadata.uid, before.resources.deployment.metadata.uid);
  await assertCandidate(f, successor.resource.intent, expected.uids);
  t.diagnostic(`Conflicting Service UID ${replacement.metadata.uid} preserved; no stale deletion or UID adoption`);
});

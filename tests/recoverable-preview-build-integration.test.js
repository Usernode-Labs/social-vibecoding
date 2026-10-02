'use strict';

// The explicit runner gates this test. Reverify in this process and its child
// before any mutation; neither process loads default Kubernetes credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createCompletePreviewWork } = require('./lib/complete-preview-work');
const { PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { createImageBuildOperations } = require('../src/services/preview-flow/image-build-operation');
const { buildManifest } = require('../src/services/preview-flow/image-build-intent');
const kubernetes = require('../src/services/kubernetes');
const { verifyIsolatedBuildFixture, sanitizedEnvironment } = require('./lib/isolated-kpack-fixture');

test('actual kpack + PostgreSQL: interrupted worker adopts the same Build UID and digest after a lost decision reply', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1',
  timeout: 1200000,
}, async t => {
  const { fixture, clients } = await verifyIsolatedBuildFixture();
  kubernetes._setClientsForTest(clients);
  t.after(() => kubernetes._setClientsForTest(new Proxy({}, {
    get() { throw new Error('Isolated test ended; ambient Kubernetes clients are forbidden'); },
  })));
  const config = { ...fixture.config, nativeCliPreviewHandoffEnabled: true };
  const db = await createExecutionDatabase(fixture.isolation.database.url);
  t.after(() => db.close());
  const sessionId = 3000000 + process.pid;
  config.databaseUrl = db.url;
  config.dataEncryptionKey = 'disposable-integration-only';
  await db.pool.query('UPDATE apps SET repo_url = $1 WHERE id = 1', [fixture.repoUrl]);
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1, $2)', [sessionId, fixture.revision]);
  const owner = createPreviewFlow(db.pool);
  const images = createImageBuildOperations({ clients: () => clients });
  let lostReply = false;
  const apply = owner.apply;
  owner.apply = async action => {
    const result = await apply(action);
    if (action.type === 'CandidateImageBuilt' && !lostReply) {
      lostReply = true;
      throw new Error('Injected reply loss after actual PostgreSQL commit');
    }
    return result;
  };
  const work = createCompletePreviewWork(db.pool, config, {
    owner,
    images,
    clones: { prepare: async () => ({ status: 'complete', databaseOid: '123' }) },
    async prepare(_config, _session, _app, head, candidate) {
      await candidate.prepareClone();
      const built = await candidate.prepareImage(fixture.runScript);
      // Build is actual; clone and the runtime transport are explicitly injected.
      const deployed = await candidate.prepareRuntime({ imageRef: built.imageRef, env: {} });
      return { ...deployed, commitSha: head, stagingUrl: deployed.url };
    },
  });
  const admitted = await work.request({ type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId,
    headSha: fixture.revision, startedStatus: 'active' });
  const child = fork(require.resolve('./lib/recoverable-build-child'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: sanitizedEnvironment(),
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const created = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', code => reject(new Error(`Worker exited before creation: ${code}`)));
  });
  child.send({ databaseUrl: db.url, config, runScript: fixture.runScript });
  assert.deepEqual(await created, { phase: 'created' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const resource = (await owner.read(sessionId)).resource.intent;
  const before = await images.inspect(resource);
  assert.ok(before.uid, 'actual API must expose the created Build');
  await db.pool.query('UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL \'1 second\' WHERE id = $1', [admitted.work.id]);
  const handler = work.handlers[PREPARE_RUNTIME];
  const deadline = Date.now() + 1000 * (resource.buildOperation.activeDeadlineSeconds + 120);
  let complete = false;
  while (!complete && Date.now() < deadline) {
    await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [admitted.work.id]);
    const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME], 1);
    try {
      const result = await handler.run({ attempt, signal: new AbortController().signal,
        checkpoint: value => work.store.checkpoint(attempt, value) });
      await work.store.settle(attempt, result, handler.commit);
      complete = result.outcome === 'succeeded';
      if (complete) assert.equal(result.result.prepared, true, JSON.stringify(result));
    } catch (error) {
      await work.store.settle(attempt, { outcome: 'retry', checkpoint: (await work.store.read(attempt.id)).checkpoint });
      if (!lostReply || !/Injected reply loss/.test(error.message)) throw error;
    }
    if (!complete) await delay(1000);
  }
  assert.ok(complete, 'real kpack Build must complete before its bounded integration deadline');
  const current = await owner.read(sessionId);
  assert.equal(current.flow.state, 'candidate');
  assert.equal(current.preview.runtimeName, 'serving');
  assert.equal(current.binding, null);
  assert.equal(current.resource.intent.buildOperation.receipt.uid, before.uid);
  assert.equal(lostReply, true);
  const after = await images.inspect(current.resource.intent);
  assert.equal(after.status, 'succeeded');
  assert.equal(after.uid, before.uid);
  assert.equal(after.imageRef, current.resource.intent.buildOperation.receipt.imageRef);
  assert.equal((await images.retire(current.resource.intent)).status, 'retained');
  t.diagnostic(`Verified interrupted Build ${before.uid}, output ${after.imageRef}`);
  const expected = buildManifest(current.resource.intent);
  const build = await kubernetes.readBuild({ kubernetes: { buildNamespace: expected.metadata.namespace } }, expected.metadata.name);
  assert.equal(build.metadata.uid, before.uid);
  // Explicit test teardown after the creator was joined and output verified.
  // Production retirement deliberately retains this terminal Build instead.
  await kubernetes.deleteBuildSnapshot({ kubernetes: { buildNamespace: expected.metadata.namespace } }, build);
});

async function actualFixture(t, runScript) {
  const { fixture, clients } = await verifyIsolatedBuildFixture();
  kubernetes._setClientsForTest(clients);
  t.after(() => kubernetes._setClientsForTest(new Proxy({}, {
    get() { throw new Error('Isolated test ended; ambient Kubernetes clients are forbidden'); },
  })));
  const db = await createExecutionDatabase(fixture.isolation.database.url);
  t.after(() => db.close());
  const config = {
    ...fixture.config, nativeCliPreviewHandoffEnabled: true, kubernetes: { ...fixture.config.kubernetes }, databaseUrl: db.url, dataEncryptionKey: 'disposable-integration-only',
  };
  const sessionId = 4000000 + process.pid;
  await db.pool.query('UPDATE apps SET repo_url = $1 WHERE id = 1', [fixture.repoUrl]);
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1, $2)', [sessionId, fixture.revision]);
  const owner = createPreviewFlow(db.pool);
  const images = createImageBuildOperations({ clients: () => clients });
  let deployments = 0;
  const work = createCompletePreviewWork(db.pool, config, {
    owner, images,
    clones: { prepare: async () => ({ status: 'complete', databaseOid: '123' }) },
    async prepare(_config, _session, _app, head, candidate) {
      await candidate.prepareClone();
      const built = await candidate.prepareImage(runScript);
      const deployed = await candidate.prepareRuntime({ imageRef: built.imageRef, env: {} });
      deployments++;
      return { ...deployed, commitSha: head, stagingUrl: deployed.url };
    },
  });
  async function admit() {
    return work.request({
      type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId,
      headSha: fixture.revision, startedStatus: 'active',
    });
  }
  async function pollWork(id) {
    const deadline = Date.now() + 1000 * (config.kubernetes.activeDeadlineSeconds + 120);
    const handler = work.handlers[PREPARE_RUNTIME];
    while (Date.now() < deadline) {
      await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [id]);
      const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME], 1);
      assert.ok(attempt, 'eligible work must be claimable');
      const result = await handler.run({
        attempt, signal: new AbortController().signal,
        checkpoint: value => work.store.checkpoint(attempt, value),
      });
      const settled = await work.store.settle(attempt, result, handler.commit);
      if (result.outcome === 'succeeded') return settled;
      await delay(1000);
    }
    assert.fail('Actual Build exceeded bounded integration deadline');
  }
  return { ...db, fixture, clients, config, owner, images, work, sessionId, admit, pollWork, deployments: () => deployments };
}

async function waitForTerminal(images, intent) {
  const deadline = Date.now() + 1000 * (intent.buildOperation.activeDeadlineSeconds + 120);
  while (Date.now() < deadline) {
    const observed = await images.inspect(intent);
    if (observed.status === 'succeeded' || observed.status === 'failed') return observed;
    assert.equal(observed.status, 'running', JSON.stringify(observed));
    await delay(1000);
  }
  assert.fail('Actual Build did not reach a verified terminal state');
}

test('actual kpack + PostgreSQL: an ordinary terminal build failure retires preparation without deployment', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  // Paketo skips script names missing from package.json. Instead pin a version
  // with no available Node distribution: a deterministic recipe failure in the
  // real build container, without changing the source or injecting Pod status.
  const f = await actualFixture(t, null);
  f.config.kubernetes.nodeVersion = '0.0.0';
  const admitted = await f.admit();
  const result = await f.pollWork(admitted.work.id);
  assert.equal(result.code, 'image_failed_build');
  assert.equal(result.result.prepared, false);
  assert.equal(result.result.accepted, true);
  assert.equal(f.deployments(), 0);
  const current = await f.owner.read(f.sessionId);
  assert.equal(current.flow.state, 'failed');
  assert.equal(current.preview.runtimeName, 'serving');
  assert.equal(current.binding, null);
  const terminal = await f.images.inspect(current.resource.intent);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.failureKind, 'build');
  assert.equal((await f.images.retire(current.resource.intent)).status, 'retained');
  t.diagnostic(`Verified terminal failure for Build ${terminal.uid}`);
});

test('actual kpack + PostgreSQL: delayed creation after absent cleanup remains discoverable; lost create reply adopts the successor', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  const f = await actualFixture(t, null);
  const admitted = await f.admit();
  const [claim] = await f.work.store.claim(randomUUID(), [PREPARE_RUNTIME], 1);
  assert.equal(claim.id, admitted.work.id);

  async function authorizeImage(runScript) {
    const state = await f.owner.read(f.sessionId);
    const identity = {
      sessionId: f.sessionId, flowId: state.flow.id, generation: state.flow.generation,
      headSha: state.flow.headSha, operationId: state.resource.intent.attemptId,
    };
    // Clone I/O is injected in this build-only checkpoint. Report its completion
    // through the same validated action contract used by the worker.
    const clone = await f.owner.apply({ type: 'CandidateClonePrepared', actionId: randomUUID(), ...identity, databaseOid: '123' });
    assert.equal(clone.decision.accepted, true);
    const image = await f.owner.apply({ type: 'RequestCandidateImageBuild', actionId: randomUUID(), ...identity, runScript });
    assert.equal(image.decision.accepted, true);
    return { identity, intent: image.decision.effects.find(effect => effect.type === 'PrepareCandidateImage').intent };
  }

  const old = await authorizeImage('build');
  let releaseCreate;
  let sawSubmission;
  const submitted = new Promise(resolve => { sawSubmission = resolve; });
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const delayedClients = {
    ...f.clients,
    custom: new Proxy(f.clients.custom, {
      get(target, key) {
        if (key === 'createNamespacedCustomObject') return async (...args) => {
          sawSubmission();
          await gate;
          return target[key](...args);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  const delayedImages = createImageBuildOperations({ clients: () => delayedClients });
  // Deterministic interruption at the service boundary, followed by an actual
  // Kubernetes POST. This is not a simulation of API-server network timing.
  const creation = delayedImages.prepare(old.intent, {
    checkpoint: value => f.work.store.checkpoint(claim, { imageSubmitted: value.submitted, imageUid: value.uid }),
  });
  const joined = creation.then(value => ({ value }), error => ({ error }));
  t.after(async () => { releaseCreate(); await joined; });
  await submitted;
  const failed = await f.owner.apply({
    type: 'PreparationFailed', actionId: randomUUID(),
    sessionId: f.sessionId, flowId: old.identity.flowId,
    generation: old.identity.generation, headSha: old.identity.headSha,
    detail: 'Retire after injected worker interruption at creation boundary',
  });
  assert.equal(failed.decision.accepted, true);
  const cleanup = require('../src/services/preview-flow/cleanup').createCleanup({
    images: f.images, clones: { remove: async () => ({ status: 'removed' }) },
  });
  // No clone or checkout was created by this build-only scenario.
  t.mock.method(require('../src/services/docker'), 'execFileAsync', async () => {});
  const cleanupRequest = { pool: f.pool, config: f.config, sessionId: f.sessionId, flowId: old.identity.flowId };
  await cleanup.underBuildLock(cleanupRequest);
  const absentCleanup = (await f.pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1', [old.identity.flowId])).rows[0];
  assert.ok(absentCleanup.cleanup_completed_at);
  assert.equal((await f.images.inspect(old.intent)).status, 'absent');
  await f.work.census();
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM execution_work_requests WHERE workflow = 'native-preview-retire' AND input->>'flowId' = $1", [old.identity.flowId])).rows[0].n, 1);

  await f.admit();
  const successor = await authorizeImage(null);
  let creates = 0;
  const lostReplyClients = {
    ...f.clients,
    custom: new Proxy(f.clients.custom, {
      get(target, key) {
        if (key === 'createNamespacedCustomObject') return async (...args) => {
          creates++;
          await target[key](...args);
          throw new Error('Injected acknowledgment loss after actual API acceptance');
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  const recoveringImages = createImageBuildOperations({ clients: () => lostReplyClients });
  let checkpoint = {};
  const persist = async value => { checkpoint = { ...checkpoint, ...value }; return {}; };
  await assert.rejects(recoveringImages.prepare(successor.intent, { checkpoint: persist }), /acknowledgment loss/);
  const adopted = await recoveringImages.prepare(successor.intent, { ...checkpoint, checkpoint: persist });
  assert.ok(adopted.uid);
  assert.equal(creates, 1);
  releaseCreate();
  const late = await joined;
  if (late.error) throw late.error;
  const observedOld = await f.images.inspect(old.intent);
  assert.ok(observedOld.uid, 'late real resource exists after absence was recorded');
  assert.equal((await f.images.retire(old.intent)).status, 'pending');
  await assert.rejects(cleanup.underBuildLock(cleanupRequest), /build may still be running/);
  const terminalOld = await waitForTerminal(f.images, old.intent);
  assert.ok(['succeeded', 'failed'].includes(terminalOld.status));
  await cleanup.underBuildLock(cleanupRequest);
  const terminalSuccessor = await waitForTerminal(recoveringImages, successor.intent);
  assert.equal(terminalSuccessor.status, 'succeeded');
  assert.equal(terminalSuccessor.uid, adopted.uid);
  assert.equal(creates, 1);
  const current = await f.owner.read(f.sessionId);
  assert.equal(current.flow.id, successor.identity.flowId);
  assert.equal(current.resource.cleanupStarted, false);
  assert.equal(current.preview.runtimeName, 'serving');
  assert.equal(current.binding, null);
  assert.equal((await f.images.inspect(old.intent)).uid, observedOld.uid);
  t.diagnostic(`Late Build ${observedOld.uid} retained; successor ${adopted.uid} preserved at ${terminalSuccessor.imageRef}`);
});

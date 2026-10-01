'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { createExecutionDatabase } = require('./execution-database');
const { runtimeTestWorker, SERVER_COMMAND } = require('./runtime-test-worker');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { createPreviewFlow } = require('../../src/services/preview-flow/store');
const { PREPARE_RUNTIME, RETIRE } = require('../../src/services/preview-flow/work');
const { selectRuntime, runtimeManifests } = require('../../src/services/preview-flow/runtime-intent');
const kubernetes = require('../../src/services/kubernetes');

async function fixtureFor(t, configure = async () => ({})) {
  const { fixture, clients, databaseAddress } = await verifyIsolatedBuildFixture();
  assert.ok(fixture.runtimeImage, 'fixture must seed its own runtime image');
  kubernetes._setClientsForTest(clients);
  t.after(() => kubernetes._setClientsForTest(new Proxy({}, {
    get() { throw new Error('Ambient Kubernetes access is forbidden after isolated test'); },
  })));
  const db = await createExecutionDatabase(fixture.isolation.database.url);
  t.after(() => db.close());
  const sessionId = 6000000 + process.pid;
  await db.pool.query('UPDATE apps SET repo_url = $1 WHERE id = 1', [fixture.repoUrl]);
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1,$2)', [sessionId, fixture.revision]);
  const owner = createPreviewFlow(db.pool);
  const options = await configure({ ...db, fixture, clients, owner, sessionId, databaseAddress });
  const assembled = runtimeTestWorker(db.pool, fixture, clients, { owner, ...options.worker });

  // Independent actual serving resource: not managed by the candidate flow.
  const serving = {
    runtimeKind: 'kubernetes', namespace: fixture.isolation.namespace.name,
    attemptId: randomUUID(), runtimeName: `c5-serving-${randomUUID().slice(0, 8)}`,
    runtimeOperation: { kind: 'kubernetes-v1', resources: {} },
  };
  serving.runtimeOperation.desired = selectRuntime(assembled.config,
    { flowId: randomUUID(), generation: 1, headSha: fixture.revision },
    {
      imageRef: fixture.runtimeImage,
      env: { TOKEN: 'serving', ...options.servingEnvironment },
      command: options.worker?.command || SERVER_COMMAND,
    });
  const manifests = runtimeManifests(serving, assembled.config.dataEncryptionKey);
  await clients.core.createNamespacedSecret({ namespace: serving.namespace, body: manifests.secret });
  await clients.core.createNamespacedService({ namespace: serving.namespace, body: manifests.service });
  const servingDeployment = await clients.apps.createNamespacedDeployment({ namespace: serving.namespace, body: manifests.deployment });
  const deadline = Date.now() + 120000;
  while (!await assembled.probe(assembled.config, serving)) {
    assert.ok(Date.now() < deadline, 'actual serving resource must become healthy');
    await delay(1000);
  }
  await db.pool.query(`UPDATE chat_sessions SET staging_runtime_kind = 'kubernetes', staging_runtime_name = $2,
    staging_image_ref = $3, staging_url = $4 WHERE id = $1`, [sessionId, serving.runtimeName, fixture.runtimeImage,
    `http://${serving.runtimeName}.${serving.namespace}.svc:3000`]);
  const servingSpec = structuredClone(servingDeployment.spec);
  const projectionSql = `SELECT staging_url, staging_runtime_kind, staging_runtime_name,
    staging_image_ref, staging_container_id, staging_commit_sha, staging_build_ref
    FROM chat_sessions WHERE id = $1`;
  const servingProjection = (await db.pool.query(projectionSql, [sessionId])).rows[0];

  async function assertServing() {
    const current = await clients.apps.readNamespacedDeployment({ namespace: serving.namespace, name: serving.runtimeName });
    assert.equal(current.metadata.uid, servingDeployment.metadata.uid);
    assert.deepEqual(structuredClone(current.spec), servingSpec);
    assert.equal(await assembled.probe(assembled.config, serving), true);
    const state = await owner.read(sessionId);
    assert.equal(state.preview.runtimeName, serving.runtimeName);
    assert.equal(state.preview.imageRef, fixture.runtimeImage);
    assert.equal(state.binding, null);
    assert.deepEqual((await db.pool.query(projectionSql, [sessionId])).rows[0], servingProjection);
  }

  async function admit() {
    return assembled.work.request({
      type: 'RequestCandidatePreview',
      actionId: randomUUID(),
      sessionId,
      headSha: fixture.revision,
      startedStatus: 'active',
    });
  }

  async function poll(work, id) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [id]);
      const worker = createExecutionWorker({
        store: work.store,
        handlers: { [PREPARE_RUNTIME]: work.handlers[PREPARE_RUNTIME] },
        concurrency: 1,
      });
      await worker.tick();
      await worker.drain();
      const record = await work.store.read(id);
      if (record.status === 'succeeded') {
        assert.equal(record.result.prepared, true, JSON.stringify(record.result));
        assert.equal(record.result.accepted, true);
        return record;
      }
      assert.notEqual(record.status, 'blocked', JSON.stringify(record));
      await delay(1000);
    }
    assert.fail('Bounded runtime integration deadline exceeded');
  }

  return {
    ...db,
    ...assembled,
    ...options.evidence,
    fixture, clients, owner, sessionId, serving,
    assertServing, admit, poll,
  };
}

async function cleanupPass(f, work, flowId) {
  await work.census();
  const { rows: [request] } = await f.pool.query(`SELECT id FROM execution_work_requests
    WHERE workflow = $1 AND input->>'flowId' = $2`, [RETIRE, flowId]);
  assert.ok(request, 'retired attempt must retain a durable execution obligation');
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [request.id]);
  const worker = createExecutionWorker({
    store: work.store,
    handlers: { [RETIRE]: work.handlers[RETIRE] },
    concurrency: 1,
  });
  await worker.tick();
  await worker.drain();
  const record = await work.store.read(request.id);
  assert.notEqual(record.status, 'succeeded', 'runtime creator closure remains unresolved');
  return record;
}

async function assertCandidate(f, intent, expectedUids) {
  const observed = await f.runtimes.inspect(f.config, intent);
  assert.equal(observed.status, 'healthy', JSON.stringify(observed));
  assert.deepEqual(observed.uids, expectedUids);
  await f.assertServing();
}

module.exports = { fixtureFor, cleanupPass, assertCandidate };

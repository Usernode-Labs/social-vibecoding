'use strict';

// Real PostgreSQL admission/recovery; external observations below are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { verifyIsolatedBuildFixture } = require('./lib/isolated-kpack-fixture');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createRetainedPreviewWork } = require('./lib/retained-preview-work');
const { createPreviewWork, PREPARE, PREPARE_CLONE, PREPARE_IMAGE, PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { createExecutionWorker } = require('../src/services/execution/worker');

const isolated = process.env.RUN_ISOLATED_KPACK_TEST === '1';
const HEAD = 'a'.repeat(40);

async function fixture(t) {
  const verified = await verifyIsolatedBuildFixture();
  const db = await createExecutionDatabase(verified.fixture.isolation.database.url);
  t.after(() => db.close());
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1, $1)', [HEAD]);
  const config = {
    ...verified.fixture.config,
    databaseUrl: db.url,
    dataEncryptionKey: 'admission-fixture-only',
    nativeCliPreviewHandoffEnabled: true,
    nativePreviewAttempts: false,
  };
  const action = {
    type: 'RequestCandidatePreview',
    actionId: randomUUID(),
    sessionId: 1,
    headSha: HEAD,
    startedStatus: 'active',
  };
  return { ...db, config, action };
}

test('real PostgreSQL: new durable admission has one complete format without legacy opt-in', { skip: !isolated }, async t => {
  const f = await fixture(t);
  const owner = createPreviewWork(f.pool, f.config);
  const admitted = await owner.request(f.action);
  const { input } = admitted.work;
  assert.equal(admitted.work.workflow, PREPARE_RUNTIME);
  assert.equal(admitted.work.contract_version, 1);
  assert.equal(input.intent.runtimeKind, 'kubernetes');
  assert.equal(input.intent.cloneOperation.kind, 'template-v1');
  assert.equal(input.intent.buildOperation.kind, 'kpack-v1');
  assert.equal(input.intent.buildOperation.revision, HEAD);
  assert.deepEqual(input.intent.runtimeOperation, { kind: 'kubernetes-v1', resources: {} });
  const actionIds = ['preparedActionId', 'failedActionId', 'clonePreparedActionId', 'imageBuiltActionId'];
  assert.equal(new Set(actionIds.map(key => input[key])).size, actionIds.length);
  for (const key of actionIds) assert.match(input[key], /^[a-f0-9-]{36}$/);
  const resource = (await f.pool.query('SELECT * FROM preview_flow_resources')).rows[0];
  assert.ok(resource.clone_credential_enc);
  assert.deepEqual(resource.intent, input.intent);
  const replayed = await owner.request(f.action);
  assert.equal(replayed.work.id, admitted.work.id);
  assert.deepEqual(replayed.work.input, input);
  assert.equal((await f.pool.query('SELECT * FROM execution_work_requests')).rowCount, 1);
  assert.equal(require('../src/services/preview-flow/activation').enabled(f.config), false);
});

for (const enabled of [undefined, false]) {
  test(`real PostgreSQL: ${enabled === undefined ? 'unset' : 'disabled'} admission rejects without writes`, { skip: !isolated }, async t => {
    const f = await fixture(t);
    f.config.nativeCliPreviewHandoffEnabled = enabled;
    f.config.nativePreviewAttempts = true;
    const owner = createPreviewWork(f.pool, f.config);
    await assert.rejects(owner.request(f.action), /experimentally disabled/);
    for (const table of ['preview_flows', 'preview_flow_resources', 'preview_action_receipts',
      'preview_flow_decisions', 'execution_work_requests', 'execution_work_events']) {
      assert.equal((await f.pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    }
  });
}

for (const workflow of [PREPARE, PREPARE_CLONE, PREPARE_IMAGE]) {
  test(`real PostgreSQL: retained ${workflow} completes with new admission disabled`, { skip: !isolated }, async t => {
    const f = await fixture(t);
    f.config.nativeCliPreviewHandoffEnabled = false;
    const retained = createRetainedPreviewWork(f.pool, f.config, { workflow });
    const admitted = await retained.seedRetained(f.action);
    const imageRef = `${f.config.kubernetes.repositoryPrefix}/demo@sha256:${'b'.repeat(64)}`;
    let preparations = 0;
    const recovery = createPreviewWork(f.pool, f.config, {
      lock: async (_config, _classifier, _sessionId, run) => run(),
      inspect: async () => ({ present: false, receipt: null }),
      clones: {
        prepare: async () => ({ status: 'complete', databaseOid: '123' }),
      },
      images: {
        prepare: async intent => ({
          status: 'succeeded',
          uid: 'retained-build',
          imageRef,
          buildRef: `${intent.buildOperation.namespace}/sv-p-${intent.attemptId.replaceAll('-', '')}`,
        }),
      },
      async prepare(_config, _session, _app, headSha, candidate) {
        preparations++;
        const image = candidate.prepareImage ? await candidate.prepareImage(null) : { imageRef, buildRef: null };
        if (candidate.onRuntimeStarting) await candidate.onRuntimeStarting();
        await candidate.onClonePrepared();
        return {
          commitSha: headSha,
          stagingUrl: `http://${candidate.intent.runtimeName}:3000`,
          runtimeKind: 'kubernetes',
          runtimeName: candidate.intent.runtimeName,
          containerId: null,
          physicalId: randomUUID(),
          ...image,
        };
      },
    });
    await assert.rejects(recovery.request({ ...f.action, actionId: randomUUID() }), /experimentally disabled/);
    const worker = createExecutionWorker({ store: recovery.store, handlers: recovery.handlers, concurrency: 1 });
    await worker.tick();
    await worker.drain();
    const completed = await recovery.store.read(admitted.work.id);
    assert.equal(completed.workflow, workflow);
    assert.deepEqual(completed.input, admitted.work.input);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.result.accepted, true);
    assert.equal(preparations, 1);
    assert.equal((await f.pool.query('SELECT staging_runtime_name FROM chat_sessions')).rows[0].staging_runtime_name, 'serving');
    assert.equal((await f.pool.query('SELECT * FROM execution_work_requests')).rowCount, 1);
  });
}

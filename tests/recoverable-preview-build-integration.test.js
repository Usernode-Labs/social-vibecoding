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
const { createPreviewWork, PREPARE_IMAGE } = require('../src/services/preview-flow/work');
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
  const config = fixture.config;
  const db = await createExecutionDatabase(fixture.isolation.database.url);
  t.after(() => db.close());
  const sessionId = 3000000 + process.pid;
  config.databaseUrl = db.url;
  config.dataEncryptionKey = 'disposable-integration-only';
  config.nativePreviewWorkerEnabled = true;
  config.nativePreviewAttempts = true;
  config.nativePreviewRecoverableClone = true;
  config.nativePreviewRecoverableBuild = true;
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
  const work = createPreviewWork(db.pool, config, {
    owner,
    images,
    clones: { prepare: async () => ({ status: 'complete', databaseOid: '123' }) },
    inspect: async () => ({ present: false, receipt: null }),
    async prepare(_config, _session, _app, head, candidate) {
      const built = await candidate.prepareImage(fixture.runScript);
      await candidate.onRuntimeStarting();
      // Real image build, injected runtime deployment. This proves no routing.
      return {
        runtimeKind: 'kubernetes', runtimeName: candidate.intent.runtimeName,
        containerId: null, physicalId: randomUUID(), commitSha: head,
        stagingUrl: `http://${candidate.intent.runtimeName}:3000`,
        imageRef: built.imageRef, buildRef: built.buildRef,
      };
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
  const handler = work.handlers[PREPARE_IMAGE];
  const deadline = Date.now() + 1000 * (resource.buildOperation.activeDeadlineSeconds + 120);
  let complete = false;
  while (!complete && Date.now() < deadline) {
    await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [admitted.work.id]);
    const [attempt] = await work.store.claim(randomUUID(), [PREPARE_IMAGE], 1);
    try {
      const result = await handler.run({ attempt, signal: new AbortController().signal,
        checkpoint: value => work.store.checkpoint(attempt, value) });
      await work.store.settle(attempt, result, handler.commit);
      complete = result.outcome === 'succeeded';
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
  const expected = buildManifest(current.resource.intent);
  const build = await kubernetes.readBuild({ kubernetes: { buildNamespace: expected.metadata.namespace } }, expected.metadata.name);
  assert.equal(build.metadata.uid, before.uid);
  // Explicit test teardown after the creator was joined and output verified.
  // Production retirement deliberately retains this terminal Build instead.
  await kubernetes.deleteBuildSnapshot({ kubernetes: { buildNamespace: expected.metadata.namespace } }, build);
});

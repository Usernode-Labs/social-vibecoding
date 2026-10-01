'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { verifyIsolatedBuildFixture, sanitizedEnvironment } = require('./lib/isolated-kpack-fixture');
const { createExecutionDatabase } = require('./lib/execution-database');
const { completePreparationWorker } = require('./lib/complete-preparation-worker');
const { cleanupPass } = require('./lib/runtime-integration-fixture');
const { SERVER_COMMAND } = require('./lib/runtime-test-worker');
const { createExecutionWorker } = require('../src/services/execution/worker');
const { PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { selectRuntime, runtimeManifests } = require('../src/services/preview-flow/runtime-intent');
const { decrypt } = require('../src/services/secrets');
const { credentialUrl } = require('./lib/database-runtime-fixture');

async function fixtureFor(t) {
  const verified = await verifyIsolatedBuildFixture();
  assert.ok(verified.fixture.preparationSource && verified.fixture.runtimeImage && verified.databaseAddress);
  require('../src/services/kubernetes')._setClientsForTest(verified.clients);
  const db = await createExecutionDatabase(verified.fixture.isolation.database.url);
  const assembled = completePreparationWorker(db.pool, verified);
  t.after(() => assembled.restore());
  const sessionId = 7000000 + process.pid;
  const source = verified.fixture.preparationSource;
  await db.pool.query(`CREATE TABLE app_secrets (app_id INTEGER, key TEXT, value_enc TEXT);
    ALTER TABLE pending_secret_declarations ADD COLUMN key TEXT,
      ADD COLUMN declaration JSONB, ADD COLUMN value_enc TEXT`);
  await db.pool.query('UPDATE apps SET repo_url = $1 WHERE id = 1', [source.repoUrl]);
  await db.pool.query(`INSERT INTO chat_sessions (id, checks_commit_sha, branch_name, pr_number)
    VALUES ($1,$2,$3,NULL)`, [sessionId, source.revision, source.branch]);

  const admin = new Client({ connectionString: verified.fixture.isolation.database.url });
  await admin.connect();
  await admin.query('CREATE ROLE app_demo_stgtmpl_owner NOLOGIN');
  await admin.query('CREATE DATABASE app_demo_stgtmpl TEMPLATE template0 OWNER app_demo_stgtmpl_owner');
  const seedUrl = new URL(verified.fixture.isolation.database.url);
  seedUrl.pathname = '/app_demo_stgtmpl';
  const seed = new Client({ connectionString: seedUrl.toString() });
  await seed.connect();
  await seed.query('CREATE TABLE evidence (value TEXT)');
  await seed.query('INSERT INTO evidence VALUES ($1)', [verified.fixture.isolation.fixtureId]);
  await seed.query('ALTER TABLE evidence OWNER TO app_demo_stgtmpl_owner');
  await seed.end();
  await admin.query('ALTER DATABASE app_demo_stgtmpl ALLOW_CONNECTIONS false');
  t.after(async () => {
    // Exact recorded attempt names only, in the preflight-verified disposable DB.
    const { rows } = await db.pool.query('SELECT intent FROM preview_flow_resources');
    for (const { intent } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${intent.dbName} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${intent.dbName}_owner`);
    }
    await admin.query('DROP DATABASE app_demo_stgtmpl WITH (FORCE)');
    await admin.query('DROP ROLE app_demo_stgtmpl_owner');
    await admin.end();
    await require('../src/db/pool').getPool(assembled.config).end();
    await db.close();
    require('../src/services/kubernetes')._setClientsForTest(new Proxy({}, {
      get() { throw new Error('Ambient Kubernetes access forbidden after fixture'); },
    }));
  });

  const serving = {
    runtimeKind: 'kubernetes', namespace: verified.fixture.isolation.namespace.name,
    attemptId: randomUUID(), runtimeName: `c7-serving-${randomUUID().slice(0, 8)}`,
    runtimeOperation: { kind: 'kubernetes-v1', resources: {} },
  };
  serving.runtimeOperation.desired = selectRuntime(assembled.config,
    { flowId: randomUUID(), generation: 1, headSha: source.revision }, {
      imageRef: verified.fixture.runtimeImage, env: { TOKEN: 'serving' }, command: SERVER_COMMAND,
    });
  const manifests = runtimeManifests(serving, assembled.config.dataEncryptionKey);
  await verified.clients.core.createNamespacedSecret({ namespace: serving.namespace, body: manifests.secret });
  await verified.clients.core.createNamespacedService({ namespace: serving.namespace, body: manifests.service });
  const servingDeployment = await verified.clients.apps.createNamespacedDeployment({ namespace: serving.namespace, body: manifests.deployment });
  const servingDeadline = Date.now() + 120000;
  while (!await assembled.probe(assembled.config, serving)) {
    assert.ok(Date.now() < servingDeadline, 'Serving sentinel must become healthy');
    await delay(1000);
  }
  await db.pool.query(`UPDATE chat_sessions SET staging_runtime_kind = 'kubernetes', staging_runtime_name = $2,
    staging_image_ref = $3, staging_url = $4 WHERE id = $1`, [sessionId, serving.runtimeName,
    verified.fixture.runtimeImage, `http://${serving.runtimeName}.${serving.namespace}.svc:3000`]);
  const projectionSql = `SELECT staging_url, staging_runtime_kind, staging_runtime_name,
    staging_image_ref, staging_container_id, staging_commit_sha, staging_build_ref
    FROM chat_sessions WHERE id = $1`;
  const projection = (await db.pool.query(projectionSql, [sessionId])).rows[0];

  async function assertServing() {
    const current = await verified.clients.apps.readNamespacedDeployment({ namespace: serving.namespace, name: serving.runtimeName });
    assert.equal(current.metadata.uid, servingDeployment.metadata.uid);
    assert.deepEqual(structuredClone(current.spec), structuredClone(servingDeployment.spec));
    assert.equal(await assembled.probe(assembled.config, serving), true);
    assert.deepEqual((await db.pool.query(projectionSql, [sessionId])).rows[0], projection);
    assert.equal((await assembled.owner.read(sessionId)).binding, null);
  }

  async function admit() {
    return assembled.work.request({
      type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId,
      headSha: source.revision, startedStatus: 'active',
    });
  }

  return { ...verified, ...db, ...assembled, sessionId, serving, assertServing, admit };
}

async function identities(f, flowId) {
  const intent = await f.owner.readResourceIntent(f.sessionId, flowId);
  const clone = await f.clones.inspect(intent);
  const image = Object.hasOwn(intent.buildOperation, 'runScript') ? await f.images.inspect(intent) : null;
  let runtimeUids = {};
  if (intent.runtimeOperation.desired) {
    const runtime = await f.runtimes.inventory(intent);
    assert.equal(runtime.status, 'inspected');
    runtimeUids = Object.fromEntries(Object.entries(runtime.resources).map(([kind, object]) => [kind, object?.metadata.uid || null]));
  } else {
    for (const [api, method, name] of [
      [f.clients.core, 'readNamespacedSecret', `${intent.runtimeName}-env`],
      [f.clients.core, 'readNamespacedService', intent.runtimeName],
      [f.clients.apps, 'readNamespacedDeployment', intent.runtimeName],
    ]) {
      await assert.rejects(api[method]({ namespace: intent.namespace, name }), error => error.code === 404);
    }
  }
  return {
    databaseOid: clone.databaseOid || null,
    buildUid: image?.uid || null,
    imageRef: image?.imageRef || null,
    runtimeUids,
  };
}

function assertAdopted(before, after) {
  for (const key of ['databaseOid', 'buildUid', 'imageRef']) {
    if (before[key]) assert.equal(after[key], before[key], `${key} must be adopted`);
  }
  for (const [kind, uid] of Object.entries(before.runtimeUids)) {
    if (uid) assert.equal(after.runtimeUids[kind], uid, `${kind} must be adopted`);
  }
}

async function tick(work) {
  const worker = createExecutionWorker({
    store: work.store, handlers: { [PREPARE_RUNTIME]: work.handlers[PREPARE_RUNTIME] }, concurrency: 1,
  });
  await worker.tick();
  await worker.drain();
}

async function poll(f, work, id) {
  const deadline = Date.now() + 900000;
  while (Date.now() < deadline) {
    await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [id]);
    await tick(work);
    const record = await work.store.read(id);
    if (record.status === 'succeeded') {
      assert.equal(record.result.prepared, true, JSON.stringify(record));
      assert.equal(record.result.accepted, true, JSON.stringify(record));
      return record;
    }
    assert.notEqual(record.status, 'blocked', JSON.stringify(record));
    await delay(1000);
  }
  assert.fail('Complete preparation exceeded bounded deadline');
}

async function interrupt(t, f, workId, phase) {
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [workId]);
  const child = fork(require.resolve('./lib/complete-preparation-child'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: sanitizedEnvironment(),
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const paused = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', code => reject(new Error(`Worker exited before ${phase}: ${code}`)));
  });
  child.send({ databaseUrl: f.url, pauseAt: phase });
  assert.deepEqual(await paused, { phase });
  const state = await f.owner.read(f.sessionId);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  // The paused clone creator still owns its advisory lock. Inspect only after
  // its process has exited, without running another preparation operation.
  const observed = await identities(f, state.flow.id);
  await f.pool.query(`UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'
    WHERE id = $1 AND status = 'running'`, [workId]);
  await f.assertServing();
  return observed;
}

async function assertComplete(f, admitted, before) {
  const state = await f.owner.read(f.sessionId);
  assert.equal(state.flow.id, admitted.decision.flow.id);
  assert.equal(state.flow.state, 'candidate');
  assert.equal(state.resource.clonePrepared, true);
  const after = await identities(f, state.flow.id);
  assertAdopted(before, after);
  assert.ok(after.databaseOid && after.buildUid && after.imageRef);
  assert.ok(Object.values(after.runtimeUids).every(Boolean));
  assert.equal((await f.runtimes.inspect(f.config, state.resource.intent)).status, 'healthy');
  assert.deepEqual(state.resource.intent.runtimeOperation.desired.command, [], 'Run actual Build output with its native launcher');
  const { rows: [resource] } = await f.pool.query('SELECT clone_credential_enc FROM preview_flow_resources WHERE flow_id = $1', [state.flow.id]);
  const password = decrypt(resource.clone_credential_enc, f.config.dataEncryptionKey);
  const env = JSON.parse(decrypt(state.resource.intent.runtimeOperation.desired.environmentEnc, f.config.dataEncryptionKey));
  assert.equal(env.DATABASE_URL, credentialUrl(f.fixture, state.resource.intent, password, f.databaseAddress));
  const client = new Client({ connectionString: credentialUrl(f.fixture, state.resource.intent, password), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    assert.equal((await client.query('SELECT value FROM evidence')).rows[0].value, f.fixture.isolation.fixtureId);
  } finally { await client.end(); }
  await f.assertServing();
  return { state, identities: after };
}

test('C7 actual staging → clone → kpack → runtime: phase recovery, lost replies and predecessor retirement', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  const f = await fixtureFor(t);
  const admitted = await f.admit();
  let before = { runtimeUids: {} };
  for (const phase of ['source_prepared', 'clone_complete', 'build_succeeded', 'created_secret', 'healthy', 'accepted']) {
    const observed = await interrupt(t, f, admitted.work.id, phase);
    assertAdopted(before, observed);
    before = observed;
    t.diagnostic(`SIGKILL at ${phase}: ${JSON.stringify(observed)}`);
  }
  await poll(f, f.work, admitted.work.id);
  const old = await assertComplete(f, admitted, before);

  const inFlight = await f.admit();
  const inFlightObserved = await interrupt(t, f, inFlight.work.id, 'build_created');
  assert.ok(inFlightObserved.databaseOid && inFlightObserved.buildUid);
  const inFlightState = await f.owner.read(f.sessionId);
  assert.equal(inFlightState.flow.state, 'preparing');

  // A distinct complete attempt injects lost acknowledgments after real writes.
  // It is a successor in the same aggregate; serving pointers remain unchanged.
  f.restore();
  const recovery = completePreparationWorker(f.pool, f, { owner: f.owner, loseReplies: true });
  t.after(() => recovery.restore());
  const next = await f.admit();
  await poll(f, recovery.work, next.work.id);
  const successor = await assertComplete(f, next, { runtimeUids: {} });
  assert.deepEqual([...recovery.lost].sort(), ['accepted', 'build_created', 'clone_complete', 'created_service', 'runtime_receipt'].sort());
  assert.deepEqual(recovery.counts, { cloneCopies: 1, build: 1, secret: 1, service: 1, deployment: 1 });
  assert.deepEqual([...recovery.cloneOids], [successor.identities.databaseOid]);
  const firstSource = recovery.events.indexOf('source_prepared');
  const cloneCompletion = recovery.events.indexOf('clone_complete');
  const buildCreation = recovery.events.indexOf('build_created');
  assert.ok(firstSource >= 0 && firstSource < cloneCompletion && cloneCompletion < buildCreation);
  assert.notEqual(successor.identities.databaseOid, old.identities.databaseOid);
  assert.notEqual(successor.identities.buildUid, old.identities.buildUid);

  const deadline = Date.now() + 120000;
  let cleanup;
  do {
    cleanup = await cleanupPass(f, recovery.work, old.state.flow.id);
    await delay(500);
    assert.ok(Date.now() < deadline, 'Owned predecessor runtime and database must retire');
  } while (!cleanup.result?.databaseReleased);
  const retiredIntent = await f.owner.readResourceIntent(f.sessionId, old.state.flow.id);
  assert.equal((await f.clones.inspect(retiredIntent)).status, 'retired');
  const retiredRuntime = await f.runtimes.inventory(retiredIntent, { retiring: true });
  assert.ok(Object.values(retiredRuntime.resources).every(object => object === null));
  assert.equal((await f.pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1', [old.state.flow.id])).rows[0].cleanup_completed_at, null);
  await cleanupPass(f, recovery.work, old.state.flow.id);
  await assertComplete(f, next, successor.identities);

  // A superseded preparation cannot finish or create its runtime even when its
  // existing external Build continues. Cleanup waits for terminal Build state.
  await pollObsolete(f, recovery.work, inFlight.work.id);
  const stale = await f.owner.apply({
    type: 'RequestCandidateClone', actionId: randomUUID(), sessionId: f.sessionId,
    flowId: inFlightState.flow.id, generation: inFlightState.flow.generation,
    headSha: inFlightState.flow.headSha, operationId: inFlightState.resource.intent.attemptId,
  });
  assert.equal(stale.decision.accepted, false);
  const retirementDeadline = Date.now() + 900000;
  while ((await f.clones.inspect(inFlightState.resource.intent)).status !== 'retired') {
    await cleanupPass(f, recovery.work, inFlightState.flow.id);
    assert.ok(Date.now() < retirementDeadline, 'Superseded Build must settle before clone release');
    await delay(1000);
  }
  const retiredPreparation = await identities(f, inFlightState.flow.id);
  assert.equal(retiredPreparation.buildUid, inFlightObserved.buildUid, 'Retirement must retain the original Build');
  assert.deepEqual(retiredPreparation.runtimeUids, {}, 'Superseded preparation must never create a runtime');
  await assertComplete(f, next, successor.identities);
  t.diagnostic(`Superseded in-flight preparation ${JSON.stringify(inFlightObserved)} retired without candidate runtime or successor changes`);
  t.diagnostic(`Lost replies adopted one Build and runtime: ${JSON.stringify(successor.identities)}; predecessor released, serving ${f.serving.runtimeName} unchanged; late-creation obligation retained`);
});

async function pollObsolete(f, work, id) {
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [id]);
  await tick(work);
  const record = await work.store.read(id);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.result.prepared, false);
  assert.equal(record.result.accepted, false);
}

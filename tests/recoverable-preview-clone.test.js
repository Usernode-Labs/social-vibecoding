'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const { createExecutionDatabase } = require('./lib/execution-database');
const { candidateResources } = require('../src/services/preview-flow/candidate-resources');
const { createCloneOperations } = require('../src/services/preview-flow/clone-operation');
const { createPreviewWork, PREPARE, PREPARE_CLONE } = require('../src/services/preview-flow/work');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { createExecutionWorker } = require('../src/services/execution/worker');
const { replayDecision } = require('../src/services/preview-flow/reducer');

const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL;
const HEAD = 'a'.repeat(40);
const password = '1'.repeat(48);

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'expected database state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function resources(t) {
  const url = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'disposable local PostgreSQL only');
  url.searchParams.delete('options');
  url.pathname = '/postgres';
  const clients = [];
  const databases = new Set();
  const roles = new Set();
  async function connect(database) {
    const target = new URL(url);
    target.pathname = `/${database}`;
    const client = new Client({ connectionString: target.toString() });
    clients.push(client);
    await client.connect();
    return client;
  }
  const admin = await connect('postgres');
  const sourceDb = `app_clone_${randomBytes(4).toString('hex')}`;
  const template = `${sourceDb}_stgtmpl`;
  const templateRole = `${template}_owner`;
  databases.add(template);
  roles.add(templateRole);
  t.after(async () => {
    for (const client of clients.filter(value => value !== admin)) await client.end().catch(() => {});
    for (const database of databases) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  await admin.query(`CREATE ROLE ${templateRole} NOLOGIN`);
  await admin.query(`CREATE DATABASE ${template} TEMPLATE template0 OWNER ${templateRole}`);
  const seed = await connect(template);
  await seed.query(`CREATE TABLE people (id serial PRIMARY KEY, name text, secret text);
    INSERT INTO people(name, secret) VALUES ('Ada', 'production secret');
    COMMENT ON COLUMN people.secret IS 'staging:private';
    CREATE TABLE private_data (id serial PRIMARY KEY, secret text);
    INSERT INTO private_data(secret) VALUES ('must disappear');
    COMMENT ON TABLE private_data IS 'staging:private';
    ALTER TABLE people OWNER TO ${templateRole};
    ALTER TABLE private_data OWNER TO ${templateRole}`);
  await seed.end();
  await admin.query(`COMMENT ON DATABASE ${template} IS 'staging-template source=${sourceDb} refreshed_at=${new Date().toISOString()}'`);
  await admin.query(`ALTER DATABASE ${template} ALLOW_CONNECTIONS false`);

  function intent(attemptId = randomUUID()) {
    const value = {
      ...candidateResources({ appRuntime: 'docker' }, 1, attemptId),
      cloneOperation: { kind: 'template-v1', sourceDb },
    };
    remember(value);
    return value;
  }
  function remember(value) {
    databases.add(value.dbName);
    roles.add(`${value.dbName}_owner`);
  }
  function operations(options = {}) {
    return createCloneOperations({
      databaseUrl: url.toString(),
      maintenanceDatabase: 'postgres',
      // Selection of a seeded template is injected; copy and finalization are
      // real PostgreSQL. Source-template refresh is outside this contract.
      ensureTemplate: async source => ({ template: `${source}_stgtmpl` }),
      ...options,
    });
  }
  return { admin, sourceDb, templateRole, connect, intent, remember, operations, url: url.toString() };
}

async function interrupted(resource, intent, phase, verify, work = {}) {
  const child = fork(require.resolve('./lib/clone-operation-child'), {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: [],
  });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  try {
    const message = once(child, 'message');
    child.send({ databaseUrl: resource.url, intent, password, stopAfter: phase, ...work });
    const [received] = await message;
    assert.deepEqual(received, { phase }, errors);
    await verify?.();
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await waitFor(async () => (await resource.admin.query(`SELECT 1 FROM pg_stat_activity
    WHERE application_name = 'preview-template-operation' AND datname = $1`, [intent.dbName])).rowCount === 0);
}

for (const phase of ['copy_committed', 'ownership_changed', 'before_finalize_commit', 'finalize_committed']) {
  test(`real clone: process interruption at ${phase} recovers the same physical database`, { skip: !databaseUrl }, async t => {
    const resource = await resources(t);
    const intent = resource.intent();
    let oid;
    await interrupted(resource, intent, phase, async () => {
      oid = (await resource.admin.query('SELECT oid::text FROM pg_database WHERE datname=$1', [intent.dbName])).rows[0].oid;
      if (phase === 'ownership_changed') {
        assert.equal((await resource.operations().inspect(intent)).reason, 'busy');
      }
    });
    const clones = resource.operations();
    assert.equal((await clones.inspect(intent)).status, phase === 'finalize_committed' ? 'complete' : 'incomplete');
    if (phase === 'ownership_changed' || phase === 'before_finalize_commit') {
      const reader = await resource.connect(intent.dbName);
      assert.equal((await reader.query('SELECT secret FROM people')).rows[0].secret, 'production secret');
      assert.equal((await reader.query('SELECT count(*)::int AS n FROM private_data')).rows[0].n, 1,
        'interrupted redaction rolls back along with its completion marker');
      assert.equal((await reader.query("SELECT tableowner FROM pg_tables WHERE tablename='people'")).rows[0].tableowner,
        resource.templateRole, 'interrupted ownership changes roll back');
      await reader.end();
    }
    const recovered = await clones.prepare(intent, password);
    assert.equal(recovered.status, 'complete');
    assert.equal(recovered.databaseOid, oid);
    const target = await resource.connect(intent.dbName);
    assert.deepEqual((await target.query('SELECT name, secret FROM people')).rows, [{ name: 'Ada', secret: null }]);
    assert.equal((await target.query('SELECT count(*)::int AS n FROM private_data')).rows[0].n, 0);
    assert.equal((await target.query("SELECT tableowner FROM pg_tables WHERE tablename='people'")).rows[0].tableowner,
      `${intent.dbName}_owner`);
    const credentialUrl = new URL(resource.url);
    credentialUrl.pathname = `/${intent.dbName}`;
    credentialUrl.username = `${intent.dbName}_owner`;
    credentialUrl.password = password;
    const asOwner = new Client({ connectionString: credentialUrl.toString() });
    try {
      await asOwner.connect();
      await asOwner.query('ALTER TABLE people ADD COLUMN preview_owned boolean');
    } finally {
      await asOwner.end();
    }
    await target.query("INSERT INTO private_data(secret) VALUES ('after completion')");
    assert.equal((await clones.prepare(intent, password)).databaseOid, oid);
    assert.equal((await target.query('SELECT count(*)::int AS n FROM private_data')).rows[0].n, 1,
      'adoption does not repeat truncation');
  });
}

test('real clone: lost external acknowledgment adopts committed redaction; incomplete creation can continue', { skip: !databaseUrl }, async t => {
  const resource = await resources(t);
  const intent = resource.intent();
  assert.equal((await resource.operations().inspect(intent)).status, 'absent');
  const lostCopy = resource.operations({ onPhase: async phase => {
    if (phase === 'before_copy') throw new Error('Interrupted before copy');
  } });
  await assert.rejects(lostCopy.prepare(intent, password), /Interrupted before copy/);
  assert.equal((await resource.operations().inspect(intent)).status, 'incomplete');
  const lostFinalization = resource.operations({ onPhase: async phase => {
    if (phase === 'finalize_committed') throw new Error('Lost committed acknowledgment');
  } });
  await assert.rejects(lostFinalization.prepare(intent, password), /Lost committed acknowledgment/);
  const observed = await resource.operations().inspect(intent);
  assert.equal(observed.status, 'complete');
  assert.equal((await resource.operations().prepare(intent, password)).databaseOid, observed.databaseOid);
});

test('real clone: a creator preparing an absent database excludes cleanup until interruption', { skip: !databaseUrl }, async t => {
  const resource = await resources(t);
  const intent = resource.intent();
  await interrupted(resource, intent, 'before_copy', async () => {
    assert.equal((await resource.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [intent.dbName])).rowCount, 0);
    assert.equal((await resource.operations().inspect(intent)).reason, 'busy');
    assert.equal((await resource.operations().remove(intent)).reason, 'busy');
  });
  assert.equal((await resource.operations().inspect(intent)).status, 'incomplete');
  assert.equal((await resource.operations().prepare(intent, password)).status, 'complete');
});

test('real clone: a target finalizer outliving its maintenance session blocks recovery and cleanup', { skip: !databaseUrl }, async t => {
  const resource = await resources(t);
  const intent = resource.intent();
  await interrupted(resource, intent, 'copy_committed');
  const control = await resource.connect('postgres');
  await control.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`preview-clone:${intent.dbName}`]);
  const target = await resource.connect(intent.dbName);
  await target.query('BEGIN');
  await target.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`preview-clone:${intent.dbName}`]);
  const pending = target.query('SELECT pg_sleep(0.5)');
  await waitFor(async () => (await resource.admin.query(`SELECT 1 FROM pg_stat_activity
    WHERE datname=$1 AND state='active' AND query='SELECT pg_sleep(0.5)'`, [intent.dbName])).rowCount === 1);
  await control.end();
  // The actual server query/transaction outlives this maintenance connection.
  // The continuation itself is constructed, rather than running a real build.
  const clones = resource.operations();
  assert.equal((await clones.inspect(intent)).reason, 'busy');
  assert.equal((await clones.prepare(intent, password)).reason, 'busy');
  assert.equal((await clones.remove(intent)).reason, 'busy');
  assert.equal((await resource.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [intent.dbName])).rowCount, 1);
  const unrelated = resource.intent();
  assert.equal((await clones.prepare(unrelated, password)).status, 'complete');
  await pending;
  await target.query('ROLLBACK');
  await target.end();
  assert.equal((await clones.prepare(intent, password)).status, 'complete');
});

test('real clone: retirement after absence prevents delayed creation and stale cleanup preserves a successor', { skip: !databaseUrl }, async t => {
  const resource = await resources(t);
  const retired = resource.intent();
  const successor = resource.intent();
  const clones = resource.operations();
  assert.equal((await clones.remove(retired)).status, 'removed');
  assert.equal((await clones.prepare(retired, password)).status, 'retired');
  assert.equal((await resource.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [retired.dbName])).rowCount, 0);
  assert.equal((await clones.prepare(successor, password)).status, 'complete');
  const oid = (await clones.inspect(successor)).databaseOid;
  await clones.remove(retired);
  assert.equal((await clones.inspect(successor)).databaseOid, oid);
  assert.equal((await clones.remove(successor)).status, 'removed');
  assert.equal((await clones.prepare(successor, password)).status, 'retired');
  assert.equal((await resource.admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',
    [`${successor.dbName}_owner`])).rows[0].rolcanlogin, false);
});

for (const phase of ['retirement_committed', 'database_removed']) {
  test(`real clone: lost ${phase} acknowledgment leaves retirement recoverable`, { skip: !databaseUrl }, async t => {
    const resource = await resources(t);
    const intent = resource.intent();
    await resource.operations().prepare(intent, password);
    const lost = resource.operations({ onPhase: async observed => {
      if (observed === phase) throw new Error('Lost retirement acknowledgment');
    } });
    await assert.rejects(lost.remove(intent), /Lost retirement acknowledgment/);
    assert.equal((await resource.operations().prepare(intent, password)).status, 'retired');
    assert.equal((await resource.operations().remove(intent)).status, 'removed');
    assert.equal((await resource.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [intent.dbName])).rowCount, 0);
    assert.equal((await resource.operations().inspect(intent)).status, 'retired');
  });
}

test('real clone: unmarked or physically replaced databases cannot be adopted or deleted', { skip: !databaseUrl }, async t => {
  const resource = await resources(t);
  const foreign = resource.intent();
  await resource.admin.query(`CREATE DATABASE ${foreign.dbName} TEMPLATE template0`);
  const clones = resource.operations();
  assert.equal((await clones.prepare(foreign, password)).reason, 'ownership_conflict');
  assert.equal((await clones.remove(foreign)).reason, 'ownership_conflict');
  assert.equal((await resource.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [foreign.dbName])).rowCount, 1);
  const replaced = resource.intent();
  await clones.prepare(replaced, password);
  const complete = (await resource.admin.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1",
    [replaced.dbName])).rows[0].marker;
  await resource.admin.query(`DROP DATABASE ${replaced.dbName}`);
  await resource.admin.query(`CREATE DATABASE ${replaced.dbName} TEMPLATE template0 OWNER ${replaced.dbName}_owner`);
  await resource.admin.query(`COMMENT ON DATABASE ${replaced.dbName} IS '${complete.replace(/'/g, "''")}'`);
  assert.equal((await clones.inspect(replaced)).reason, 'ownership_conflict');
  assert.equal((await clones.remove(replaced)).reason, 'ownership_conflict');
  await resource.admin.query(`COMMENT ON DATABASE ${replaced.dbName} IS NULL`);
  assert.equal((await clones.prepare(replaced, password)).reason, 'ownership_conflict',
    'the role receipt also preserves physical identity');
  const vanished = resource.intent();
  await clones.prepare(vanished, password);
  await resource.admin.query(`DROP DATABASE ${vanished.dbName}`);
  assert.equal((await clones.prepare(vanished, password)).reason, 'resource_missing');
  assert.equal((await clones.remove(vanished)).status, 'removed');
  assert.equal((await clones.prepare(vanished, password)).status, 'retired');
});

test('real shared runtime and clone: interrupted copy and lost completion receipt recover without replacing serving state', { skip: !databaseUrl }, async t => {
  const resource = await resources(t);
  const sessionId = 1000000 + process.pid;
  const db = await createExecutionDatabase(databaseUrl);
  t.after(() => db.close());
  await db.pool.query('UPDATE apps SET slug=$1', [resource.sourceDb.slice(4)]);
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1,$2)', [sessionId, HEAD]);
  await db.pool.query('CREATE TABLE objects (name text PRIMARY KEY, receipt jsonb)');
  const config = { databaseUrl: db.url, appRuntime: 'docker', dataEncryptionKey: 'test-key',
    nativePreviewWorkerEnabled: true, nativePreviewAttempts: true, nativePreviewRecoverableClone: true };
  let runtimeCreates = 0;
  const adapters = {
    clones: resource.operations(),
    async inspect(_config, intent) {
      const object = (await db.pool.query('SELECT receipt FROM objects WHERE name=$1', [intent.runtimeName])).rows[0];
      return { present: !!object, receipt: object?.receipt || null };
    },
    async prepare(_config, _session, _app, head, candidate) {
      assert.equal(candidate.preparedClone, true);
      assert.equal((await resource.operations().inspect(candidate.intent)).status, 'complete');
      const credentialUrl = new URL(resource.url);
      credentialUrl.pathname = `/${candidate.intent.dbName}`;
      credentialUrl.username = `${candidate.intent.dbName}_owner`;
      credentialUrl.password = candidate.password;
      const previewDatabase = new Client({ connectionString: credentialUrl.toString() });
      try {
        await previewDatabase.connect();
        assert.equal((await previewDatabase.query('SELECT secret FROM people')).rows[0].secret, null);
      } finally {
        await previewDatabase.end();
      }
      runtimeCreates++;
      const receipt = { commitSha: head, stagingUrl: `http://${candidate.intent.runtimeName}:3000`, runtimeKind: 'docker',
        runtimeName: candidate.intent.runtimeName, containerId: candidate.intent.runtimeName, imageRef: 'injected:image',
        buildRef: null, physicalId: randomUUID(), attemptId: candidate.intent.attemptId };
      await db.pool.query('INSERT INTO objects VALUES ($1,$2)', [receipt.runtimeName, JSON.stringify(receipt)]);
      return receipt;
    },
  };
  const work = createPreviewWork(db.pool, config, adapters);
  const request = { type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId, headSha: HEAD, startedStatus: 'active' };
  const admission = await work.request(request);
  assert.equal(admission.work.workflow, PREPARE_CLONE);
  const intent = admission.work.input.intent;
  resource.remember(intent);
  const owner = createPreviewFlow(db.pool);
  const cloneAction = { type: 'RequestCandidateClone', actionId: randomUUID(), sessionId,
    ...admission.work.input.identity, operationId: randomUUID() };
  assert.equal((await owner.apply(cloneAction)).decision.reason, 'clone_operation_mismatch');
  await db.pool.query('UPDATE chat_sessions SET checks_commit_sha=$1 WHERE id=$2', ['b'.repeat(40), sessionId]);
  assert.equal((await owner.apply({ ...cloneAction, actionId: randomUUID(), operationId: intent.attemptId })).decision.reason,
    'head_changed');
  await db.pool.query('UPDATE chat_sessions SET checks_commit_sha=$1 WHERE id=$2', [HEAD, sessionId]);
  // The actual worker child owns the claim, guards and reserved credential.
  // Shorten its expired lease after SIGKILL rather than waiting sixty seconds.
  const first = admission.work;
  await interrupted(resource, intent, 'copy_committed', null, { platformUrl: db.url, config });
  const oid = (await resource.operations().inspect(intent)).database.oid;
  await db.pool.query("UPDATE execution_work_requests SET lease_until=clock_timestamp()-interval '1 second'");
  let lost = false;
  const recovered = createPreviewWork(db.pool, config, { ...adapters, owner: {
    ...owner,
    async apply(action) {
      const receipt = await owner.apply(action);
      if (action.type === 'CandidateClonePrepared' && !lost) {
        lost = true;
        throw new Error('Lost platform decision acknowledgment');
      }
      return receipt;
    },
  } });
  async function executeUntil(predicate, handlers) {
    await waitFor(async () => {
      if (await predicate()) return true;
      await db.pool.query('UPDATE execution_work_requests SET due_at=clock_timestamp() WHERE id=$1', [first.id]);
      const worker = createExecutionWorker({ store: work.store, handlers, concurrency: 1 });
      await worker.tick();
      await worker.drain();
      return predicate();
    });
  }
  await executeUntil(() => lost, recovered.handlers);
  assert.equal(runtimeCreates, 0);
  assert.equal((await owner.read(sessionId)).flow.state, 'preparing');
  assert.equal((await owner.read(sessionId)).resource.clonePrepared, true);
  await executeUntil(async () => (await work.store.read(first.id)).status === 'succeeded', work.handlers);
  const stored = await work.store.read(first.id);
  assert.equal(stored.status, 'succeeded');
  assert.equal(stored.result.accepted, true);
  assert.equal(runtimeCreates, 1, 'runtime adapter is injected; it executes only after real clone recovery');
  const state = await owner.read(sessionId);
  assert.equal(state.flow.id, admission.decision.flow.id);
  assert.equal(state.flow.state, 'candidate');
  assert.equal(state.preview.runtimeName, 'serving', 'preparation never activates');
  assert.equal(state.binding, null);
  assert.equal((await resource.operations().inspect(intent)).databaseOid, oid);
  for (const entry of await owner.trace(sessionId)) assert.deepEqual(replayDecision(entry), entry.decision);
  // Disabling future enrollment does not reinterpret an already accepted request.
  const compatibility = createPreviewWork(db.pool, { ...config, nativePreviewRecoverableClone: false }, adapters);
  assert.equal((await compatibility.request(request)).work.id, admission.work.id);
  assert.ok(compatibility.handlers[PREPARE] && compatibility.handlers[PREPARE_CLONE]);
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (2,$1)', [HEAD]);
  const oldRequest = { ...request, actionId: randomUUID(), sessionId: 2 };
  const legacy = await compatibility.request(oldRequest);
  assert.equal(legacy.work.workflow, PREPARE);
  assert.equal(legacy.work.input.intent.cloneOperation, undefined);
  assert.equal((await work.request(oldRequest)).work.id, legacy.work.id, 'existing admission keeps its old contract');
});

for (const runtimeKind of ['docker', 'kubernetes']) {
  test(`real clone with injected ${runtimeKind} transport: domain cleanup preserves a successor and blocks stale completion`, {
    skip: !databaseUrl,
  }, async t => {
    const resource = await resources(t);
    const db = await createExecutionDatabase(databaseUrl);
    t.after(() => db.close());
    await db.pool.query('UPDATE apps SET slug=$1', [resource.sourceDb.slice(4)]);
    await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1,$1)', [HEAD]);
    const config = { databaseUrl: db.url, appRuntime: runtimeKind, jwtSecret: 'test',
      kubernetes: { appNamespace: 'apps', appDomain: 'test.local' }, dataEncryptionKey: 'test-key',
      nativePreviewWorkerEnabled: true, nativePreviewAttempts: true, nativePreviewRecoverableClone: true };
    const work = createPreviewWork(db.pool, config, { clones: resource.operations() });
    const action = { type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId: 1, headSha: HEAD, startedStatus: 'active' };
    const predecessor = await work.request(action);
    const oldIntent = predecessor.work.input.intent;
    resource.remember(oldIntent);
    await resource.operations().prepare(oldIntent, password);
    const successor = await work.request({ ...action, actionId: randomUUID() });
    const nextIntent = successor.work.input.intent;
    resource.remember(nextIntent);
    const next = await resource.operations().prepare(nextIntent, password);
    const runtime = require('../src/services/preview-flow/candidate-runtime');
    const bindings = require('../src/services/preview-flow/binding-adapters');
    const removals = [];
    t.mock.method(bindings, 'inspect', async () => ({ target: 'serving', token: 'same', uid: null }));
    t.mock.method(runtime, 'removeCandidate', async (_config, intent) => { removals.push(intent.runtimeName); });
    t.mock.method(runtime, 'removeCandidateImage', async () => {});
    t.mock.method(require('../src/services/docker'), 'execFileAsync', async () => ({ stdout: '' }));
    const cleanup = require('../src/services/preview-flow/cleanup').createCleanup({ clones: resource.operations() });
    await cleanup.underBuildLock({ pool: db.pool, config, sessionId: 1, flowId: predecessor.decision.flow.id });
    await cleanup.underBuildLock({ pool: db.pool, config, sessionId: 1, flowId: predecessor.decision.flow.id });
    assert.ok(removals.every(name => name === oldIntent.runtimeName));
    assert.equal((await resource.operations().inspect(oldIntent)).status, 'retired');
    assert.equal((await resource.operations().inspect(nextIntent)).databaseOid, next.databaseOid);
    const owner = createPreviewFlow(db.pool);
    const stale = await owner.apply({ type: 'CandidateClonePrepared', actionId: randomUUID(), sessionId: 1,
      ...predecessor.work.input.identity, operationId: oldIntent.attemptId, databaseOid: next.databaseOid });
    assert.equal(stale.decision.reason, 'superseded_flow');
    const state = await owner.read(1);
    assert.equal(state.preview.runtimeName, 'serving');
    assert.equal(state.resource.clonePrepared, false, 'stale completion cannot mark its successor');
    assert.deepEqual(await cleanup.underBuildLock({ pool: db.pool, config, sessionId: 1, flowId: successor.decision.flow.id }),
      { protected: true });
  });
}

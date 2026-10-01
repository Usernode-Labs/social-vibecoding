'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { databaseFixture, credentialUrl } = require('./lib/database-runtime-fixture');
const { cleanupPass, assertCandidate } = require('./lib/runtime-integration-fixture');
const { sanitizedEnvironment } = require('./lib/isolated-kpack-fixture');

const options = { skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000 };

async function predecessorAndSuccessor(f) {
  const admitted = await f.admit();
  await f.poll(f.work, admitted.work.id);
  const old = await f.owner.read(f.sessionId);
  const oldPassword = await f.credentials(old.resource.intent);
  const next = await f.admit();
  await f.poll(f.work, next.work.id);
  const successor = await f.owner.read(f.sessionId);
  const expected = await f.runtimes.inspect(f.config, successor.resource.intent);
  const database = await f.clones.inspect(successor.resource.intent);
  assert.equal(expected.status, 'healthy');
  assert.equal(database.status, 'complete');
  async function assertSuccessor() {
    await assertCandidate(f, successor.resource.intent, expected.uids);
    await f.assertDatabase(successor.resource.intent, database.databaseOid);
    await f.assertServingDatabase();
  }
  await assertSuccessor();
  return { old, oldPassword, assertSuccessor };
}

async function assertReleased(f, old) {
  const observed = await f.clones.inspect(old.resource.intent);
  assert.equal(observed.status, 'retired');
  assert.equal(observed.database, undefined);
  assert.equal(observed.role.rolcanlogin, false);
  assert.equal((await f.clones.prepare(old.resource.intent, '1'.repeat(48))).status, 'retired');
  const { rows: [resource] } = await f.pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1', [old.flow.id]);
  assert.equal(resource.cleanup_completed_at, null, 'database release is not Kubernetes creator closure');
  return observed.role.oid;
}

async function awaitRelease(f, old, work = f.work) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const record = await cleanupPass(f, work, old.flow.id);
    if (record.result?.databaseReleased) return record;
    assert.ok(Date.now() < deadline, `Database must release once consumers disappear: ${record.last_code}`);
    await delay(1000);
  }
}

async function pausedWorker(t, f, old, phase) {
  const child = fork(require.resolve('./lib/retired-database-child'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: sanitizedEnvironment(),
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const paused = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', code => reject(new Error(`Worker exited before retirement interruption: ${code}`)));
  });
  child.send({ databaseUrl: f.url, flowId: old.flow.id, pauseAt: phase });
  assert.deepEqual(await paused, { phase });
  return async () => {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await f.pool.query(`UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'
      WHERE input->>'flowId' = $1`, [old.flow.id]);
  };
}

async function delayedPod(f, intent, password, expected) {
  const name = `c6-connection-${randomUUID().slice(0, 8)}`;
  await f.clients.core.createNamespacedPod({ namespace: intent.namespace, body: {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, labels: { 'social.usernode.io/runtime-name': intent.runtimeName } },
    spec: {
      restartPolicy: 'Never', serviceAccountName: 'recovery-builder',
      containers: [{
        name: 'connection', image: f.fixture.databaseRuntimeImage,
        command: ['node', '-e', `
          const { Client } = require('/opt/evidence/node_modules/pg');
          const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
          client.connect().then(() => client.query('SELECT value FROM evidence'))
            .then(() => console.log('CONNECTED'))
            .catch(error => console.log('DENIED:' + error.code))
            .finally(() => client.end());
        `],
        env: [{ name: 'DATABASE_URL', value: credentialUrl(f.fixture, intent, password, f.databaseAddress) }],
      }],
    },
  } });
  const deadline = Date.now() + 60000;
  for (;;) {
    const pod = await f.clients.core.readNamespacedPod({ namespace: intent.namespace, name });
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') {
      const logs = await f.clients.core.readNamespacedPodLog({ namespace: intent.namespace, name });
      assert.match(logs, expected, 'connection result must prove SQL behavior, not a network failure');
      return pod;
    }
    assert.ok(Date.now() < deadline, 'Delayed actual Pod must finish its database probe');
    await delay(500);
  }
}

for (const phase of ['retirement_committed', 'database_removed']) {
  test(`actual database + Kubernetes: SIGKILL after ${phase}, restart and delayed Pod preserve successor`, options, async t => {
    const f = await databaseFixture(t);
    const { old, oldPassword, assertSuccessor } = await predecessorAndSuccessor(f);
    const existing = await f.connectOwner(old.resource.intent, oldPassword);
    assert.equal((await existing.query('SELECT value FROM evidence')).rowCount, 1);
    const stop = await pausedWorker(t, f, old, phase);
    const retired = await f.clones.inspect(old.resource.intent);
    // The child still holds the maintenance lock: catalog reads independently
    // verify the committed fence without pretending a busy inspection succeeded.
    assert.equal(retired.reason, 'busy');
    const { rows: [role] } = await f.admin.query('SELECT oid::text, rolcanlogin FROM pg_roles WHERE rolname = $1', [`${old.resource.intent.dbName}_owner`]);
    assert.equal(role.rolcanlogin, false);
    if (phase === 'retirement_committed') {
      assert.equal((await existing.query('SELECT value FROM evidence')).rowCount, 1,
        'NOLOGIN alone intentionally does not terminate preexisting connections');
      await assert.rejects(f.connectOwner(old.resource.intent, oldPassword), error => ['28000', '28P01'].includes(error.code));
    }
    await assertSuccessor();
    await stop();
    const restarted = f.recovery();
    const record = await awaitRelease(f, old, restarted.work);
    assert.deepEqual(record.result, { databaseReleased: true, runtimeObservedAbsent: true, creationEnded: false });
    assert.equal(await assertReleased(f, old), role.oid);
    await assert.rejects(existing.query('SELECT value FROM evidence'));
    await assertSuccessor();

    // Inject timing, then create a real Pod after confirmed database release.
    // This reproduces a late creator whose termination has never been proved.
    const late = await delayedPod(f, old.resource.intent, oldPassword, /DENIED:(28000|28P01|3D000)/);
    const deferred = await cleanupPass(f, restarted.work, old.flow.id);
    assert.equal(deferred.status, 'queued', 'late consumer obligation remains retryable');
    assert.equal(await assertReleased(f, old), role.oid);
    const { rows: events } = await f.pool.query('SELECT detail FROM execution_work_events WHERE work_id = $1', [record.id]);
    assert.ok(events.some(event => event.detail.result?.databaseReleased), 'release receipt survives later retries and restart');
    await assertSuccessor();
    t.diagnostic(`Actual forced removal, retired role ${role.oid}, late Pod ${late.metadata.uid}; creator obligation retained, serving/successor SQL and HTTP unchanged`);
  });
}

for (const phase of ['retirement_committed', 'database_removed']) {
  test(`actual database + Kubernetes: lost ${phase} acknowledgment is safely retried`, options, async t => {
    const f = await databaseFixture(t);
    const { old, assertSuccessor } = await predecessorAndSuccessor(f);
    let lost = false;
    const recovery = f.recovery({
      async onPhase(current) {
        if (current === phase && !lost) {
          lost = true;
          throw new Error('Injected acknowledgment loss after actual PostgreSQL operation');
        }
      },
    });
    const record = await awaitRelease(f, old, recovery.work);
    assert.equal(lost, true);
    const { rows: events } = await f.pool.query('SELECT kind, detail FROM execution_work_events WHERE work_id = $1', [record.id]);
    assert.ok(events.some(event => event.kind === 'settled' && event.detail.outcome === 'retry'));
    await assertReleased(f, old);
    await assertSuccessor();
    t.diagnostic(`Actual ${phase} followed by injected reply loss, retry adopted retired identity and confirmed absence`);
  });
}

test('actual PostgreSQL prepared transaction blocks release; resolved blocker resumes the same cleanup', options, async t => {
  const f = await databaseFixture(t);
  assert.ok(Number((await f.admin.query('SHOW max_prepared_transactions')).rows[0].max_prepared_transactions) > 0);
  const { old, oldPassword, assertSuccessor } = await predecessorAndSuccessor(f);
  const client = await f.connectOwner(old.resource.intent, oldPassword);
  const transaction = `c6_${randomUUID().replaceAll('-', '')}`;
  await client.query('BEGIN');
  await client.query('INSERT INTO evidence VALUES ($1)', ['uncommitted']);
  await client.query(`PREPARE TRANSACTION '${transaction}'`);
  await client.end();
  const targetUrl = new URL(f.fixture.isolation.database.url);
  targetUrl.pathname = `/${old.resource.intent.dbName}`;
  const targetAdmin = new Client({ connectionString: targetUrl.toString() });
  await targetAdmin.connect();
  try {
    const deadline = Date.now() + 120000;
    let retired;
    do {
      const record = await cleanupPass(f, f.work, old.flow.id);
      assert.equal(record.result?.databaseReleased, undefined);
      retired = await f.clones.inspect(old.resource.intent);
      if (retired.status === 'retired') break;
      assert.ok(Date.now() < deadline);
      await delay(1000);
    } while (true);
    assert.ok(retired.database, 'FORCE blocker leaves the database present');
    assert.equal(retired.role.rolcanlogin, false);
    await assert.rejects(f.connectOwner(old.resource.intent, oldPassword), error => ['28000', '28P01'].includes(error.code));
    await assertSuccessor();
    await targetAdmin.query(`ROLLBACK PREPARED '${transaction}'`);
  } finally {
    await targetAdmin.query(`ROLLBACK PREPARED '${transaction}'`).catch(() => {});
    await targetAdmin.end();
  }
  await awaitRelease(f, old, f.recovery().work);
  await assertReleased(f, old);
  await assertSuccessor();
  t.diagnostic('Real prepared transaction prevented forced removal; no false release receipt; same obligation completed database release after resolution');
});

test('actual PostgreSQL + Kubernetes: missing clone identity defers cleanup before external deletion', options, async t => {
  const f = await databaseFixture(t);
  const { old, assertSuccessor } = await predecessorAndSuccessor(f);
  const intent = old.resource.intent;
  const before = await f.runtimes.inventory(intent, { retiring: true });
  const database = await f.clones.inspect(intent);
  await f.pool.query(`UPDATE preview_flow_resources SET intent = intent - 'cloneOperation' WHERE flow_id = $1`, [old.flow.id]);
  const deferred = await cleanupPass(f, f.work, old.flow.id);
  assert.equal(deferred.status, 'queued');
  const remaining = await f.runtimes.inventory(intent, { retiring: true });
  for (const kind of ['secret', 'service', 'deployment']) {
    assert.equal(remaining.resources[kind].metadata.uid, before.resources[kind].metadata.uid);
    assert.equal(remaining.resources[kind].metadata.deletionTimestamp, undefined);
  }
  await f.assertDatabase(intent, database.databaseOid);
  await assertSuccessor();
  await f.pool.query('UPDATE preview_flow_resources SET intent = $2 WHERE flow_id = $1', [old.flow.id, intent]);
  await awaitRelease(f, old, f.recovery().work);
  await assertReleased(f, old);
  await assertSuccessor();
  t.diagnostic('Injected missing clone identity blocks all external deletion; restoring the original identity resumes release with the same owner');
});

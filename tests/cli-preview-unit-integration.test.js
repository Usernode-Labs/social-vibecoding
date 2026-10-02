'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureFor } = require('./lib/complete-preparation-fixture');
const { addHandoffColumns } = require('./lib/cli-handoff-fixture');
const { actualChecksWorker, addChecksTables } = require('./lib/cli-checks-fixture');
const { interrupt, tick, wake, orphan, snapshot } = require('./lib/cli-checks-control');
const kubernetes = require('../src/services/kubernetes');
const harvest = require('../src/services/check-harvest');

// The source and cloned unit repository are fixture inputs. Jobs, Git/npm execution,
// SQL, observations, harvest and input retirement are real, never successful stubs.
test('C10 actual unit Jobs recover lost replies and delayed creation, including supersession', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  const f = await fixtureFor(t, { requireUnitSuite: true });
  await addHandoffColumns(f.pool);
  await addChecksTables(f.pool);
  const head = f.fixture.preparationSource.revision;
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = $2', [head, f.sessionId]);
  const actual = actualChecksWorker(f, { unitSuite: true });
  t.after(() => actual.restore());
  const work = actual.work;
  const session = async () => (await f.pool.query('SELECT * FROM chat_sessions WHERE id = $1', [f.sessionId])).rows[0];
  const manifest = async () => (await f.pool.query('SELECT * FROM check_runs WHERE session_id = $1', [f.sessionId])).rows[0];
  const jobsFor = runId => kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: runId });
  const namespace = f.fixture.isolation.namespace.name;
  const evidence = [];
  const inputName = job => job.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name;

  async function recoverResults(record, uid) {
    await orphan(f);
    await wake(f);
    await tick(work);
    await wake(f);
    await tick(work);
    assert.equal((await work.recover(f.sessionId)).status, 'succeeded');
    assert.equal((await jobsFor(record.run_id)).unitSuite.uid, uid);
    assert.equal(await manifest(), undefined);
    const unit = (await session()).test_results.find(row => row.name === require('../src/services/unit-suite').UNIT_CHECK_NAME);
    assert.ok(unit, 'Expected unit result cannot disappear from the verdict');
    assert.equal(unit.status, 'pass');
    assert.equal(unit.summary.tests, 2, 'Actual pinned fixture repository ran both tests');
    const job = await f.clients.batch.readNamespacedJob({ namespace, name: (await jobsFor(record.run_id)).unitSuite.name });
    await assert.rejects(f.clients.core.readNamespacedSecret({ namespace,
      name: inputName(job) }), error => Number(error.code) === 404);
  }

  await work.admit({ session: await session(), headSha: head });
  const lostReply = await interrupt(t, f, 'unit_running');
  let record = await manifest();
  assert.equal(record.manifest.unitSuite.state, 'submitted', 'Lost POST acknowledgment has no fabricated UID');
  assert.equal((await jobsFor(record.run_id)).unitSuite.uid, lostReply.uid);
  const candidate = (await session()).staging_runtime_name;
  await recoverResults(record, lostReply.uid);
  evidence.push({ scenario: 'lost creation reply', run: record.run_id, uid: lostReply.uid });

  await work.recover(f.sessionId, { force: true });
  const delayed = await interrupt(t, f, 'unit_creation_submitted');
  record = await manifest();
  assert.equal(record.manifest.unitSuite.state, 'submitted');
  assert.equal((await jobsFor(record.run_id)).unitSuite, null);
  const input = await f.clients.core.readNamespacedSecret({ namespace, name: inputName(delayed.body) });
  await orphan(f);
  await wake(f);
  await tick(work);
  assert.equal((await session()).check_state, 'pending');
  assert.equal((await work.owner.read(f.sessionId)).checksOutstanding, true);
  assert.equal((await manifest()).run_id, record.run_id, 'Absence retains the required result and cleanup locator');
  assert.equal((await f.clients.core.readNamespacedSecret({ namespace, name: input.metadata.name })).metadata.uid,
    input.metadata.uid, 'Unconfirmed creation retains its actual input');
  const arrived = await f.clients.batch.createNamespacedJob({ namespace, body: delayed.body });
  await recoverResults(record, arrived.metadata.uid);
  evidence.push({ scenario: 'creation after observed absence', run: record.run_id, uid: arrived.metadata.uid });

  await work.recover(f.sessionId, { force: true });
  const retired = await interrupt(t, f, 'unit_creation_submitted');
  record = await manifest();
  await orphan(f);
  await tick(work);
  record = await manifest(); // Re-read the owner after the recovery claim.
  const next = 'c'.repeat(40);
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = $2', [next, f.sessionId]);
  const successor = await work.admit({ session: await session(), headSha: next });
  assert.equal(successor.accepted, true);
  const before = await snapshot(f);
  const absent = await harvest.adopt(f.config, f.pool, record, { retireJobs: true });
  assert.equal(absent.outcome, 'waiting');
  assert.equal((await manifest()).run_id, record.run_id);
  assert.deepEqual(await snapshot(f), before);
  const late = await f.clients.batch.createNamespacedJob({ namespace, body: retired.body });
  const cleanup = await harvest.adopt(f.config, f.pool, record, { retireJobs: true });
  assert.equal(cleanup.outcome, 'moot');
  assert.equal(await manifest(), undefined);
  await assert.rejects(f.clients.core.readNamespacedSecret({ namespace, name: inputName(retired.body) }),
    error => Number(error.code) === 404);
  assert.deepEqual(await snapshot(f), before, 'Late obsolete unit work cannot publish verdict or media');
  assert.equal((await work.store.read(successor.work.id)).status, 'queued');
  assert.equal((await session()).staging_runtime_name, candidate);
  assert.equal(await f.probe(f.config, { namespace, runtimeName: candidate }), true);
  assert.equal(await f.probe(f.config, f.serving), true);
  evidence.push({ scenario: 'creation after supersession', run: record.run_id, uid: late.metadata.uid });
  const jobs = await f.clients.batch.listNamespacedJob({ namespace,
    labelSelector: `social.usernode.io/session-id=${f.sessionId}` });
  assert.equal(jobs.items.filter(job => job.metadata.name.startsWith('sv-unit-suite-')).length, 2,
    'Exactly one unit Job per run; only the obsolete running Job was removed');
  t.diagnostic(JSON.stringify({ evidence, actual: 'PostgreSQL, unit/capture Jobs, input Secrets, git/npm test and harvest',
    substituted: 'tiny pinned unit fixture repo, manifest metadata and private-origin transport; SIGKILL and delayed POST delivery' }));
});

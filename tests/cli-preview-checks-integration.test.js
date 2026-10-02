'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureFor } = require('./lib/complete-preparation-fixture');
const { addHandoffColumns } = require('./lib/cli-handoff-fixture');
const { actualChecksWorker, addChecksTables } = require('./lib/cli-checks-fixture');
const kubernetes = require('../src/services/kubernetes');
const visuals = require('../src/services/visuals');
const lifecycle = require('../src/services/preview-lifecycle');
const { interrupt, tick, wake, orphan, snapshot } = require('./lib/cli-checks-control');
const NEXT = 'c'.repeat(40);

test('C9 actual Chromium Job survives worker loss, verdict loss and rejects superseded output', {
  skip: process.env.RUN_ISOLATED_KPACK_TEST !== '1', timeout: 1200000,
}, async t => {
  const f = await fixtureFor(t);
  await addHandoffColumns(f.pool);
  await addChecksTables(f.pool);
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = $2',
    [f.fixture.preparationSource.revision, f.sessionId]);
  const actual = actualChecksWorker(f);
  t.after(() => actual.restore());
  const work = actual.work;
  const session = async () => (await f.pool.query('SELECT * FROM chat_sessions WHERE id = $1', [f.sessionId])).rows[0];
  await work.admit({ session: await session(), headSha: f.fixture.preparationSource.revision });
  const running = await interrupt(t, f, 'checks_running');
  let record = (await f.pool.query('SELECT * FROM check_runs WHERE session_id = $1', [f.sessionId])).rows[0];
  assert.ok(record.manifest.durableCli && record.manifest.launched);
  const runId = record.run_id;
  await tick(work);
  assert.equal((await work.recover(f.sessionId)).status, 'queued', 'Live manifest is joined, not replaced');
  assert.equal((await kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: runId })).capture.uid, running.uid);
  await orphan(f);
  await wake(f);
  // The Job and its logs are real; only the observation reply is injected.
  // An unavailable log read must not consume the run or fabricate a verdict.
  const collect = kubernetes.collectCheckJob;
  kubernetes.collectCheckJob = async (...args) => {
    const observed = await collect(...args);
    return { ...observed, stdout: '', partial: true, partialReason: 'capture log unavailable' };
  };
  try { await tick(work); }
  finally { kubernetes.collectCheckJob = collect; }
  const blocked = (await work.owner.read(f.sessionId)).handoff.checks_recovery;
  assert.equal(blocked.reason, 'capture_output_unavailable');
  assert.equal(blocked.runId, runId);
  assert.equal(blocked.owner, 'check-harvest');
  assert.equal((await session()).check_state, 'pending');
  assert.equal((await kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: runId })).capture.uid, running.uid);
  await orphan(f);
  await wake(f);
  await tick(work);
  await wake(f);
  await tick(work);
  assert.equal((await work.recover(f.sessionId)).status, 'succeeded');
  assert.equal((await work.owner.read(f.sessionId)).handoff.checks_recovery, null);
  assert.ok(['passing', 'failing'].includes((await session()).check_state),
    'Adopt the actual verdict, including the sample browser’s optional favicon error');
  assert.equal((await work.owner.read(f.sessionId)).handoff.phase, 'complete');
  assert.equal((await kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: runId })).capture.uid, running.uid);
  assert.equal((await f.pool.query('SELECT * FROM check_runs')).rowCount, 0);
  await assert.rejects(f.clients.core.readNamespacedSecret({
    namespace: f.fixture.isolation.namespace.name, name: `${running.name}-input`,
  }), error => Number(error.code) === 404, 'Recovering a lost Job reply also releases its input Secret');
  const shots = (await f.pool.query('SELECT content_type, data FROM session_visuals')).rows;
  assert.ok(shots.some(shot => shot.content_type === 'image/png' && shot.data.subarray(1, 4).toString() === 'PNG'),
    'Actual capture image produced stored PNG evidence');
  const allJobs = await f.clients.batch.listNamespacedJob({ namespace: f.fixture.isolation.namespace.name,
    labelSelector: `social.usernode.io/session-id=${f.sessionId}` });
  assert.equal(allJobs.items.filter(job => job.metadata.name.startsWith('sv-capture-')).length, 1);

  await work.recover(f.sessionId, { force: true });
  await interrupt(t, f, 'verdict_persisted');
  record = (await f.pool.query('SELECT * FROM check_runs')).rows[0];
  assert.ok(['passing', 'failing'].includes((await session()).check_state),
    'Adopt the actual verdict, including the sample browser’s optional favicon error');
  assert.equal((await work.owner.read(f.sessionId)).checksOutstanding, true,
    'Verdict does not discard lifecycle/manifest release');
  const verdictJob = (await kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: record.run_id })).capture;
  await orphan(f);
  await tick(work);
  await wake(f);
  await tick(work);
  assert.equal((await work.recover(f.sessionId)).status, 'succeeded');
  assert.equal((await work.owner.read(f.sessionId)).checksOutstanding, false);
  assert.equal((await kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: record.run_id })).capture.uid, verdictJob.uid);
  await assert.rejects(f.clients.core.readNamespacedSecret({
    namespace: f.fixture.isolation.namespace.name, name: `${verdictJob.name}-input`,
  }), error => Number(error.code) === 404);

  // Inject a manifest write failure, using real admission/lifecycle/worker SQL.
  // No Job may be created when its required recovery locator did not persist.
  await work.recover(f.sessionId, { force: true });
  const checkRuns = require('../src/services/check-runs');
  const recordRun = checkRuns.record;
  checkRuns.record = async () => false;
  try { await tick(work); }
  finally { checkRuns.record = recordRun; }
  assert.equal((await session()).check_state, 'error');
  const afterFailure = await f.clients.batch.listNamespacedJob({ namespace: f.fixture.isolation.namespace.name,
    labelSelector: `social.usernode.io/session-id=${f.sessionId}` });
  assert.equal(afterFailure.items.filter(job => job.metadata.name.startsWith('sv-capture-')).length, 2);
  await wake(f);
  await tick(work);
  assert.equal((await work.recover(f.sessionId)).status, 'succeeded');

  await work.recover(f.sessionId, { force: true });
  const obsolete = await interrupt(t, f, 'checks_running');
  record = (await f.pool.query('SELECT * FROM check_runs')).rows[0];
  const output = await kubernetes.collectCheckJob(f.config, { name: obsolete.name, kind: 'capture', timeoutMs: 180000 });
  assert.equal(output.state, 'succeeded');
  assert.ok(visuals.parseTests(output.stdout).some(frame => ['pass', 'fail'].includes(frame.status) && frame.loadStatus === 200),
    'Stale results came from actual Chromium reaching /health');
  // Delete the original actual Job outside the retirement protocol. This is
  // deliberately unexplained loss: the manifest has no persisted stop/delete
  // proof, even though this test knows where the resource went.
  await f.clients.batch.deleteNamespacedJob({
    namespace: f.fixture.isolation.namespace.name, name: obsolete.name,
    body: { preconditions: { uid: obsolete.uid }, propagationPolicy: 'Foreground' },
  });
  for (let poll = 0; poll < 100; poll++) {
    try { await f.clients.batch.readNamespacedJob({ namespace: f.fixture.isolation.namespace.name, name: obsolete.name }); }
    catch (error) { if (Number(error.code) === 404) break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await kubernetes.findCheckJobs(f.config, { sessionId: f.sessionId, previewRunId: record.run_id })).capture, null);
  await orphan(f);
  await wake(f);
  await tick(work);
  const missing = (await work.owner.read(f.sessionId)).handoff.checks_recovery;
  assert.equal(missing.reason, 'capture_creation_unconfirmed');
  assert.equal(missing.runId, record.run_id);
  assert.equal((await session()).check_state, 'pending');
  assert.equal((await work.recover(f.sessionId, { force: true })).status, 'queued');
  const oldOperation = await lifecycle.adopt(f.config, { sessionId: f.sessionId,
    runId: record.run_id, revision: record.commit_sha });
  assert.ok(oldOperation);
  t.after(() => oldOperation.release());
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = $2', [NEXT, f.sessionId]);
  const successor = await work.admit({ session: await session(), headSha: NEXT });
  assert.equal(successor.accepted, true);
  const before = await snapshot(f);
  await assert.rejects(visuals.storeChecks(oldOperation.pool, f.sessionId, record.commit_sha,
    { state: 'passing', results: [] }), error => lifecycle.isCancelled(error));
  await visuals.settleCaptureRun(f.config, oldOperation.pool, {
    ...record.manifest, session: await session(), app: { id: 1, slug: 'demo' }, commitHash: record.commit_sha,
    operation: oldOperation, stdout: output.stdout, stderr: output.stderr,
  }).catch(error => assert.ok(lifecycle.isCancelled(error)));
  assert.deepEqual(await snapshot(f), before, 'Stale results cannot write verdict, media or history');
  await require('../src/services/check-harvest').adopt(f.config, f.pool, record, { retireJobs: true });
  await wake(f);
  await tick(work);
  const stored = await work.store.read(successor.work.id);
  assert.equal(stored.status, 'queued', 'Required successor preparation remains durably admitted');
  const state = await f.owner.read(f.sessionId);
  assert.ok((await f.pool.query('SELECT run_id FROM check_runs WHERE run_id = $1', [record.run_id])).rows[0],
    'Supersession retains unexplained disappearance for reconciliation/cleanup');
  assert.equal((await work.owner.read(f.sessionId)).handoff.checks_recovery, null,
    'The predecessor block does not become the successor status');
  assert.equal(state.flow.id, successor.work.input.identity.flowId);
  assert.equal((await session()).staging_runtime_name, before.session.staging_runtime_name);
  assert.equal(await f.probe(f.config, { namespace: state.resource.intent.namespace,
    runtimeName: before.session.staging_runtime_name }), true);
  assert.equal(await f.probe(f.config, f.serving), true, 'Checks retirement preserves the original serving sentinel');
  t.diagnostic(JSON.stringify({ runId, adoptedCaptureUid: running.uid,
    verdictRunId: verdictJob.name, verdictCaptureUid: verdictJob.uid, staleCaptureUid: obsolete.uid,
    storedPngs: shots.length, actual: 'Chromium image, Kubernetes Jobs/logs/deletion, PostgreSQL writes',
    blockedEvidence: 'injected unavailable-log reply recovered same Job; actual unexplained Job loss retained after supersession',
    substituted: 'manifest/source metadata, private-origin transport, startup delay; no runnable unit-suite script' }));
});

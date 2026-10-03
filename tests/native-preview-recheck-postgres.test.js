'use strict';

// Actual disposable PostgreSQL, proposal producer, adapter and worker decisions.
// GitHub identity/source, external capture and resource deletion are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { enabled } = require('./lib/preview-postgres-fixture');
const { fixture, candidate, tick } = require('./lib/manual-preview-fixture');
const producer = require('../src/services/proposal-update');
const adapter = require('../src/services/staging-recovery');
const owners = require('../src/services/cli-preview-handoff/work');
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const metadata = { testingPaths: ['/changed'], testingSteps: 'Check the changed screen.' };

async function setup(t) {
  const f = await fixture(t, { native: true });
  await f.pool.query(`ALTER TABLE apps ADD COLUMN collab_visibility TEXT, ADD COLUMN view_visibility TEXT;
    ALTER TABLE chat_sessions ADD COLUMN testing_paths JSONB, ADD COLUMN testing_path TEXT, ADD COLUMN testing_md TEXT`);
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1, approval_epoch = 7 WHERE id = 1", [HEAD]);
  const work = f.make();
  const admitted = await work.admitManual({ session: await f.session(), headSha: HEAD,
    kind: 'deploy', requestId: randomUUID(), userId: 1 });
  assert.equal(admitted.accepted, true);
  await candidate(f, work, admitted);
  await tick(work);
  let activeOwner = work;
  t.mock.method(owners, 'createCliHandoffWork', () => activeOwner);
  const source = {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'example', repo: 'demo' }),
    getBranchSha: async () => HEAD,
  };
  async function resubmit(extra = {}) {
    return producer.updateProposalFromForkBranch({
      pool: f.pool, config: f.config, gh: source,
      githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'author' }) },
      head: { validRef: () => true, validSegment: () => true,
        verifyForkBranch: async () => ({ ok: true, headSha: HEAD, forkRepo: 'demo' }) },
      busy: () => false, beginOperation: () => () => {}, serialize: (_id, run) => run(),
    }, { user: { id: 1, username: 'author' }, session: await f.session(),
      branch: 'proposal', testing: metadata, ...extra });
  }
  return { ...f, work, resubmit, use: value => { activeOwner = value; } };
}

async function continuationCount(f) {
  return Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [owners.CONTINUE])).rows[0].count);
}

async function due(f) {
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp()');
}

test('native metadata producer atomically delivers one recheck across lost replies, restart and completion', { skip: !enabled }, async t => {
  const f = await setup(t);
  const baseline = await continuationCount(f);
  const request = f.work.requestRecheck;
  let loseReply = true;
  f.work.requestRecheck = async args => {
    const result = await request(args);
    if (loseReply) { loseReply = false; throw new Error('Lost committed metadata admission reply'); }
    return result;
  };
  await assert.rejects(f.resubmit(), /Lost committed/);
  assert.equal((await f.session()).check_state, 'pending');
  assert.equal((await f.session()).testing_path, '/changed');
  assert.equal(await continuationCount(f), baseline + 1);
  f.use(f.make());
  const retries = await Promise.all(Array.from({ length: 5 }, () => f.resubmit()));
  assert.ok(retries.every(result => result.checksRerun && result.checksRequest.replayed));
  const workId = retries[0].checksRequest.workId;
  assert.equal(new Set(retries.map(result => result.checksRequest.workId)).size, 1);
  let jobsCreated = 0;
  const worker = f.make({ async capture(_config, session, _app, head) {
    jobsCreated++;
    assert.equal(session.testing_path, '/changed');
    await require('../src/services/visuals').storeChecks(f.pool, session.id, head, { state: 'passing', results: [] });
    throw new Error('Lost capture verdict reply');
  } });
  await tick(worker);
  assert.equal((await f.session()).check_state, 'passing');
  await due(f);
  await tick(f.make({ capture: async () => assert.fail('Competing capture after committed verdict') }));
  assert.equal((await f.work.store.read(workId)).status, 'succeeded');
  const completed = await f.resubmit();
  assert.equal(completed.checksRequest.workId, workId);
  assert.equal(completed.checksRequest.replayed, true);
  assert.equal(await continuationCount(f), baseline + 1);
  assert.equal(jobsCreated, 1, 'One injected external Job creation; replay adopts verdict');
  assert.equal((await f.session()).approval_epoch, 7);
  assert.equal((await f.session()).reviewed_head_sha, HEAD);
  assert.equal(completed.votesCleared, 0);

  // A new same-specification intent uses a new UUID; its retries after
  // completion retain that UUID instead of being confused with a new run.
  const requestId = randomUUID();
  const explicit = await f.resubmit({ recheck: true, recheckRequestId: requestId });
  assert.notEqual(explicit.checksRequest.workId, workId);
  await tick(f.make());
  assert.equal((await f.resubmit({ recheck: true, recheckRequestId: requestId })).checksRequest.workId,
    explicit.checksRequest.workId);
});

test('native adapter requires a command identity and reports admission-off waiting instead of completed recovery', { skip: !enabled }, async t => {
  const f = await setup(t);
  const session = await f.session();
  const baseline = await continuationCount(f);
  assert.equal((await adapter.recheckSessionChecks({ config: f.config, pool: f.pool, session,
    reason: 'manual-recheck' })).code, 'recheck_request_id_required');
  assert.equal((await f.work.recover(1, { force: true })).code, 'native_recheck_command_required');
  assert.equal((await adapter.recheckSessionChecks({ config: f.config, pool: f.pool, session,
    reason: 'orphaned-run' })).status, 'observed');
  f.config.nativeManualPreviewEnabled = false;
  const waiting = await f.resubmit();
  assert.equal(waiting.checksRerun, false);
  assert.equal(waiting.checksRequest.code, 'native_admission_disabled');
  assert.equal((await f.session()).testing_paths, null);
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal(await continuationCount(f), baseline);
  f.config.nativeManualPreviewEnabled = true;
  const accepted = await f.resubmit();
  f.config.nativeManualPreviewEnabled = false;
  f.use(f.make());
  await tick(f.make());
  const replay = await f.resubmit();
  assert.equal(replay.checksRequest.workId, accepted.checksRequest.workId);
  assert.equal((await f.session()).check_state, 'passing');
});

test('native metadata rollback preserves verdict, metadata and journals; unresolved consumers remain retryable', { skip: !enabled }, async t => {
  const f = await setup(t);
  const baseline = await continuationCount(f);
  const traces = (await f.work.owner.trace(1)).length;
  const enqueue = f.work.store.enqueue;
  f.work.store.enqueue = async (...args) => { await enqueue(...args); throw new Error('Interrupted recheck enqueue'); };
  await assert.rejects(f.resubmit(), /Interrupted recheck enqueue/);
  assert.equal((await f.session()).testing_paths, null);
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal(await continuationCount(f), baseline);
  assert.equal((await f.work.owner.trace(1)).length, traces);
  f.work.store.enqueue = enqueue;

  const runs = require('../src/services/check-runs');
  const runId = randomUUID();
  const flowId = (await f.work.owner.read(1)).handoff.flow_id;
  await runs.record(f.pool, { sessionId: 1, runId, commitSha: HEAD, manifest: {
    durableNative: true, previewFlowId: flowId, launched: true,
    unitSuite: { version: 1, state: 'not-required' },
  } });
  const waiting = await f.resubmit();
  assert.equal(waiting.checksRerun, false);
  assert.equal(waiting.checksRequest.code, 'checks_consumers_unresolved');
  assert.equal((await f.session()).testing_paths, null);
  assert.equal((await f.work.owner.trace(1)).length, traces);
  // Missing manifest alone cannot erase the reserved consumer obligation.
  const record = await runs.read(f.pool, runId, 1);
  await runs.finish(f.pool, runId);
  assert.equal((await f.resubmit()).checksRequest.code, 'checks_consumers_unresolved');
  await runs.record(f.pool, { sessionId: 1, runId, commitSha: HEAD, manifest: record.manifest });
  t.mock.method(require('../src/services/kubernetes'), 'retireCheckResources', async (_config, _sessionId, _runId, options) => {
    const retirement = { version: 1, jobs: [{ kind: 'capture', stage: 'released',
      job: { name: 'old', uid: 'old-job' }, input: { name: 'old-input', uid: 'old-input' } }] };
    await options.persist(retirement);
    return retirement;
  });
  assert.equal((await require('../src/services/check-retirement').retire(f.config, f.pool, 1, runId)).complete, true);
  await runs.finish(f.pool, runId);
  assert.equal((await f.resubmit()).checksRerun, true);
});

test('native producer supersession makes queued same-head recheck obsolete and cannot publish the old verdict', { skip: !enabled }, async t => {
  const f = await setup(t);
  const accepted = await f.resubmit();
  await f.pool.query("UPDATE chat_sessions SET status = 'active' WHERE id = 1");
  const successor = await f.work.admitManual({ session: await f.session(), headSha: NEXT,
    userId: 1, kind: 'deploy', requestId: randomUUID() });
  assert.equal(successor.accepted, true);
  const before = (await f.session()).staging_runtime_name;
  await tick(f.make({ capture: async () => assert.fail('Obsolete recheck cannot create Jobs') }));
  assert.equal((await f.work.store.read(accepted.checksRequest.workId)).last_code, 'handoff_obsolete');
  assert.equal((await f.session()).checks_commit_sha, NEXT);
  assert.equal((await f.session()).staging_runtime_name, before);
  assert.equal(await require('../src/services/visuals').storeChecks(f.pool, 1, HEAD, { state: 'passing', results: [] }), false);
  const stale = await adapter.recheckSessionChecks({ config: f.config, pool: f.pool,
    session: { ...(await f.session()), checks_commit_sha: HEAD }, reason: 'manual-recheck', requestId: randomUUID() });
  assert.equal(stale.status, 'waiting');
  assert.equal(stale.code, 'superseded_handoff');
});

test('native metadata A → B → A represents three intents while each completion retry remains stable', { skip: !enabled }, async t => {
  const f = await setup(t);
  const first = await f.resubmit();
  await tick(f.make());
  const second = await f.resubmit({ testing: { testingPaths: ['/other'] } });
  await tick(f.make());
  const third = await f.resubmit();
  assert.equal(new Set([first, second, third].map(result => result.checksRequest.workId)).size, 3);
  await tick(f.make());
  assert.equal((await f.resubmit()).checksRequest.workId, third.checksRequest.workId);
  assert.equal((await f.session()).testing_path, '/changed');
});

test('native metadata continuation recovers a running original capture through lifecycle and harvest', { skip: !enabled }, async t => {
  const f = await setup(t);
  const requested = await f.resubmit();
  const runId = randomUUID();
  const flowId = (await f.work.owner.read(1)).handoff.flow_id;
  const runs = require('../src/services/check-runs');
  const lifecycle = require('../src/services/preview-lifecycle');
  const local = lifecycle.createLifecycle({ poolFor: () => f.pool, lock: async (_c, _k, _id, run) => run() });
  t.mock.method(lifecycle, 'adopt', local.adopt);
  t.mock.method(lifecycle, 'settleAdopted', local.settleAdopted);
  let creations = 0;
  await tick(f.make({ async capture(_config, session, _app, head) {
    creations++;
    await f.pool.query(`INSERT INTO preview_operations
      (session_id, desired_revision, run_id, revision, phase, state)
      VALUES (1,$1,$2,$1,'capture','running')`, [head, runId]);
    await runs.record(f.pool, { runId, sessionId: session.id, commitSha: head, manifest: {
      durableNative: true, previewFlowId: flowId, launched: true,
      unitSuite: { version: 1, state: 'not-required' },
    } });
    throw new Error('Worker lost while original capture is running');
  } }));
  const kubernetes = require('../src/services/kubernetes');
  const visuals = require('../src/services/visuals');
  const job = { name: 'original-capture', uid: 'original-capture-uid' };
  t.mock.method(kubernetes, 'findCheckJobs', async () => ({ capture: job, unitSuite: null }));
  t.mock.method(kubernetes, 'collectCheckJob', async (_config, observed) => {
    assert.equal(observed.name, job.name);
    return { state: 'succeeded', stdout: 'injected assertion frames', stderr: '', exitCode: 0 };
  });
  t.mock.method(kubernetes, 'runCaptureJob', async () => assert.fail('Competing capture execution'));
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => assert.fail('Competing companion execution'));
  t.mock.method(kubernetes, 'retireCheckResources', async (_config, sessionId, observedRun, options) => {
    assert.equal(sessionId, 1);
    assert.equal(observedRun, runId);
    const retirement = { version: 1, jobs: [{ kind: 'capture', stage: 'released', job,
      input: { name: 'original-input', uid: 'original-input-uid' } }] };
    await options.persist(retirement);
    return retirement;
  });
  t.mock.method(visuals, 'scheduleShots', () => {});
  t.mock.method(visuals, 'maybeAutoMergeAfterChecks', () => {});
  t.mock.method(visuals, 'noteBotChecksAfterChecks', () => {});
  t.mock.method(visuals, 'settleCaptureRun', async (_config, pool, run) => {
    assert.equal(run.commitHash, HEAD);
    await visuals.storeChecks(pool, 1, HEAD, { state: 'passing', results: [] });
    return { traceStatus: 'passing', result: { state: 'passing' } };
  });
  const restarted = f.make({ async capture(config, session) {
    const previous = (await f.pool.query('SELECT * FROM preview_operations WHERE session_id = 1')).rows[0];
    const adopted = await require('../src/services/cli-preview-handoff/checks').recoverCaptureRun(config,
      { pool: f.pool, session, previous, force: true });
    assert.equal(adopted.handled, true);
  } });
  await due(f);
  await tick(restarted);
  assert.equal(creations, 1);
  assert.equal((await restarted.store.read(requested.checksRequest.workId)).status, 'succeeded');
  assert.equal((await f.pool.query('SELECT run_id, state FROM preview_operations WHERE session_id = 1')).rows[0].run_id, runId);
  assert.equal((await f.pool.query('SELECT state FROM preview_operations WHERE session_id = 1')).rows[0].state, 'completed');
  assert.equal(await runs.read(f.pool, runId, 1), null);
  const resource = (await f.pool.query('SELECT consumer_releases FROM preview_flow_resources WHERE flow_id = $1', [flowId])).rows[0];
  assert.equal(resource.consumer_releases[runId].retirement.jobs[0].job.uid, job.uid);
  assert.equal((await f.session()).approval_epoch, 7);
});

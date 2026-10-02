'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { fixtureFor } = require('./lib/complete-preparation-fixture');
const { addChecksTables } = require('./lib/cli-checks-fixture');
const { sanitizedEnvironment } = require('./lib/isolated-kpack-fixture');
const checkRuns = require('../src/services/check-runs');
const retirement = require('../src/services/check-retirement');
const harvest = require('../src/services/check-harvest');
const kubernetes = require('../src/services/kubernetes');

const isolated = process.env.RUN_ISOLATED_KPACK_TEST === '1';

test('C11 actual destructive retirement resumes across live errors and harvest loss', { skip: !isolated }, async t => {
  const f = await fixtureFor(t, { requireUnitSuite: true });
  await addChecksTables(f.pool);
  const namespace = f.config.kubernetes.workerNamespace;
  const originalFlag = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  t.after(() => {
    if (originalFlag === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = originalFlag;
  });
  const evidence = [];
  const createJob = f.clients.batch.createNamespacedJob.bind(f.clients.batch);
  f.clients.batch.createNamespacedJob = params => {
    assert.equal(params.namespace, namespace);
    // Fixture timing only. Consumer-stop inspection remains mandatory.
    params.body.spec.template.spec.terminationGracePeriodSeconds = 1;
    return createJob(params);
  };

  async function makeJob(runId, running) {
    let receipt;
    const options = {
      sessionId: f.sessionId, previewRunId: runId, env: { TEST_TOKEN: 'isolated' },
      cmd: ['node', '-e', running ? 'setTimeout(() => {}, 120000)' : 'console.log("terminal fixture consumer")'],
      cpus: '100m', memory: '128m', retainInputForRetirement: true,
      onJobCreated: async identity => {
        receipt = identity;
        if (running) throw Object.assign(new Error('Fixture leaves actual consumer running'), { code: 'FIXTURE_RUNNING' });
      },
    };
    try { await kubernetes.runUnitSuiteJob(f.config, options); }
    catch (error) { if (error.code !== 'FIXTURE_RUNNING') throw error; }
    return receipt;
  }

  async function interrupt(mode, phase, loss) {
    const child = fork(require.resolve('./lib/checks-retirement-child'), [], {
      execArgv: [], env: sanitizedEnvironment(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    let timer;
    const observed = new Promise((resolve, reject) => {
      child.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message));
      child.once('exit', code => reject(new Error(`Retirement child exited ${code} before boundary`)));
      timer = setTimeout(() => reject(new Error(`Timed out at actual ${mode}/${phase}/${loss}`)), 180000);
    });
    child.send({ databaseUrl: f.url, sessionId: f.sessionId, mode, phase, loss });
    let message;
    try { message = await observed; }
    finally {
      clearTimeout(timer);
      if (loss === 'interruption' || !message) child.kill('SIGKILL');
      await exited;
    }
    assert.equal(message.phase, phase);
    return message;
  }

  for (const mode of ['harvest', 'live-error']) {
    for (const loss of ['interruption', 'reply']) {
      for (const phase of ['job-deleted', 'consumers-stopped', 'input-deleted']) {
        await t.test(`${mode}: ${loss} after ${phase}`, async () => {
          const head = randomUUID().replaceAll('-', '').padEnd(40, 'a');
          await f.pool.query(`UPDATE chat_sessions SET checks_commit_sha = $2, check_state = $3,
            check_phase = 'testing', imported_pr_head_sha = NULL WHERE id = $1`,
          [f.sessionId, head, mode === 'harvest' ? 'error' : 'pending']);
          let runId;
          if (mode === 'harvest') {
            runId = randomUUID();
            const job = await makeJob(runId, phase === 'job-deleted');
            await checkRuns.record(f.pool, { runId, sessionId: f.sessionId, commitSha: head, manifest: {
              durableCli: true, launched: true, shotsOnly: true, media: false,
              unitSuite: { version: 1, state: 'observed', job },
            } });
            await f.pool.query(`INSERT INTO preview_operations
              (session_id, run_id, desired_revision, revision, phase, state)
              VALUES ($1,$2,$3,$3,'capture','running') ON CONFLICT (session_id) DO UPDATE
              SET run_id = $2, desired_revision = $3, revision = $3, phase = 'capture', state = 'running'`,
            [f.sessionId, runId, head]);
          }
          const boundary = await interrupt(mode, phase, loss);
          let row = (await f.pool.query('SELECT * FROM check_runs WHERE session_id = $1', [f.sessionId])).rows[0];
          runId = row.run_id;
          const receipt = row.manifest.retirement.jobs[0];
          assert.equal(phase === 'input-deleted' ? receipt.input.uid : receipt.job.uid, boundary.identity.uid);
          assert.ok(receipt.input.uid, 'Input identity is persisted before destructive cleanup');
          assert.equal(receipt.stage, { 'job-deleted': 'deleting-job', 'consumers-stopped': 'stopped',
            'input-deleted': 'deleting-input' }[phase]);
          if (phase === 'job-deleted') {
            await assert.rejects(f.clients.batch.readNamespacedJob({ namespace, name: receipt.job.name }),
              error => Number(error.code) === 404);
          }
          if (phase === 'input-deleted') {
            await assert.rejects(f.clients.core.readNamespacedSecret({ namespace, name: receipt.input.name }),
              error => Number(error.code) === 404);
          }

          // An actual separately owned successor consumer must survive old-run cleanup.
          const successorRun = randomUUID();
          const successor = await makeJob(successorRun, true);
          const successorJob = await f.clients.batch.readNamespacedJob({ namespace, name: successor.name });
          const secretNames = successorJob.spec.template.spec.containers[0].env
            .map(variable => variable.valueFrom?.secretKeyRef?.name).filter(Boolean);
          const successorInput = await f.clients.core.readNamespacedSecret({ namespace, name: secretNames[0] });
          const newerLifecycle = phase === 'input-deleted';
          if (newerLifecycle) {
            await f.pool.query(`UPDATE preview_operations SET run_id = $2, desired_revision = $3,
              revision = $3, state = 'running' WHERE session_id = $1`, [f.sessionId, successorRun, 'b'.repeat(40)]);
            await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1',
              [f.sessionId, 'b'.repeat(40)]);
          }
          const before = (await f.pool.query('SELECT checks_commit_sha, check_state, test_results FROM chat_sessions WHERE id = $1',
            [f.sessionId])).rows[0];
          const resumed = await harvest.adopt(f.config, f.pool, row, { retireJobs: true });
          assert.equal(resumed.outcome, 'moot');
          assert.equal(await checkRuns.read(f.pool, runId, f.sessionId), null);
          assert.equal((await f.clients.batch.readNamespacedJob({ namespace, name: successor.name })).metadata.uid, successor.uid);
          assert.equal((await f.clients.core.readNamespacedSecret({ namespace, name: successorInput.metadata.name })).metadata.uid,
            successorInput.metadata.uid);
          await assert.rejects(f.clients.core.readNamespacedSecret({ namespace, name: receipt.input.name }),
            error => Number(error.code) === 404);
          const lifecycle = (await f.pool.query('SELECT * FROM preview_operations WHERE session_id = $1', [f.sessionId])).rows[0];
          assert.equal(lifecycle.state, newerLifecycle ? 'running' : 'completed');
          assert.equal(lifecycle.run_id, newerLifecycle ? successorRun : runId);
          assert.deepEqual((await f.pool.query('SELECT checks_commit_sha, check_state, test_results FROM chat_sessions WHERE id = $1',
            [f.sessionId])).rows[0], before);
          await f.assertServing();
          evidence.push({ mode, loss, phase, job: receipt.job, input: receipt.input });

          await checkRuns.record(f.pool, { runId: successorRun, sessionId: f.sessionId, commitSha: head, manifest: {
            durableCli: true, launched: true, shotsOnly: true, media: false,
            unitSuite: { version: 1, state: 'observed', job: successor },
          } });
          assert.equal((await retirement.retire(f.config, f.pool, f.sessionId, successorRun)).complete, true);
          await checkRuns.finish(f.pool, successorRun);
        });
      }
    }
  }
  t.diagnostic(JSON.stringify({ evidence, actual: 'PostgreSQL journal/lifecycle, Kubernetes Jobs/Pods/Secrets and serving runtime',
    substituted: 'small consumer command in the immutable unit fixture image, admitted manifest, terminal error verdict, one-second fixture termination grace; SIGKILL and lost replies after actual effects' }));
});

'use strict';

const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const checkRuns = require('../../src/services/check-runs');
const kubernetes = require('../../src/services/kubernetes');
const harvest = require('../../src/services/check-harvest');
const { createLifecycle } = require('../../src/services/preview-lifecycle');

process.once('message', async ({ databaseUrl, sessionId, mode, phase, loss }) => {
  try {
    if (process.env.RUN_ISOLATED_KPACK_TEST !== '1'
        || !['harvest', 'live-error'].includes(mode)
        || !['job-deleted', 'consumers-stopped', 'input-deleted'].includes(phase)
        || !['interruption', 'reply'].includes(loss)) throw new Error('Known isolated retirement scenario required');
    const verified = await verifyIsolatedBuildFixture({ databaseUrl, requireUnitSuite: true });
    kubernetes._setClientsForTest(verified.clients);
    process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
    const pool = new Pool({ connectionString: databaseUrl });
    const config = { ...verified.fixture.config, databaseUrl };
    let injected = false;
    let observed = null;

    async function fault(boundary, identity) {
      if (boundary !== phase || injected) return;
      injected = true;
      observed = identity;
      if (loss === 'interruption') {
        process.send({ phase, identity });
        await new Promise(() => {});
      }
      throw new Error(`Injected lost ${boundary} acknowledgment`);
    }

    const { batch, core } = verified.clients;
    const createJob = batch.createNamespacedJob.bind(batch);
    batch.createNamespacedJob = params => {
      if (params.namespace !== verified.fixture.isolation.namespace.name) throw new Error('Fixture namespace required');
      params.body.spec.template.spec.terminationGracePeriodSeconds = 1;
      return createJob(params);
    };
    const deleteJob = batch.deleteNamespacedJob.bind(batch);
    batch.deleteNamespacedJob = async request => {
      const result = await deleteJob(request);
      const deadline = Date.now() + 60000;
      for (;;) {
        try { await batch.readNamespacedJob({ namespace: request.namespace, name: request.name }); }
        catch (error) { if (Number(error.code) === 404) break; throw error; }
        if (Date.now() >= deadline) throw new Error('Actual Job deletion must finish before interruption');
        await delay(250);
      }
      await fault('job-deleted', { name: request.name, uid: request.body.preconditions.uid });
      return result;
    };
    const deleteInput = core.deleteNamespacedSecret.bind(core);
    core.deleteNamespacedSecret = async request => {
      const result = await deleteInput(request);
      await fault('input-deleted', { name: request.name, uid: request.body.preconditions.uid });
      return result;
    };
    const write = checkRuns.recordRetirement;
    checkRuns.recordRetirement = async (...args) => {
      const result = await write(...args);
      const job = args[4].jobs.find(item => item.stage === 'stopped');
      if (job) await fault('consumers-stopped', { ...job.job, input: job.input });
      return result;
    };

    if (mode === 'harvest') {
      const row = (await pool.query('SELECT * FROM check_runs WHERE session_id = $1', [sessionId])).rows[0];
      const result = await harvest.adopt(config, pool, row, { retireJobs: true });
      if (loss === 'reply' && result.outcome !== 'failed') throw new Error(`Expected failed retirement: ${result.outcome}`);
    } else {
      const lifecycle = createLifecycle({ poolFor: () => pool });
      const session = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [sessionId])).rows[0];
      try {
        await lifecycle.run(config, session, session.checks_commit_sha, 'capture', async operation => {
          operation.durableChecks = true;
          const recorded = await checkRuns.record(pool, { runId: operation.runId, sessionId,
            commitSha: session.checks_commit_sha, manifest: {
              durableCli: true, launched: true, shotsOnly: true, media: false,
              unitSuite: { version: 1, state: 'submitted' },
            } });
          if (!recorded) throw new Error('Required isolated manifest unavailable');
          await kubernetes.runUnitSuiteJob(config, {
            sessionId, previewRunId: operation.runId, env: { TEST_TOKEN: 'isolated' },
            cmd: ['node', '-e', phase === 'job-deleted' ? 'setTimeout(() => {}, 120000)' : 'console.log("terminal fixture consumer")'],
            cpus: '100m', memory: '128m', retainInputForRetirement: true, signal: operation.signal,
            onJobCreated: phase === 'job-deleted' ? async () => { throw new Error('Injected live observer failure'); } : null,
          });
          throw new Error('Injected live settlement failure');
        }, { force: true,
          onError: (error, guardedPool) => require('../../src/services/visuals').storeChecks(
            guardedPool, sessionId, session.checks_commit_sha, { state: 'error', results: [] }, error.message),
        });
      } catch (error) {
        if (!injected) throw error;
      }
    }
    if (!injected) throw new Error(`Actual retirement never reached ${phase}`);
    process.send({ phase, identity: observed, acknowledgmentLost: true });
    await pool.end();
    await require('../../src/db/pool').getPool(config).end();
    process.exit(0);
  } catch (error) {
    process.send({ error: error.stack });
    process.exit(1);
  }
});

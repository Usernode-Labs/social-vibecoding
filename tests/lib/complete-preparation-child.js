'use strict';

const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { completePreparationWorker } = require('./complete-preparation-worker');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { PREPARE_RUNTIME } = require('../../src/services/preview-flow/work');

process.once('message', async ({ databaseUrl, pauseAt }) => {
  try {
    const phases = ['source_prepared', 'clone_complete', 'build_created', 'build_succeeded', 'created_secret', 'healthy', 'accepted'];
    if (process.env.RUN_ISOLATED_KPACK_TEST !== '1' || !phases.includes(pauseAt)) {
      throw new Error('Known interruption phase and isolated fixture required');
    }
    const verified = await verifyIsolatedBuildFixture({ databaseUrl });
    require('../../src/services/kubernetes')._setClientsForTest(verified.clients);
    const pool = new Pool({ connectionString: databaseUrl, ssl: false });
    const assembled = completePreparationWorker(pool, verified, {
      async onPhase(phase) {
        if (phase !== pauseAt) return;
        process.send({ phase });
        await new Promise(() => {});
      },
    });
    const handler = assembled.work.handlers[PREPARE_RUNTIME];
    const run = handler.run;
    handler.run = async context => {
      try {
        return await run(context);
      } catch (error) {
        process.send({ error: error.message });
        throw error;
      }
    };

    for (;;) {
      const worker = createExecutionWorker({
        store: assembled.work.store,
        handlers: { [PREPARE_RUNTIME]: assembled.work.handlers[PREPARE_RUNTIME] },
        concurrency: 1,
      });
      await worker.tick();
      await worker.drain();
      await delay(1000);
    }
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  }
});

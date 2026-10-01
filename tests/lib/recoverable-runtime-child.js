'use strict';

const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { runtimeTestWorker } = require('./runtime-test-worker');

process.once('message', async ({ databaseUrl, pauseAt }) => {
  try {
    if (process.env.RUN_ISOLATED_KPACK_TEST !== '1' || !['created_secret', 'created_service', 'healthy'].includes(pauseAt)) {
      throw new Error('Explicit isolated runtime fixture and known interruption phase required');
    }
    const { fixture, clients } = await verifyIsolatedBuildFixture({ databaseUrl });
    if (!fixture.runtimeImage) throw new Error('Dedicated runtime image is required');
    require('../../src/services/kubernetes')._setClientsForTest(clients);
    const pool = new Pool({ connectionString: databaseUrl, ssl: false });
    const { work } = runtimeTestWorker(pool, fixture, clients, {
      async onObservation(phase) {
        if (phase !== pauseAt) return;
        process.send({ phase });
        await new Promise(() => {});
      },
    });
    const handler = work.handlers['native-preview-kubernetes-prepare'];
    const run = handler.run;
    handler.run = async context => {
      try {
        const outcome = await run(context);
        if (outcome.outcome !== 'waiting') process.send({ unexpectedOutcome: outcome });
        return outcome;
      } catch (error) {
        process.send({ error: error.message });
        throw error;
      }
    };
    for (;;) {
      const worker = createExecutionWorker({ store: work.store, handlers: work.handlers });
      await worker.tick();
      await worker.drain();
      await delay(1000);
    }
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  }
});

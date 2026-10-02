'use strict';

const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { completePreparationWorker } = require('./complete-preparation-worker');
const { actualChecksWorker } = require('./cli-checks-fixture');
const { createExecutionWorker } = require('../../src/services/execution/worker');

process.once('message', async ({ databaseUrl, phase }) => {
  try {
    if (process.env.RUN_ISOLATED_KPACK_TEST !== '1'
        || !['checks_running', 'verdict_persisted', 'unit_running', 'unit_creation_submitted'].includes(phase)) throw new Error('Known isolated checks phase required');
    const verified = await verifyIsolatedBuildFixture({ databaseUrl, requireUnitSuite: phase.startsWith('unit_') });
    require('../../src/services/kubernetes')._setClientsForTest(verified.clients);
    const pool = new Pool({ connectionString: databaseUrl });
    const assembled = completePreparationWorker(pool, verified);
    const actual = actualChecksWorker({ ...verified, ...assembled, pool }, {
      startupDelay: phase === 'checks_running',
      unitSuite: phase.startsWith('unit_'),
      delayUnitCreation: phase === 'unit_creation_submitted',
      async onPhase(observed, identity) {
        if (observed !== phase) return;
        process.send({ phase, identity });
        await new Promise(() => {});
      },
    });
    for (;;) {
      // drain() closes a worker; each test polling cycle uses a fresh one.
      const worker = createExecutionWorker({ store: actual.work.store, handlers: actual.work.handlers, concurrency: 1 });
      await worker.tick();
      await worker.drain();
      await delay(1000);
    }
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  }
});

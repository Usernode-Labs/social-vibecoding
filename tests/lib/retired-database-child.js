'use strict';

const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { RETIRE } = require('../../src/services/preview-flow/work');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { databaseWorker } = require('./database-runtime-fixture');

process.once('message', async ({ databaseUrl, flowId, pauseAt }) => {
  try {
    if (process.env.RUN_ISOLATED_KPACK_TEST !== '1'
        || !['retirement_committed', 'database_removed'].includes(pauseAt)) {
      throw new Error('Explicit disposable fixture and known retirement phase required');
    }
    const { fixture, clients, databaseAddress } = await verifyIsolatedBuildFixture({ databaseUrl });
    if (!fixture.databaseRuntimeImage || !databaseAddress) throw new Error('Verified database runtime prerequisites required');
    fixture.runtimeImage = fixture.databaseRuntimeImage;
    require('../../src/services/kubernetes')._setClientsForTest(clients);
    const pool = new Pool({ connectionString: databaseUrl });
    const { work } = databaseWorker(pool, fixture, clients, databaseAddress, {
      async onPhase(phase) {
        if (phase !== pauseAt) return;
        process.send({ phase });
        await new Promise(() => {});
      },
    });
    await work.census();
    const { rows: [request] } = await pool.query(`SELECT id FROM execution_work_requests
      WHERE workflow = $1 AND input->>'flowId' = $2`, [RETIRE, flowId]);
    if (!request) throw new Error('Expected durable retirement obligation');
    for (;;) {
      await pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [request.id]);
      const worker = createExecutionWorker({
        store: work.store,
        handlers: { [RETIRE]: work.handlers[RETIRE] },
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

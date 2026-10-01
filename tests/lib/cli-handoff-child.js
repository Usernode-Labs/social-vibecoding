'use strict';

const { Pool } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { completePreparationWorker } = require('./complete-preparation-worker');
const { handoffWorker } = require('./cli-handoff-fixture');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { PREPARE_RUNTIME } = require('../../src/services/preview-flow/work');
const { CONTINUE } = require('../../src/services/cli-preview-handoff/work');

process.once('message', async ({ databaseUrl, sessionId, phase }) => {
  try {
    if (process.env.RUN_ISOLATED_KPACK_TEST !== '1'
        || !['admitted', 'candidate_committed', 'activation_reply_lost', 'activated', 'checks_stored'].includes(phase)) {
      throw new Error('Explicit isolated fixture and known C8 phase required');
    }
    const verified = await verifyIsolatedBuildFixture({ databaseUrl });
    require('../../src/services/kubernetes')._setClientsForTest(verified.clients);
    process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
    const pool = new Pool({ connectionString: databaseUrl, ssl: false });
    const assembled = completePreparationWorker(pool, verified);
    const work = handoffWorker({ ...verified, ...assembled, pool }, {
      loseActivationReply: phase === 'activation_reply_lost',
      async onPhase(observed) {
        if (observed !== phase) return;
        process.send({ phase });
        await new Promise(() => {});
      },
    });
    if (phase === 'admitted') {
      const session = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [sessionId])).rows[0];
      await work.admit({ session, headSha: verified.fixture.preparationSource.revision });
      process.send({ phase });
      await new Promise(() => {});
    }
    for (;;) {
      const selected = phase === 'candidate_committed' ? PREPARE_RUNTIME : CONTINUE;
      const worker = createExecutionWorker({ store: work.store, handlers: { [selected]: work.handlers[selected] }, concurrency: 1 });
      await worker.tick();
      await worker.drain();
      await delay(1000);
    }
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  }
});

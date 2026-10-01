'use strict';

const { createCloneOperations } = require('../../src/services/preview-flow/clone-operation');
const { createPreviewWork } = require('../../src/services/preview-flow/work');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { Pool } = require('pg');

async function runAdmittedWork(platformUrl, config, clones) {
  const pool = new Pool({ connectionString: platformUrl });
  try {
    const preview = createPreviewWork(pool, config, {
      clones,
      inspect: async () => ({ present: false, receipt: null }),
      prepare: async () => { throw new Error('Child must interrupt before runtime preparation'); },
    });
    const worker = createExecutionWorker({ store: preview.store, handlers: preview.handlers, concurrency: 1 });
    await worker.tick();
    await worker.drain();
    return { completed: true };
  } finally {
    await pool.end();
  }
}

process.on('message', async ({ databaseUrl, intent, password, stopAfter, platformUrl, config }) => {
  try {
    const clones = createCloneOperations({
      databaseUrl,
      maintenanceDatabase: 'postgres',
      ensureTemplate: async source => ({ template: `${source}_stgtmpl` }),
      async onPhase(phase) {
        if (phase !== stopAfter) return;
        process.send({ phase });
        await new Promise(() => {});
      },
    });
    const result = platformUrl
      ? await runAdmittedWork(platformUrl, config, clones)
      : await clones.prepare(intent, password);
    process.send({ result });
    process.disconnect();
  } catch (error) {
    process.send({ error: error.message });
    process.disconnect();
  }
});

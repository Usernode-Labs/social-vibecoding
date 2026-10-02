'use strict';

const { verifyDisposablePostgres } = require('./disposable-postgres');

const { createCloneOperations } = require('../../src/services/preview-flow/clone-operation');
process.on('message', async ({ databaseUrl, intent, password, stopAfter }) => {
  try {
    await verifyDisposablePostgres(databaseUrl, { maintenanceDatabase: true });

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
    const result = await clones.prepare(intent, password);
    process.send({ result });
    process.disconnect();
  } catch (error) {
    process.send({ error: error.message });
    process.disconnect();
  }
});

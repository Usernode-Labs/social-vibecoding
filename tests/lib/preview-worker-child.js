'use strict';

const { verifyDisposablePostgres } = require('./disposable-postgres');

const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { createPreviewWork } = require('../../src/services/preview-flow/work');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { createExecutionStore } = require('../../src/services/execution/store');

process.on('message', async ({ databaseUrl, stopAfterCreate }) => {
  await verifyDisposablePostgres(databaseUrl);

  const pool = new Pool({ connectionString: databaseUrl });
  const config = { databaseUrl, appRuntime: 'docker', dataEncryptionKey: 'test-encryption-key' };
  const store = createExecutionStore(pool, { leaseMs: 1000 });
  const preview = createPreviewWork(pool, config, {
    store,
    async inspect(_config, intent) {
      const row = (await pool.query('SELECT receipt FROM objects WHERE name = $1', [intent.runtimeName])).rows[0];
      return { present: !!row, receipt: row?.receipt || null };
    },
    async prepare(_config, session, app, head, candidate) {
      await candidate.onClonePrepared();
      const receipt = {
        commitSha: head, stagingUrl: `http://${candidate.intent.runtimeName}:3000`,
        runtimeKind: 'docker', runtimeName: candidate.intent.runtimeName,
        containerId: candidate.intent.runtimeName, imageRef: 'child:image', buildRef: null,
        physicalId: randomUUID(), attemptId: candidate.intent.attemptId,
      };
      await pool.query('INSERT INTO objects VALUES ($1, $2)', [receipt.runtimeName, JSON.stringify(receipt)]);
      process.send({ created: true });
      if (stopAfterCreate) await new Promise(() => {});
      return receipt;
    },
  });
  const worker = createExecutionWorker({ store, handlers: preview.handlers, concurrency: 1 });
  await worker.tick();
  if (stopAfterCreate) return;
  await worker.drain();
  await pool.end();
  process.send({ completed: true });
  process.disconnect();
});

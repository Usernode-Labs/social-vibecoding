'use strict';

const { Pool } = require('pg');
const { createPreviewWork } = require('../../src/services/preview-flow/work');
const { createExecutionStore } = require('../../src/services/execution/store');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { createImageBuildOperations } = require('../../src/services/preview-flow/image-build-operation');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');

process.once('message', async ({ databaseUrl, config, apiUrl, runScript = null }) => {
  try {
    let clients;
    if (process.env.RUN_ISOLATED_KPACK_TEST === '1') {
      if (apiUrl) throw new Error('Actual integration cannot substitute an injected API');
      const verified = await verifyIsolatedBuildFixture({ databaseUrl });
      clients = verified.clients;
      config = {
        ...verified.fixture.config,
        dataEncryptionKey: 'disposable-integration-only',
      };
      runScript = verified.fixture.runScript;
    } else {
      // Injected HTTP fixtures are separate from actual-resource integration.
      if (process.env.RUN_INJECTED_BUILD_TEST !== '1' || !apiUrl) {
        throw new Error('Explicit isolated integration or injected test mode required');
      }
      const api = new URL(apiUrl);
      const database = new URL(databaseUrl);
      const localApi = api.protocol === 'http:' && api.hostname === '127.0.0.1' && api.port
        && !api.username && !api.password && !api.search && !api.hash;
      const localDatabase = database.protocol === 'postgresql:' && database.hostname === '127.0.0.1' && database.port;
      const scopedDatabase = [...database.searchParams.keys()].every(key => key === 'options')
        && database.searchParams.size <= 1
        && (!database.searchParams.has('options') || /^-c search_path=execution_[0-9_]+$/.test(database.searchParams.get('options')));
      if (!localApi || !localDatabase || !scopedDatabase) {
        throw new Error('Injected child requires explicit loopback API and database destinations');
      }
      const k8s = require('@kubernetes/client-node');
      const kc = new k8s.KubeConfig();
      kc.loadFromOptions({
        clusters: [{ name: 'isolated', server: apiUrl, skipTLSVerify: true }],
        users: [{ name: 'test' }],
        contexts: [{ name: 'test', cluster: 'isolated', user: 'test' }],
        currentContext: 'test',
      });
      clients = { custom: kc.makeApiClient(k8s.CustomObjectsApi), core: kc.makeApiClient(k8s.CoreV1Api) };
    }

    config = { ...config, databaseUrl };
    require('../../src/services/kubernetes')._setClientsForTest(clients);
    const pool = new Pool({ connectionString: databaseUrl, ssl: false });
    const store = createExecutionStore(pool, { leaseMs: 2000 });
    const images = createImageBuildOperations({
      clients: () => clients,
      async onObservation(phase) {
        if (phase !== 'created') return;
        process.send({ phase });
        await new Promise(() => {});
      },
    });
    const work = createPreviewWork(pool, config, {
      store,
      images,
      inspect: async () => ({ present: false, receipt: null }),
      clones: { prepare: async () => ({ status: 'complete', databaseOid: '123' }) },
      async prepare(_config, _session, _app, _head, candidate) {
        await candidate.prepareImage(runScript);
        throw new Error('The interruption fixture must stop before runtime preparation');
      },
    });
    const handler = work.handlers['native-preview-kpack-prepare'];
    const run = handler.run;
    handler.run = async context => {
      try {
        const result = await run(context);
        process.send({ unexpectedOutcome: result });
        return result;
      } catch (error) {
        process.send({ error: error.message });
        throw error;
      }
    };
    const worker = createExecutionWorker({ store, handlers: work.handlers });
    await worker.tick();
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  }
});

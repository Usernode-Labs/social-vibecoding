'use strict';

// Test-only adapter assembly. Build/clone inputs are injected explicitly; all
// runtime resources, HTTP health and SQL decisions are actual in C5 integration.
const { createPreviewWork } = require('../../src/services/preview-flow/work');
const { createRuntimeOperations } = require('../../src/services/preview-flow/runtime-operation');
const { createCleanup } = require('../../src/services/preview-flow/cleanup');

const SERVER_COMMAND = ['node', '-e',
  "require('http').createServer((request,response)=>{response.end(process.env.TOKEN || 'missing')}).listen(3000,'0.0.0.0')",
];

function runtimeTestWorker(pool, fixture, clients, { owner, onObservation, loseCreate = null } = {}) {
  const config = {
    ...fixture.config,
    databaseUrl: pool.options.connectionString,
    dataEncryptionKey: 'c5-disposable-only',
    nativePreviewWorkerEnabled: true,
    nativePreviewAttempts: true,
    nativePreviewRecoverableClone: true,
    nativePreviewRecoverableBuild: true,
    nativePreviewRecoverableRuntime: true,
  };
  if (!config.databaseUrl) throw new Error('Explicit isolated database connection is required');
  const counts = { secret: 0, service: 0, deployment: 0, cloneRemovals: 0 };
  let lost = false;
  const wrapped = {};
  for (const lane of ['core', 'apps']) {
    wrapped[lane] = new Proxy(clients[lane], {
      get(target, key) {
        const kind = { createNamespacedSecret: 'secret', createNamespacedService: 'service', createNamespacedDeployment: 'deployment' }[key];
        if (kind) return async (...args) => {
          counts[kind]++;
          const result = await target[key](...args);
          if (kind === loseCreate && !lost) {
            lost = true;
            throw new Error('Injected lost acknowledgment after actual runtime creation');
          }
          return result;
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  // Real API proxy HTTP reaches the candidate ClusterIP from the local test
  // worker. TLS clients and namespace were verified by isolation preflight.
  const probe = async (_config, intent) => {
    try {
      const body = await clients.core.connectGetNamespacedServiceProxyWithPath({
        namespace: intent.namespace, name: `${intent.runtimeName}:3000`, path: 'health',
      });
      return body === 'candidate' || body === 'serving';
    } catch { return false; }
  };
  const runtimes = createRuntimeOperations({
    clients: () => wrapped, dataKey: config.dataEncryptionKey, probe, onObservation,
  });
  const image = intent => ({ status: 'succeeded', uid: `injected-build-${intent.attemptId}`, imageRef: fixture.runtimeImage });
  const images = {
    prepare: async intent => image(intent),
    inspect: async intent => image(intent),
    retire: async () => ({ status: 'retained' }),
  };
  const clones = {
    prepare: async () => ({ status: 'complete', databaseOid: '123' }),
    inspect: async () => ({ status: 'complete' }),
    async remove() { counts.cloneRemovals++; return { status: 'removed' }; },
  };
  const work = createPreviewWork(pool, config, {
    ...(owner ? { owner } : {}),
    runtimes,
    images,
    clones,
    cleanup: createCleanup({ images, clones, runtimes }).underBuildLock,
    async prepare(_config, session, app, _head, candidate) {
      const built = await candidate.prepareImage(null);
      return candidate.prepareRuntime({
        app,
        sessionId: session.id,
        imageRef: built.imageRef,
        env: { TOKEN: 'candidate' },
        command: SERVER_COMMAND,
      });
    },
  });
  return { work, runtimes, config, counts, probe };
}

module.exports = { runtimeTestWorker, SERVER_COMMAND };

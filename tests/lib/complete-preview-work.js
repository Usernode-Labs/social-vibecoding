'use strict';

// Current complete-format fixtures use production admission and named operations.
// Clone and Build success here are explicitly injected, not integration evidence.
const { createPreviewWork } = require('../../src/services/preview-flow/work');
const { createRuntimeOperations } = require('../../src/services/preview-flow/runtime-operation');
const { createInjectedRuntimeApi } = require('./injected-preview-runtime');

function completePreviewConfig(overrides = {}) {
  return {
    appRuntime: 'kubernetes',
    nativeCliPreviewHandoffEnabled: true,
    dataEncryptionKey: 'complete-fixture-only',
    ...overrides,
    kubernetes: {
      appNamespace: 'isolated',
      buildNamespace: 'isolated',
      buildEngine: 'kpack',
      builderImage: `example.test/builder@sha256:${'b'.repeat(64)}`,
      buildServiceAccount: 'builder',
      generatedAppServiceAccount: 'candidate',
      repositoryPrefix: 'example.test/images',
      cacheRepositoryPrefix: 'example.test/cache',
      nodeVersion: '22.*',
      activeDeadlineSeconds: 30,
      ...overrides.kubernetes,
    },
  };
}

function createCompletePreviewWork(pool, config, options = {}) {
  const api = createInjectedRuntimeApi();
  const imageRef = `${config.kubernetes.repositoryPrefix}/demo@sha256:${'c'.repeat(64)}`;
  const runtimes = createRuntimeOperations({
    clients: () => api.clients,
    dataKey: config.dataEncryptionKey,
    probe: async () => true,
  });
  return createPreviewWork(pool, config, {
    clones: {
      prepare: async () => ({ status: 'complete', databaseOid: '123' }),
      inspect: async () => ({ status: 'complete' }),
    },
    images: {
      prepare: async () => ({ status: 'succeeded', uid: 'injected-build', imageRef }),
      inspect: async () => ({ status: 'succeeded', uid: 'injected-build', imageRef }),
    },
    runtimes,
    async prepare(_config, _session, _app, head, candidate) {
      await candidate.prepareClone();
      const built = await candidate.prepareImage(null);
      const result = await candidate.prepareRuntime({ imageRef: built.imageRef, env: {} });
      return { ...result, commitSha: head, stagingUrl: result.url };
    },
    ...options,
  });
}

module.exports = { completePreviewConfig, createCompletePreviewWork };

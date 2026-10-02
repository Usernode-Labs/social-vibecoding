'use strict';

// PostgreSQL decision tests inject every external operation. They may run in
// the CI service database without provisioning Kubernetes. Actual-resource tests
// retain their separate fail-closed cluster/database/registry preflight.
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');

const enabled = process.env.RUN_ISOLATED_KPACK_TEST === '1'
  || process.env.PREVIEW_CONTRACT_POSTGRES_ONLY === '1';

async function readPreviewPostgresFixture() {
  if (process.env.RUN_ISOLATED_KPACK_TEST === '1') {
    const verified = await verifyIsolatedBuildFixture();
    return {
      databaseUrl: verified.fixture.isolation.database.url,
      config: {
        ...verified.fixture.config,
        kubernetes: {
          ...verified.fixture.config.kubernetes,
          workerNamespace: verified.fixture.isolation.namespace.name,
        },
      },
    };
  }

  const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL;
  if (process.env.PREVIEW_CONTRACT_POSTGRES_ONLY !== '1' || !databaseUrl) {
    throw new Error('An explicit disposable PostgreSQL contract destination is required');
  }
  return {
    databaseUrl,
    config: {
      appRuntime: 'kubernetes',
      captureRuntime: 'kubernetes',
      workerRuntime: 'kubernetes',
      kubernetes: {
        appNamespace: 'injected-apps',
        buildNamespace: 'injected-builds',
        workerNamespace: 'injected-checks',
        buildEngine: 'kpack',
        builderImage: `example.invalid/builder@sha256:${'c'.repeat(64)}`,
        buildServiceAccount: 'injected-builder',
        generatedAppServiceAccount: 'injected-candidate',
        repositoryPrefix: 'example.invalid/images',
        cacheRepositoryPrefix: 'example.invalid/cache',
        nodeVersion: '22.*',
        activeDeadlineSeconds: 900,
      },
    },
  };
}

module.exports = { enabled, readPreviewPostgresFixture };

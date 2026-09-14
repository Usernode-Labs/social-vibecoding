const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const stagingEnv = require('../src/services/staging-env');
const { stagingNeedsRebuild } = require('../src/services/staging-recovery');

const config = { iframeJwtPublicKey: 'test-public-key', kubernetes: { appNamespace: 'custom-apps' } };
const session = { id: 42, staging_url: 'https://preview.example', staging_runtime_kind: 'kubernetes',
  staging_runtime_name: 'sv-preview-7-s42', staging_commit_sha: 'abc' };

for (const scenario of ['current', 'stale', 'rolling', 'missing-label', 'missing-deployment', 'api-error', 'old-commit', 'no-config']) {
  test(`Kubernetes preview freshness: ${scenario}`, async (t) => {
    stagingEnv._resetExpected();
    t.after(() => { kubernetes._setClientsForTest(null); stagingEnv._resetExpected(); });
    const fingerprint = stagingEnv.expectedStagingFingerprint(config);
    kubernetes._setClientsForTest({ apps: { readNamespacedDeployment: async ({ name, namespace }) => {
      assert.equal(name, session.staging_runtime_name);
      assert.equal(namespace, scenario === 'no-config' ? process.env.APP_NAMESPACE || 'social-apps' : 'custom-apps');
      if (scenario === 'missing-deployment') throw Object.assign(new Error('gone'), { code: 404 });
      if (scenario === 'api-error') throw new Error('API unavailable');
      const labels = scenario === 'missing-label' ? {} : { [stagingEnv.LABEL_ENV_FP]: scenario === 'stale' ? 'old' : fingerprint };
      return { metadata: { generation: 2 }, status: { observedGeneration: 2,
        replicas: scenario === 'rolling' ? 2 : 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
      spec: { replicas: 1, template: { metadata: { labels } } } };
    } } });
    const rebuild = await stagingNeedsRebuild(session, {
      config: scenario === 'no-config' ? null : config,
      headSha: scenario === 'old-commit' ? 'def' : 'abc',
    });
    assert.equal(rebuild, ['stale', 'rolling', 'missing-label', 'missing-deployment', 'old-commit'].includes(scenario));
  });
}

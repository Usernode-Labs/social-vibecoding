// kubernetes.listPreviews: the Kubernetes side of the stale-preview sweep's
// inventory (src/services/staging-reap.js). The sweep tears down what this
// returns, so what it must NOT return matters as much as what it does:
// evidence replays share the staging label and a session id, and production
// app Deployments live in the same namespace.

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

const config = { kubernetes: { appNamespace: 'social-apps' } };

function deployment(name, labels, { ready = 1, image = `ghcr.io/example/app@sha256:${'b'.repeat(64)}` } = {}) {
  return {
    metadata: {
      name,
      generation: 1,
      labels: {
        'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
        'app.kubernetes.io/part-of': 'social-vibecoding',
        ...labels,
      },
    },
    spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image }] } } },
    status: {
      observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: ready, availableReplicas: ready,
      ...(ready ? {} : { unavailableReplicas: 1 }),
    },
  };
}

test('lists preview Deployments by name and session label, and nothing else', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const calls = [];
  kubernetes._setClientsForTest({ apps: {
    listNamespacedDeployment: async (args) => {
      calls.push(args);
      return { items: [
        deployment('sv-preview-320-s3711', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/app-id': '320',
          'social.usernode.io/session-id': '3711', 'usernode.env.fp': '95534986733ce179',
        }),
        deployment('sv-preview-10-s5179', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/app-id': '10',
          'social.usernode.io/session-id': '5179',
        }, { ready: 0 }),
        // An evidence replay: same environment label and a session id, but it
        // belongs to the evidence runner.
        deployment('sv-evidence-c0b61036b089bd4b-h', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/session-id': '4716',
          'social.usernode.io/evidence-run': 'c0b61036b089bd4b',
        }),
        // Attempt-specific candidates are reconciled by their persisted owner,
        // including when no session projection points at them yet.
        deployment(`sv-p-${'a'.repeat(32)}`, {
          'app.kubernetes.io/managed-by': 'social-vibecoding-preview-experiment',
          'social.usernode.io/environment': 'staging',
          'social.usernode.io/session-id': '3711',
          'social.usernode.io/preview-flow': 'candidate-flow',
        }),
        // A name that looks right with a label that disagrees is not trusted.
        deployment('sv-preview-1-s2', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/session-id': '3',
        }),
      ] };
    },
  } });

  const previews = await kubernetes.listPreviews(config);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, 'social-apps');
  assert.equal(calls[0].labelSelector,
    'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/environment=staging');
  assert.deepEqual(previews.map((p) => [p.name, p.appId, p.sessionId, p.state]), [
    ['sv-preview-320-s3711', 320, 3711, 'running'],
    ['sv-preview-10-s5179', 10, 5179, 'restarting'],
  ]);
  assert.equal(previews[0].labels['usernode.env.fp'], '95534986733ce179');
  assert.match(previews[0].image, /@sha256:/);
});

test('the name pattern is the one appResourceName builds for a preview', () => {
  const name = kubernetes.appResourceName({ id: 1959, slug: 'whatever-abc123' }, 'staging', 6021);
  assert.equal(name, 'sv-preview-1959-s6021');
});

test('an empty or malformed list is an empty inventory', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  kubernetes._setClientsForTest({ apps: { listNamespacedDeployment: async () => ({}) } });
  assert.deepEqual(await kubernetes.listPreviews(config), []);
});

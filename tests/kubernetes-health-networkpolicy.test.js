const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseAllDocuments } = require('yaml');

const helmAvailable = spawnSync('helm', ['version', '--short']).status === 0;

for (const namespace of ['social-apps', 'custom-apps']) {
  test(`rendered health-probe egress is scoped to managed apps in ${namespace}`, { skip: !helmAvailable }, () => {
    const args = ['template', 'test', 'deploy/helm/social-vibecoding-platform',
      '--set', 'enabled=true', '--set', `networkPolicy.appNamespace=${namespace}`,
      '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
    for (const field of ['image', 'workerImage', 'captureImage']) {
      args.push('--set-string', `platform.${field}.digest=sha256:${'b'.repeat(64)}`);
    }
    const result = spawnSync('helm', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const objects = parseAllDocuments(result.stdout).map((doc) => doc.toJSON());
    const policies = objects.filter((o) => o?.kind === 'NetworkPolicy');
    const platform = policies.find((o) => o.spec.podSelector.matchLabels['app.kubernetes.io/component'] === 'platform');
    const rule = platform.spec.egress.find((rule) => rule.to?.some((peer) =>
      peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'] === namespace));
    assert.deepEqual(rule, {
      to: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
        podSelector: { matchLabels: {
          'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
          'app.kubernetes.io/part-of': 'social-vibecoding',
        } },
      }],
      ports: [{ protocol: 'TCP', port: 3000 }],
    });
    // Workers, migrations and unrelated Pods must not inherit this access.
    const migration = policies.find((o) => o.spec.podSelector.matchLabels['app.kubernetes.io/component'] === 'migration');
    assert(!migration.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 3000)));
  });
}

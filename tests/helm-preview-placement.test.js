const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

test('Helm scopes preview placement to the configured external CNPG writer', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const args = ['template', 'preview-placement-test', 'deploy/helm/social-vibecoding-platform',
    '--namespace', 'platform-ns', '--show-only', 'templates/platform.yaml',
    '--set', 'enabled=true,secrets.create=false',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const external = ['--set', 'postgresql.enabled=false,postgresql.host=writer.example.test'];
  const cnpg = ['--set-string', 'postgresql.podSelector.cnpg\\.io/cluster=writer-cluster'];
  for (const [name, overrides, namespace, cluster] of [
    ['bundled database', [], '', ''],
    ['bundled database ignores external selector', cnpg, '', ''],
    ['external CNPG across namespaces', [...external, ...cnpg, '--set', 'postgresql.namespace=database-ns'], 'database-ns', 'writer-cluster'],
    ['external CNPG in release namespace', [...external, ...cnpg], 'platform-ns', 'writer-cluster'],
    ['disabled preference', [...external, ...cnpg, '--set', 'config.previewFollowDatabasePrimary=false'], '', ''],
    ['external non-CNPG database', [...external, '--set', 'postgresql.podSelector.app=postgres'], '', ''],
    ['external database without Pod selector', [...external, '--set', 'networkPolicy.enabled=false'], '', ''],
  ]) {
    const rendered = execFileSync('helm', [...args, ...overrides], { encoding: 'utf8' });
    const env = Object.fromEntries([...rendered.matchAll(/\{name: ([A-Z_]+), value: "([^"]*)"\}/g)]
      .map(([, key, value]) => [key, value]));
    assert.equal(env.PREVIEW_DATABASE_NAMESPACE, namespace, name);
    assert.equal(env.PREVIEW_DATABASE_CLUSTER, cluster, name);
  }
});

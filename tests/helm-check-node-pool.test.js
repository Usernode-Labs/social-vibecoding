const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

// config.checkNodePool reaches the platform as CHECK_NODE_POOL
// (src/config.js, services/kubernetes.js checkPlacement).
test('Helm passes the check node pool to the runtime, empty by default', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const args = ['template', 'check-node-pool-test', 'deploy/helm/social-vibecoding-platform',
    '--show-only', 'templates/platform.yaml', '--set', 'enabled=true',
    '--set', 'secrets.create=false', '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  for (const [overrides, expected] of [
    [[], ''],
    [['--set-string', 'config.checkNodePool=usernodelabs.org/node-pool=cpu-heavy'], 'usernodelabs.org/node-pool=cpu-heavy'],
  ]) {
    const rendered = execFileSync('helm', [...args, ...overrides], { encoding: 'utf8' });
    const env = Object.fromEntries([...rendered.matchAll(/\{name: ([A-Z0-9_]+), value: "([^"]*)"\}/g)]
      .map(([, key, value]) => [key, value]));
    assert.equal(env.CHECK_NODE_POOL, expected);
  }
});

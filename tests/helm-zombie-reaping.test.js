const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

// Node as PID 1 never reaps the `git` processes it orphans, and zombies count
// against the kubelet's per-Pod PID limit. With a shared process namespace
// the pause container is PID 1 and reaps them, for the platform and the
// conductor alike (templates/platform.yaml's platformPod).
test('platform and conductor Pods share a process namespace, so pause reaps zombies', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const args = ['template', 'zombie-reaping-test', 'deploy/helm/social-vibecoding-platform',
    '--show-only', 'templates/platform.yaml', '--set', 'enabled=true',
    '--set', 'secrets.create=false', '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  for (const [conductor, expected] of [['true', 2], ['false', 1]]) {
    const rendered = execFileSync('helm', [...args, '--set', `platform.conductor.enabled=${conductor}`],
      { encoding: 'utf8' });
    const deployments = rendered.split(/^---$/m).filter((doc) => /^kind: Deployment$/m.test(doc));
    assert.equal(deployments.length, expected);
    for (const doc of deployments) {
      // Six spaces: a field of the Pod template's spec.
      assert.match(doc, /^ {6}shareProcessNamespace: true$/m);
    }
  }
});

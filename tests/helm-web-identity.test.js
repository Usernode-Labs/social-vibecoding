const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

// The web Pods' own identity (platform.web, docs/plans/web-and-conductor.md):
// with the conductor on they change nothing in the cluster, so they may run
// as an account the cluster grants only reads, and they never hold the
// OpenRouter management key, which only the conductor uses.

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;
const skip = !helmAvailable && 'helm is not installed';

function render(overrides = [], { create = true } = {}) {
  const args = ['template', 'web-identity-test', 'deploy/helm/social-vibecoding-platform',
    '--set', `enabled=true,secrets.create=${create}`,
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`,
    '--set-string', 'secrets.databasePassword=test-only-password',
    '--set-string', 'secrets.githubAppId=123,secrets.githubPrivateKey=test-key,secrets.topochainPartnerApiKey=test-partner'];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const res = spawnSync('helm', [...args, ...overrides], { encoding: 'utf8' });
  return res.status === 0 ? { docs: res.stdout.split(/^---$/m) } : { error: res.stderr };
}
const KEY = ['--set-string', 'secrets.openrouterManagementApiKey=test-management-key'];
const doc = (docs, kind, name) => docs.find((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d)
  && new RegExp(`^  name: ${name}$`, 'm').test(d));
const role = (deployment) => deployment.match(/- \{name: PROCESS_ROLE, value: "(\w+)"\}/)?.[1];

test('the web Pods run as their own account when one is named; the conductor keeps social-platform-runtime', { skip }, () => {
  const plain = render();
  for (const name of ['social-vibecoding', 'social-vibecoding-conductor']) {
    assert.match(doc(plain.docs, 'Deployment', name), /serviceAccountName: social-platform-runtime/, `${name} by default`);
  }
  const { docs } = render(['--set-string', 'platform.web.serviceAccountName=social-platform-web']);
  const web = doc(docs, 'Deployment', 'social-vibecoding');
  const conductor = doc(docs, 'Deployment', 'social-vibecoding-conductor');
  assert.equal(role(web), 'web');
  assert.match(web, /serviceAccountName: social-platform-web/);
  assert.equal(role(conductor), 'conductor');
  assert.match(conductor, /serviceAccountName: social-platform-runtime/);
  // Both read their own Deployment and Pod (platform-release.js).
  const binding = doc(docs, 'RoleBinding', 'social-vibecoding-rollout-reader');
  assert.match(binding, /- kind: ServiceAccount\n\s+name: social-platform-runtime\n/);
  assert.match(binding, /- kind: ServiceAccount\n\s+name: social-platform-web\n/);
});

test('an account for web Pods needs the conductor: without it the platform Pods do its work', { skip }, () => {
  const { error } = render(['--set', 'platform.conductor.enabled=false', '--set-string', 'platform.web.serviceAccountName=social-platform-web']);
  assert.match(error, /platform\.web\.serviceAccountName needs platform\.conductor\.enabled/);
});

test('the OpenRouter management key is in a Secret only the conductor imports', { skip }, () => {
  const { docs } = render(KEY);
  const shared = doc(docs, 'Secret', 'social-vibecoding');
  const own = doc(docs, 'Secret', 'social-vibecoding-conductor');
  // Said empty, never left out: a dropped stringData key stays in a live Secret.
  assert.match(shared, /OPENROUTER_MANAGEMENT_API_KEY: ""/, 'empty in the Secret every platform Pod imports');
  assert.doesNotMatch(shared, /test-management-key/);
  assert.match(own, /OPENROUTER_MANAGEMENT_API_KEY: "test-management-key"/);
  assert.match(own, /argocd\.argoproj\.io\/sync-wave: "-3"/, 'made before the Pods that import it');
  const web = doc(docs, 'Deployment', 'social-vibecoding');
  const conductor = doc(docs, 'Deployment', 'social-vibecoding-conductor');
  assert.doesNotMatch(web, /name: social-vibecoding-conductor\n/, 'web never imports it');
  assert.doesNotMatch(web, /test-management-key/);
  // The conductor's own Secret is imported after the shared one: the later wins.
  assert.match(conductor, /- secretRef:\n\s+name: social-vibecoding\n[\s\S]*- secretRef:\n\s+name: social-vibecoding-conductor\n/);
  for (const [name, deployment] of [['web', web], ['conductor', conductor]]) {
    assert.match(deployment, /- \{name: OPENROUTER_MANAGED_KEYS_ENABLED, value: "true"\}/, `${name}: offered, said without the key`);
  }
  const off = render();
  assert.match(doc(off.docs, 'Deployment', 'social-vibecoding'), /- \{name: OPENROUTER_MANAGED_KEYS_ENABLED, value: "false"\}/,
    'no key: not offered');
  const checksum = (d) => d.match(/checksum\/secrets: ([a-f0-9]{64})/)?.[1];
  assert.notEqual(checksum(doc(off.docs, 'Deployment', 'social-vibecoding-conductor')), checksum(conductor),
    'a new key rolls out the conductor');
});

test('with the conductor off, or a Secret the chart does not make, the key stays where it was', { skip }, () => {
  const { docs } = render([...KEY, '--set', 'platform.conductor.enabled=false']);
  assert.match(doc(docs, 'Secret', 'social-vibecoding'), /OPENROUTER_MANAGEMENT_API_KEY: "test-management-key"/);
  assert.equal(doc(docs, 'Secret', 'social-vibecoding-conductor'), undefined);
  const existing = render(['--set-string', 'secrets.existingSecret=platform-secrets'], { create: false });
  assert.equal(existing.docs.filter((d) => /^kind: Secret$/m.test(d)).length, 0, 'no Secret is made');
  for (const name of ['social-vibecoding', 'social-vibecoding-conductor']) {
    const deployment = doc(existing.docs, 'Deployment', name);
    assert.doesNotMatch(deployment, /OPENROUTER_MANAGED_KEYS_ENABLED/, `${name}: the imported Secret's key decides`);
    assert.doesNotMatch(deployment, /name: social-vibecoding-conductor\n\s*$/m);
    if (name === 'social-vibecoding') {
      for (const key of ['GITHUB_PRIVATE_KEY', 'GIT_HOST_TOKEN']) assert.match(deployment, new RegExp('name: ' + key + ', value: ""'));
    }
  }
});


test('writer credentials belong to the conductor while the shared Secret carries read access', { skip }, () => {
  const options = ['--set-string', 'config.gitHost.url=https://git.example.test,config.gitHost.user=writer,config.gitHost.readUser=reader',
    '--set-string', 'secrets.gitHostToken=test-writer-token,secrets.gitHostReadToken=test-reader-token'];
  const { docs } = render(options);
  const shared = doc(docs, 'Secret', 'social-vibecoding');
  const own = doc(docs, 'Secret', 'social-vibecoding-conductor');
  for (const key of ['GITHUB_PRIVATE_KEY', 'GIT_HOST_TOKEN']) assert.match(shared, new RegExp(key + ': ""'));
  assert.doesNotMatch(shared, /test-key|test-writer-token/);
  assert.match(shared, /GIT_HOST_READ_TOKEN: "test-reader-token"/);
  assert.match(own, /GITHUB_PRIVATE_KEY: "test-key"/);
  assert.match(own, /GIT_HOST_TOKEN: "test-writer-token"/);
  const web = doc(docs, 'Deployment', 'social-vibecoding');
  assert.doesNotMatch(web, /name: social-vibecoding-conductor\n/);
  assert.match(web, /GIT_HOST_READ_USER, value: "reader"/);
  const unsplit = render([...options, '--set', 'platform.conductor.enabled=false']);
  assert.match(doc(unsplit.docs, 'Secret', 'social-vibecoding'), /GITHUB_PRIVATE_KEY: "test-key"/);
  assert.match(doc(unsplit.docs, 'Secret', 'social-vibecoding'), /GIT_HOST_TOKEN: "test-writer-token"/);
  const missing = render(['--set-string', 'config.gitHost.url=https://git.example.test']);
  assert.match(missing.error, /gitHostReadToken is required/);
});

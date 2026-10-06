const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

test('Helm supplies optional mail tracking without changing Gmail and rolls out secret changes', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const args = ['template', 'mail-tracking-test', 'deploy/helm/social-vibecoding-platform',
    '--set', 'enabled=true,secrets.create=true',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`,
    '--set-string', 'secrets.databasePassword=test-only-password',
    '--set-string', 'secrets.githubAppId=123,secrets.githubPrivateKey=test-key,secrets.githubBotToken=test-token,secrets.topochainPartnerApiKey=test-partner'];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const render = overrides => execFileSync('helm', [...args, ...overrides], { encoding: 'utf8' });
  const disabled = render([]);
  const enabled = render(['--set-string', 'secrets.platformMailTrackingSecret=test-tracking-secret']);
  const rotated = render(['--set-string', 'secrets.platformMailTrackingSecret=rotated-test-secret']);

  assert.match(disabled, /PLATFORM_MAIL_TRACKING_SECRET: ""/);
  assert.match(enabled, /PLATFORM_MAIL_TRACKING_SECRET: "test-tracking-secret"/);
  assert.match(enabled, /GMAIL_OAUTH_CLIENT_ID: ""/);
  assert.doesNotMatch(enabled, /PLATFORM_MAIL_PROVIDER:/, 'tracking does not switch the sender');
  const name = enabled.match(/kind: Secret\nmetadata:\n  name: (\S+)/)?.[1];
  assert.ok(name, 'chart creates the Secret');
  assert.ok(enabled.includes(`- secretRef:\n                name: ${name}`), 'platform imports that Secret');
  const checksum = manifest => manifest.match(/checksum\/secrets: ([a-f0-9]{64})/)?.[1];
  assert.ok(checksum(enabled));
  assert.notEqual(checksum(disabled), checksum(enabled), 'enabling tracking rolls out the platform');
  assert.notEqual(checksum(enabled), checksum(rotated), 'rotating the secret rolls out the platform');

  const external = render(['--set', 'secrets.create=false', '--set-string', 'secrets.existingSecret=external-platform']);
  assert.doesNotMatch(external, /^kind: Secret$/m);
  assert.ok(external.includes('- secretRef:\n                name: external-platform'));
});

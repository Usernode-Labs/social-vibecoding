const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

// The media store's bucket (MEDIA_STORAGE_*): off by default, and on only with
// an endpoint, a bucket and both keys. App file uploads (MINIO_*) are a
// separate store the chart never configures, so turning media on leaves them off.

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

function renderer() {
  const args = ['template', 'object-storage-test', 'deploy/helm/social-vibecoding-platform',
    '--set', 'enabled=true,secrets.create=true',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`,
    '--set-string', 'secrets.databasePassword=test-only-password',
    '--set-string', 'secrets.githubAppId=123,secrets.githubPrivateKey=test-key,secrets.githubBotToken=test-token,secrets.topochainPartnerApiKey=test-partner'];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const run = (overrides) => spawnSync('helm', [...args, ...overrides], { encoding: 'utf8' });
  return {
    render: (overrides) => execFileSync('helm', [...args, ...overrides], { encoding: 'utf8' }),
    refusal: (overrides) => {
      const res = run(overrides);
      assert.notEqual(res.status, 0, 'helm refuses this configuration');
      return res.stderr;
    },
  };
}

const ON = ['--set-string', 'config.mediaStorage.endpoint=https://hel1.your-objectstorage.com',
  '--set-string', 'config.mediaStorage.bucket=example-media',
  '--set-string', 'secrets.mediaStorageAccessKey=test-access,secrets.mediaStorageSecretKey=test-secret'];

test('media storage is off unless configured, and its keys ride the platform Secret', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const { render } = renderer();
  const off = render([]);
  assert.match(off, /- \{name: MEDIA_STORAGE_ENDPOINT, value: ""\}/, 'no endpoint: the media store is off');
  assert.match(off, /MEDIA_STORAGE_ACCESS_KEY: ""/);

  const on = render(ON);
  assert.match(on, /- \{name: MEDIA_STORAGE_ENDPOINT, value: "https:\/\/hel1\.your-objectstorage\.com"\}/);
  assert.match(on, /- \{name: MEDIA_STORAGE_BUCKET, value: "example-media"\}/);
  assert.match(on, /MEDIA_STORAGE_ACCESS_KEY: "test-access"/);
  assert.match(on, /MEDIA_STORAGE_SECRET_KEY: "test-secret"/);
  assert.doesNotMatch(on, /value: "test-(access|secret)"/, 'the keys are never plain env values');
  assert.doesNotMatch(on, /MINIO_|name: STORAGE_BUCKET/, 'app file uploads stay unconfigured');
  const checksum = (manifest) => manifest.match(/checksum\/secrets: ([a-f0-9]{64})/)?.[1];
  assert.notEqual(checksum(off), checksum(on), 'turning media storage on rolls out the platform');
});

test('media storage refuses a half configuration', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const { refusal, render } = renderer();
  assert.match(refusal(['--set-string', 'config.mediaStorage.endpoint=https://hel1.your-objectstorage.com',
    '--set-string', 'secrets.mediaStorageAccessKey=a,secrets.mediaStorageSecretKey=b']), /bucket is required/);
  assert.match(refusal(['--set-string', 'config.mediaStorage.endpoint=https://hel1.your-objectstorage.com',
    '--set-string', 'config.mediaStorage.bucket=example-media']), /mediaStorageAccessKey and secrets\.mediaStorageSecretKey are required/);
  assert.match(refusal([...ON, '--set-string', 'config.mediaStorage.endpoint=hel1.your-objectstorage.com']), /must be a scheme and host/);
  // With an external Secret the keys are that Secret's to carry.
  const external = render(['--set', 'secrets.create=false', '--set-string', 'secrets.existingSecret=external-platform',
    '--set-string', 'config.mediaStorage.endpoint=https://hel1.your-objectstorage.com',
    '--set-string', 'config.mediaStorage.bucket=example-media']);
  assert.match(external, /- \{name: MEDIA_STORAGE_BUCKET, value: "example-media"\}/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

// The chart's two object stores: the media store (MEDIA_STORAGE_*) and app file
// uploads (MINIO_ENDPOINT, STORAGE_BUCKET, MINIO_ROOT_*). Each is off by default,
// on only with an endpoint, a bucket and both keys, and independent of the other.

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

function renderer() {
  const args = ['template', 'object-storage-test', 'deploy/helm/social-vibecoding-platform',
    '--set', 'enabled=true,secrets.create=true',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`,
    '--set-string', 'secrets.databasePassword=test-only-password',
    '--set-string', 'secrets.githubAppId=123,secrets.githubPrivateKey=test-key,secrets.topochainPartnerApiKey=test-partner'];
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

const STORES = [
  { key: 'mediaStorage', endpoint: 'MEDIA_STORAGE_ENDPOINT', bucket: 'MEDIA_STORAGE_BUCKET',
    access: 'MEDIA_STORAGE_ACCESS_KEY', secret: 'MEDIA_STORAGE_SECRET_KEY', others: /MEDIA_STORAGE_\w+: "test-|value: "example-media"/ },
  { key: 'appFileStorage', endpoint: 'MINIO_ENDPOINT', bucket: 'STORAGE_BUCKET',
    access: 'MINIO_ROOT_USER', secret: 'MINIO_ROOT_PASSWORD', others: /MINIO_\w+: "test-|value: "example-app-files"/ },
];
const bucketOf = (store) => (store.key === 'mediaStorage' ? 'example-media' : 'example-app-files');
const on = (store) => ['--set-string', `config.${store.key}.endpoint=https://hel1.your-objectstorage.com`,
  '--set-string', `config.${store.key}.bucket=${bucketOf(store)}`,
  '--set-string', `secrets.${store.key}AccessKey=test-access,secrets.${store.key}SecretKey=test-secret`];

for (const store of STORES) {
  const other = STORES.find((s) => s !== store);

  test(`${store.key} is off unless configured, and its keys ride the platform Secret`, {
    skip: !helmAvailable && 'helm is not installed',
  }, () => {
    const { render } = renderer();
    const off = render([]);
    assert.match(off, new RegExp(`- \\{name: ${store.endpoint}, value: ""\\}`), 'no endpoint: the store is off');
    assert.match(off, new RegExp(`${store.access}: ""`));

    const enabled = render(on(store));
    assert.match(enabled, new RegExp(`- \\{name: ${store.endpoint}, value: "https://hel1\\.your-objectstorage\\.com"\\}`));
    assert.match(enabled, new RegExp(`- \\{name: ${store.bucket}, value: "${bucketOf(store)}"\\}`));
    assert.match(enabled, new RegExp(`${store.access}: "test-access"`));
    assert.match(enabled, new RegExp(`${store.secret}: "test-secret"`));
    assert.doesNotMatch(enabled, /value: "test-(access|secret)"/, 'the keys are never plain env values');
    assert.doesNotMatch(enabled, other.others, `${other.key} stays unconfigured`);
    assert.match(enabled, new RegExp(`- \\{name: ${other.endpoint}, value: ""\\}`));
    const checksum = (manifest) => manifest.match(/checksum\/secrets: ([a-f0-9]{64})/)?.[1];
    assert.notEqual(checksum(off), checksum(enabled), 'turning the store on rolls out the platform');
  });

  test(`${store.key} refuses a half configuration`, {
    skip: !helmAvailable && 'helm is not installed',
  }, () => {
    const { refusal, render } = renderer();
    const endpoint = ['--set-string', `config.${store.key}.endpoint=https://hel1.your-objectstorage.com`];
    assert.match(refusal([...endpoint,
      '--set-string', `secrets.${store.key}AccessKey=a,secrets.${store.key}SecretKey=b`]), /bucket is required/);
    assert.match(refusal([...endpoint, '--set-string', `config.${store.key}.bucket=${bucketOf(store)}`]),
      new RegExp(`${store.key}AccessKey and secrets\\.${store.key}SecretKey are required`));
    assert.match(refusal([...on(store), '--set-string', `config.${store.key}.endpoint=hel1.your-objectstorage.com`]),
      new RegExp(`config\\.${store.key}\\.endpoint must be a scheme and host`));
    // With an external Secret the keys are that Secret's to carry.
    const external = render(['--set', 'secrets.create=false', '--set-string', 'secrets.existingSecret=external-platform',
      ...endpoint, '--set-string', `config.${store.key}.bucket=${bucketOf(store)}`]);
    assert.match(external, new RegExp(`- \\{name: ${store.bucket}, value: "${bucketOf(store)}"\\}`));
  });
}

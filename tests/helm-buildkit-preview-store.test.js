'use strict';

// The chart hands BUILDKIT_PREVIEW_STORES to the platform only when an
// operator set it. The platform also reads the foundation's build policy
// ConfigMap through envFrom, and an explicit entry in `env` wins over that,
// so an empty default here must set nothing at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

function render(...overrides) {
  const args = ['template', 'preview-store-test', 'deploy/helm/social-vibecoding-platform',
    '--namespace', 'platform-ns', '--show-only', 'templates/platform.yaml',
    '--set', 'enabled=true,secrets.create=false',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    args.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const rendered = execFileSync('helm', [...args, ...overrides], { cwd: ROOT, encoding: 'utf8' });
  return Object.fromEntries([...rendered.matchAll(/\{name: ([A-Z_0-9]+), value: "([^"]*)"\}/g)].map(([, key, value]) => [key, value]));
}

test('Helm sets the preview store variables only when an operator set them', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const unset = render();
  assert.equal('BUILDKIT_PREVIEW_STORES' in unset, false, 'nothing to override a value in the build policy ConfigMap');
  assert.equal('BUILDKIT_PREVIEW_STORE_EPOCH' in unset, false);
  assert.equal(unset.APP_HOST_SIGNIN, 'on', 'the neighbouring entries still render');

  const one = render('--set-string', 'config.buildkitPreviewStores=usernode-2d5619=bk-store-homeroom');
  assert.equal(one.BUILDKIT_PREVIEW_STORES, 'usernode-2d5619=bk-store-homeroom');
  assert.equal('BUILDKIT_PREVIEW_STORE_EPOCH' in one, false);

  const two = render(
    '--set-string', 'config.buildkitPreviewStores=usernode-2d5619=bk-store-homeroom\\,other-app=bk-store-other',
    '--set-string', 'config.buildkitPreviewStoreEpoch=2',
  );
  assert.equal(two.BUILDKIT_PREVIEW_STORES, 'usernode-2d5619=bk-store-homeroom,other-app=bk-store-other');
  assert.equal(two.BUILDKIT_PREVIEW_STORE_EPOCH, '2');
});

test('the setting is declared where an operator looks for it', () => {
  const values = fs.readFileSync(path.join(ROOT, 'deploy/helm/social-vibecoding-platform/values.yaml'), 'utf8');
  assert.match(values, /^ {2}buildkitPreviewStores: ""$/m);
  assert.match(values, /^ {2}buildkitPreviewStoreEpoch: ""$/m);
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(example, /^# BUILDKIT_PREVIEW_STORES=/m);
  assert.match(example, /^# BUILDKIT_PREVIEW_STORE_EPOCH=1$/m);
  const config = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
  assert.match(config, /buildkitPreviewStores: process\.env\.BUILDKIT_PREVIEW_STORES \|\| ''/);
  assert.match(config, /buildkitPreviewStoreEpoch: process\.env\.BUILDKIT_PREVIEW_STORE_EPOCH \|\| '1'/);
  const docs = fs.readFileSync(path.join(ROOT, 'docs/kubernetes-operations.md'), 'utf8');
  assert.match(docs, /^## Kept store for preview image builds$/m);
  for (const part of ['### What to create', '### Turning it on and off', '### Wiping a store', '### What a kept store shares', 'ReadWriteOnce', 'fsGroupChangePolicy: OnRootMismatch']) {
    assert.ok(docs.includes(part), part);
  }
});

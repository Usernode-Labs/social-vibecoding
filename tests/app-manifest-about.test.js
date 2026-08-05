// #419: optional developer-authored, plain-text app introduction metadata.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-about-'));
  try {
    if (content != null) {
      fs.writeFileSync(path.join(dir, 'dapp.json'),
        typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(appManifest.read(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizes valid authored introduction copy', () => {
  withManifest({ about: {
    summary: '  A concise summary.  ',
    description: '  More context.  ',
    features: [' First ', 'Second'],
  } }, (manifest) => assert.deepEqual(manifest.about, {
    summary: 'A concise summary.',
    description: 'More context.',
    features: ['First', 'Second'],
  }));
});

test('summary is required and bounded', () => {
  for (const about of [null, [], {}, { summary: '' }, { summary: 42 },
    { summary: 'x'.repeat(appManifest.MAX_ABOUT_SUMMARY_LENGTH + 1) }]) {
    withManifest({ about }, (manifest) => assert.equal(manifest.about, null));
  }
});

test('invalid optional description is omitted without dropping valid summary', () => {
  for (const description of [42, '', 'x'.repeat(appManifest.MAX_ABOUT_DESCRIPTION_LENGTH + 1)]) {
    withManifest({ about: { summary: 'Valid', description } }, (manifest) => {
      assert.deepEqual(manifest.about, { summary: 'Valid', description: null, features: [] });
    });
  }
});

test('features are trimmed, deduplicated, bounded, and capped', () => {
  const values = [' One ', 'One', '', 42, 'x'.repeat(appManifest.MAX_ABOUT_FEATURE_LENGTH + 1),
    'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
  withManifest({ about: { summary: 'Valid', features: values } }, (manifest) => {
    assert.deepEqual(manifest.about.features, ['One', 'Two', 'Three', 'Four', 'Five', 'Six']);
  });
});

test('missing and unparseable manifests preserve about:null compatibility', () => {
  withManifest(null, (manifest) => assert.equal(manifest.about, null));
  withManifest('{nope', (manifest) => assert.equal(manifest.about, null));
});

test('the starter advertises the editable about contract', () => {
  const { getTemplateFiles } = require('../src/services/template');
  const file = getTemplateFiles('Example App', 'example-app', 'postgres://x')
    .find((entry) => entry.path === 'dapp.json');
  const parsed = JSON.parse(file.content);
  assert.deepEqual(parsed.about, {
    summary: 'Example App is ready to explore.',
    description: 'Use the app inside Usernode, and edit this introduction as the product takes shape.',
    features: [],
  });
  assert.deepEqual(parsed.secrets, []);
});

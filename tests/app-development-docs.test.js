'use strict';

// The developer guide is deliberately an orientation document, while
// app-conventions.md remains the detailed runtime contract. Keep the few
// safety-critical claims that answer issue #592 from quietly disappearing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function markdownHeadingIds(markdown) {
  return new Set(markdown.split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\- _]/gu, '')
      .replace(/ /g, '-')));
}

test('README links the app-development guide', () => {
  assert.match(read('README.md'), /docs\/app-development\.md/);
});

test('app-development guide preserves configuration and ledger boundaries', () => {
  const guide = read('docs/app-development.md');
  assert.match(guide, /\.env\.example.*self-hosted\/local deployment/i);
  assert.match(guide, /not\*\* copied into child apps/i);
  assert.match(guide, /App \*\*Secrets\*\* UI/);
  assert.match(guide, /private: true/);
  assert.match(guide, /staging_default/);
  assert.match(guide, /NODE_RPC_URL/);
  assert.match(guide, /make node-full/);
  assert.match(guide, /partial-ledger node/i);
  assert.match(guide, /authoritative chain history/i);
  assert.match(guide, /not the silent default/i);
  assert.match(guide, /COMMENT ON TABLE direct_messages IS 'staging:private'/);
  assert.match(guide, /usernode\.uploadFile\(\)/);
  assert.match(guide, /linked public address, not signing authority/i);
  assert.match(guide, /sendTransaction\(\)/);
  assert.match(guide, /\/api\/v4.*separate product API/is);
  assert.match(guide, /JWT_SECRET.*legacy verification alias/is);
});

test('app-development local links and heading fragments resolve', () => {
  const guidePath = path.join(root, 'docs', 'app-development.md');
  const guide = fs.readFileSync(guidePath, 'utf8');
  const links = [...guide.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 10, 'guide should route details to maintained contracts');

  for (const link of links) {
    const [relative, fragment] = link.split('#');
    const target = path.resolve(path.dirname(guidePath), relative);
    assert.ok(fs.existsSync(target), `missing local documentation target: ${link}`);
    if (fragment && fs.statSync(target).isFile()) {
      assert.ok(markdownHeadingIds(fs.readFileSync(target, 'utf8')).has(fragment),
        `missing heading fragment: ${link}`);
    }
  }
});

test('documented runtime boundaries remain executable contracts', () => {
  const manifest = read('src/services/app-manifest.js');
  const secrets = read('src/services/app-secrets.js');
  const identity = read('src/services/app-identity-env.js');
  const bridge = read('public/usernode-bridge/v1/bridge.js');

  for (const key of ['DATABASE_URL', 'USERNODE_JWT_PUBLIC_KEY', 'USERNODE_APP_ID',
    'JWT_SECRET', 'IFRAME_JWT_PUBLIC_KEY', 'USERNODE_ENV']) {
    assert.match(manifest, new RegExp(`['\"]${key}['\"]`));
  }
  assert.match(secrets, /if \(e\.NODE_RPC_URL\) out\.NODE_RPC_URL = e\.NODE_RPC_URL/);
  assert.match(identity, /USERNODE_JWT_PUBLIC_KEY: publicPem/);
  assert.match(identity, /USERNODE_APP_ID: String\(appId\)/);
  assert.match(bridge, /window\.getNodeAddress = function getNodeAddress/);
  assert.match(bridge, /window\.sendTransaction = function sendTransaction/);
  assert.match(bridge, /window\.signMessage = function signMessage/);
  assert.match(bridge, /window\.usernode\.uploadFile = function uploadFile/);
});

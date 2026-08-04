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
});

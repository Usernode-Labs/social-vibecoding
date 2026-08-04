// #864 — permission guidance in the PR-import modal must distinguish the
// contributor's fork workflow from direct pushes and app registration.
//
// Run with: node --test tests/pr-import-guidance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('PR import modal explains the fork, direct-push, and bot-registration permission boundaries', () => {
  const modalStart = INDEX.indexOf('id="import-pr-modal"');
  assert.ok(modalStart >= 0, 'import PR modal exists');
  const modal = INDEX.slice(modalStart, INDEX.indexOf('<!-- Members & visibility modal', modalStart));

  assert.match(modal, /GitHub PR from your own fork/i,
    'contributors are told they can use a fork');
  assert.match(modal, /do not need Write access/i,
    'fork contributions do not require repository write access');
  assert.match(modal, /Write access is needed only to push a branch directly/i,
    'direct pushes are the write-requiring path');
  assert.match(modal, /separate requirement when registering an existing repository/i,
    'bot access for app registration is not confused with contributor access');
});

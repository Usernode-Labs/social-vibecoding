// #864 — permission guidance in the PR-import modal must distinguish the
// contributor's fork workflow from direct pushes and app registration.
//
// Run with: node --test tests/pr-import-guidance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('PR import modal explains the fork, collaborator, direct-push, and bot permission boundaries', () => {
  const modalStart = INDEX.indexOf('id="import-pr-modal"');
  assert.ok(modalStart >= 0, 'import PR modal exists');
  const modal = INDEX.slice(modalStart, INDEX.indexOf('<!-- Members & visibility modal', modalStart));

  assert.match(modal, /role="note"[^>]+aria-label=/i,
    'permission guidance is identified as an accessible note');
  assert.match(modal, /Fork the public repository/i,
    'contributors are told the supported public-fork workflow');
  assert.match(modal, /a Usernode collaborator can then import/i,
    'GitHub authorship is distinguished from Usernode import authority');
  assert.match(modal, /Keep the PR and its fork available until voting and merging finish/i,
    'the external head must remain available through the proposal lifecycle');
  assert.match(modal, /Write, Maintain, or Admin access is needed only to push a branch directly/i,
    'direct pushes are the write-requiring path');
  assert.match(modal, /when registering an existing public repository as a Usernode app/i,
    'bot access for app registration is not confused with contributor access');
  assert.match(modal, /usernode-bot[^<]*<\/code> account needs write-capable access/i,
    'the platform account requirement is explicit');
  assert.match(modal, /Platform access never grants contributors repository access/i,
    'platform authority is not presented as contributor authority');
});

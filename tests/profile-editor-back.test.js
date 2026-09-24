'use strict';

// QA 2026-09-24 Q16: Back with the profile editor open.
//
// Back walked past the open editor to the history entry under Profile, so it
// closed the card AND left the screen, and a half-typed bio went with it. The
// editor claims the press now through lib/back-stack.ts, the mechanism the
// dialogs already use (features/dialogs/use-dialog.ts), so Back closes the
// card and nothing else; and what was typed is kept for the next open.
//
// Run with: node --test tests/profile-editor-back.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PROFILE = read('frontend/src/features/profile/profile.js');
const SHEET = read('frontend/src/features/profile/profile-edit-sheet.tsx');

function renderSheet(draft) {
  const Profile = {
    _user: () => ({ username: 'evan', displayName: 'Evan', bio: 'The saved bio', links: {} }),
    _dismissSheet: () => {}, MAX_DISPLAY_NAME: 40, MAX_BIO: 280,
    takeDraft: () => draft,
  };
  const mod = loadTsx('frontend/src/features/profile/profile-edit-sheet.tsx', {
    stubs: { './profile.js': { Profile } },
  });
  return renderToHtml(createElement(mod.ProfileEditSheet, { avatarUrl: null, initial: 'E' }));
}

test('the editor claims Back when it opens, the way the dialogs do', () => {
  assert.match(PROFILE, /import \{ pushDismissible \} from '\.\.\/\.\.\/lib\/back-stack';/);
  const show = PROFILE.slice(PROFILE.indexOf('  showEditSheet() {'), PROFILE.indexOf('  _dismissSheet({'));
  assert.match(show, /Profile\._releaseBack = pushDismissible\(\(\) => \{\s*Profile\._releaseBack = null;\s*Profile\._dismissSheet\(\{ keepDraft: true \}\);\s*return true;/,
    'Back closes the card, keeping what was typed, and the press is consumed');
});

test('every close hands the claim back, as a navigating release', () => {
  // Several closes are the first half of a link (Email & recovery, Open
  // public page, leaving the screen): the record must not be spent under it.
  const dismiss = PROFILE.slice(PROFILE.indexOf('  _dismissSheet({'), PROFILE.indexOf('  takeDraft() {'));
  assert.match(dismiss, /const release = Profile\._releaseBack;\s*Profile\._releaseBack = null;\s*if \(release\) release\(\{ navigating: true \}\);/);
});

test('only a dismissal keeps the draft; Cancel and Save are decisions', () => {
  const dismiss = PROFILE.slice(PROFILE.indexOf('  _dismissSheet({'), PROFILE.indexOf('  takeDraft() {'));
  assert.match(dismiss, /Profile\._draft = keepDraft && typeof source === 'function' && user\.username/);
  // The kit's backdrop / Escape keeps it, as Back does…
  assert.match(SHEET, /if \(!adoption\) return;\s*adoption = null;\s*Profile\._dismissSheet\(\{ keepDraft: true \}\);/);
  // …Cancel does not.
  assert.match(SHEET, /onClick=\{\(\) => Profile\._dismissSheet\(\)\}\s*>\s*Cancel/);
  // A kept draft belongs to the account that typed it.
  assert.match(PROFILE, /return draft && username && draft\.username === username \? draft : null;/);
});

test('the next open shows the kept draft, and without one the saved profile', () => {
  const kept = renderSheet({ displayName: 'Ev', bio: 'Half-typed bio' });
  assert.match(kept, /id="profile-edit-bio"[^>]*>Half-typed bio<\/textarea>/);
  assert.match(kept, /id="profile-edit-name"[^>]*value="Ev"/);
  const fresh = renderSheet(null);
  assert.match(fresh, /id="profile-edit-bio"[^>]*>The saved bio<\/textarea>/);
  assert.match(fresh, /id="profile-edit-name"[^>]*value="Evan"/);
});

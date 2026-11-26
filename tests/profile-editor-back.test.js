'use strict';

// QA 2026-09-24 Q16: Back with the profile editor open.
//
// Back walked past the open editor to the history entry under Profile, so it
// closed the card AND left the screen, and a half-typed bio went with it. The
// editor's Sheet (lib/sheet.ts) claims the press through lib/back-stack.ts,
// the mechanism the dialogs already use (features/dialogs/use-dialog.ts), so
// Back closes the card and nothing else; and what was typed is kept for the
// next open.
//
// Run with: node --test tests/profile-editor-back.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PROFILE = read('frontend/src/features/profile/profile.js');
const SHEET = read('frontend/src/features/profile/profile-edit-sheet.tsx');
const SHEET_LIB = read('frontend/src/lib/sheet.ts');

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
  // Its Sheet (lib/sheet.ts) takes the record while the card is mounted, and
  // Back runs the Sheet's onClose: the card closes, keeping what was typed.
  assert.match(SHEET, /useSheet\(\{\s*kind: 'modal',\s*onClose: \(\) => Profile\._dismissSheet\(\{ keepDraft: true \}\),/,
    'Back closes the card, keeping what was typed');
  assert.match(SHEET_LIB, /pushDismissible\(\(\) => \{\s*backed = true;\s*close\(\);\s*return true;/,
    'and the press is consumed');
  const show = PROFILE.slice(PROFILE.indexOf('  showEditSheet() {'), PROFILE.indexOf('  _dismissSheet({'));
  assert.doesNotMatch(show, /pushDismissible/, 'the controller does not hold a second record');
});

test('every close hands the claim back, as a navigating release', () => {
  // Several closes are the first half of a link (Email & recovery, Open
  // public page, leaving the screen): the record must not be spent under it.
  assert.match(SHEET_LIB, /return \(\) => \{ if \(!backed\) release\(\{ navigating: true \}\); \};/);
});

test('only a dismissal keeps the draft; Cancel and Save are decisions', () => {
  const dismiss = PROFILE.slice(PROFILE.indexOf('  _dismissSheet({'), PROFILE.indexOf('  takeDraft() {'));
  assert.match(dismiss, /Profile\._draft = keepDraft && typeof source === 'function' && user\.username/);
  // The kit's backdrop / Escape keeps it, as Back does: all three are the
  // Sheet's onClose…
  assert.match(SHEET, /onClose: \(\) => Profile\._dismissSheet\(\{ keepDraft: true \}\),/);
  // …Cancel does not.
  assert.match(SHEET, /onClick=\{\(\) => Profile\._dismissSheet\(\)\}\s*>\s*\{t\('core:common\.cancel'\)\}/);
  assert.equal(message('core:common.cancel'), 'Cancel');
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

test('audit D10: the bio keeps its label in view when focus scrolls the sheet', () => {
  const html = renderSheet(null);
  assert.match(html, /<textarea[^>]*class="[^"]*\bscroll-mt-8\b[^"]*"[^>]*id="profile-edit-bio"|<textarea[^>]*id="profile-edit-bio"[^>]*class="[^"]*\bscroll-mt-8\b/);
});

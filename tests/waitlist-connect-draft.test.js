// The typed answers survive the OAuth round trip (#1533).
//
// Connecting GitHub / X / LinkedIn leaves the stage-2 survey for the provider
// and comes back to `#more/<token>?connect=<outcome>`. Every field on that
// screen is an uncontrolled ref read only at submit (more.tsx's header
// explains why), so nothing about them survived the navigation: somebody three
// minutes into the questions came back to an empty form.
//
// The draft is parked in sessionStorage under the TOKEN. Three properties
// matter more than the parking itself, and each has a way of going wrong:
//
//   1. It is handed back AFTER the load, and only into fields the server left
//      empty. A stored answer survived a save and is authoritative; a parked
//      draft overwriting it would undo an edit made on another device.
//   2. It is read ONCE. A draft that kept returning would resurrect text the
//      reader had deliberately deleted.
//   3. A successful save clears it, because the answers are stored by then and
//      the parked copy is stale by definition.
//
// Run with: node --test tests/waitlist-connect-draft.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/auth/more.tsx'), 'utf8');

test('the draft is keyed by token, in sessionStorage', () => {
  // Per token so two signups in one browser cannot read each other's answers;
  // sessionStorage so nothing outlives the tab.
  assert.match(SRC, /const DRAFT_PREFIX = 'usernode:waitlist-more-draft:'/);
  assert.match(SRC, /return token \? `\$\{DRAFT_PREFIX\}\$\{token\}` : null;/);
  for (const call of ['sessionStorage.setItem', 'sessionStorage.getItem', 'sessionStorage.removeItem']) {
    assert.ok(SRC.includes(call), `${call} is used`);
  }
  assert.doesNotMatch(SRC, /localStorage\.\w+Item/, 'a draft must not outlive the tab');
});

test('every storage access is wrapped', () => {
  // Safari throws on storage in private mode, and a draft is never worth
  // failing the screen over.
  for (const fn of ['saveDraft', 'readDraft', 'clearDraft']) {
    const body = SRC.slice(SRC.indexOf(`function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n}')), /try \{/, `${fn} guards storage`);
  }
});

test('a malformed stored value is ignored rather than thrown on', () => {
  const read = SRC.slice(SRC.indexOf('function readDraft('));
  const body = read.slice(0, read.indexOf('\n}'));
  assert.match(body, /JSON\.parse\(raw\)/);
  assert.match(body, /typeof parsed === 'object'/, 'a non-object is not a draft');
  assert.match(body, /return null;/);
});

test('it is handed back after the load, not before it', () => {
  // The load writes what the server holds; the draft may only fill the gaps.
  assert.match(SRC, /void loadMore\(\)\.then\(restoreDraft\);/);
});

test('a parked value only fills a field the server left empty', () => {
  const restore = SRC.slice(SRC.indexOf('const restoreDraft'));
  const body = restore.slice(0, restore.indexOf('\n  }, []);'));
  assert.match(body, /if \(el && parked && !el\.value\.trim\(\)\) el\.value = parked;/);
  // …and it is read once.
  assert.match(body, /clearDraft\(token\.current\);/);
  // The two long answers are re-measured, or a restored paragraph would sit
  // in a three-line box (#1530).
  assert.match(body, /autoGrow\(groupNeed\.current\)/);
  assert.match(body, /autoGrow\(lossStory\.current\)/);
});

test('the draft is parked on the way out to the provider', () => {
  const anchorAt = SRC.indexOf("'/waitlist/connect/'");
  assert.notEqual(anchorAt, -1);
  const anchor = SRC.slice(SRC.lastIndexOf('<a', anchorAt), SRC.indexOf('</a>', anchorAt));
  assert.match(anchor, /onClick=\{\(\) => saveDraft\(token\.current, snapshotDraft\(\)\)\}/);
});

test('a successful save retires the draft', () => {
  // A window wide enough for both lines that follow the save: #1535's
  // markSurveyAnswered and this one. They are siblings, and either order is
  // correct, so the assertion should not depend on which is first.
  const saved = SRC.slice(SRC.indexOf('setSaved(true);'));
  assert.match(saved.slice(0, 600), /clearDraft\(value\);/);
});

test('the snapshot covers every free-text field, and claims no more', () => {
  const snap = SRC.slice(SRC.indexOf('const snapshotDraft'));
  const body = snap.slice(0, snap.indexOf('}), []);'));
  for (const field of [
    'made_url', 'made_note', 'group_name', 'group_need',
    'loss_product', 'loss_story', 'farcaster', 'discord', 'telegram', 'other_handle',
  ]) {
    assert.ok(body.includes(`${field}:`), `${field} is parked`);
  }
  // Chips and selects are deliberately absent: they are React state, and one
  // tap to re-pick where a paragraph is not.
  assert.ok(!body.includes('group_tools'), 'chip state is not parked');
  assert.ok(!body.includes('had_loss'), 'chip state is not parked');
});

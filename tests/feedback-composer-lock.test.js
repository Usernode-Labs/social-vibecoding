// Sending feedback stops relaying out the whole screen (#1492).
//
// The composer was locked after a successful send by setting `disabled` on the
// description and title. A disabled element cannot hold focus, so on a phone
// that blurs the textarea the instant Submit succeeds — and blurring is what
// tears the on-screen keyboard down.
//
// The keyboard is what the visual viewport is measured against, and app.css
// sets `html, body { height: 100dvh }`, so the whole fixed column reflows: the
// modal resizes under the "Submitted" label, and 1.5s later the dialog closes
// and it reflows again. Two full relayouts around one tap, on a device with
// the least headroom for either. That is the reported stutter, and it is
// mobile-only because only a phone has a keyboard occupying half the viewport.
//
// `readOnly` refuses typing exactly as #32 needs and keeps focus, so the
// keyboard comes down ONCE — when the dialog actually closes.
//
// Run with: node --test tests/feedback-composer-lock.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/dialogs/feedback-controller.js'), 'utf8');

test('the two text fields are never disabled', () => {
  // Disabling is the whole bug: it is what drops focus and the keyboard.
  assert.doesNotMatch(SRC, /feedbackText\.disabled\s*=/);
  assert.doesNotMatch(SRC, /feedbackTitle\.disabled\s*=/);
});

test('the lock is readOnly, applied to both fields through one helper', () => {
  const helper = SRC.slice(SRC.indexOf('const setComposerLocked'));
  const body = helper.slice(0, helper.indexOf('};'));
  assert.match(body, /feedbackText\.readOnly = locked;/);
  assert.match(body, /feedbackTitle\.readOnly = locked;/);
  // One helper, so a future send path cannot lock one field and forget the
  // other — which would be a form that half-accepts typing.
  const setters = SRC.match(/setComposerLocked\(/g) || [];
  assert.ok(setters.length >= 4,
    `expected the definition plus every lock/unlock site, saw ${setters.length}`);
});

test('both send paths lock, and both entry points unlock', () => {
  // Filed and queued-for-later both end the composer …
  const submitted = SRC.slice(SRC.indexOf("feedbackBtn.textContent = 'Submitted'") - 400);
  assert.match(submitted.slice(0, 400), /setComposerLocked\(true\)/);
  const saved = SRC.slice(SRC.indexOf("feedbackBtn.textContent = 'Saved'") - 400);
  assert.match(saved.slice(0, 400), /setComposerLocked\(true\)/);
  // … and reopening or resetting must hand back an editable one, or the next
  // piece of feedback cannot be typed at all.
  const open = SRC.slice(SRC.indexOf('Feedback._open ='));
  assert.match(open.slice(0, 300), /setComposerLocked\(false\)/);
  const reset = SRC.slice(SRC.indexOf('Feedback._reset ='));
  assert.match(reset.slice(0, 1200), /setComposerLocked\(false\)/);
});

test('the guards that ask "is the form locked?" read the same flag', () => {
  // Three places treat the lock as "do not touch the text": the caret
  // restorer, the outbox hand-back and the rescued-draft hand-back. If one of
  // them still read `disabled` it would think an unlocked form was locked
  // forever, and silently stop handing drafts back.
  assert.match(SRC, /if \(feedbackText\.readOnly\) return;/);
  assert.match(SRC, /if \(feedbackText\.readOnly \|\| feedbackText\.value\.trim\(\)\) return;/);
  assert.match(SRC, /if \(!feedbackText\.readOnly && !feedbackText\.value\.trim\(\)\) \{/);
});

test('the submit BUTTON is still disabled, which is right for a button', () => {
  // It holds no caret and dismisses no keyboard, and disabled is the honest
  // state for a control that must not fire.
  assert.match(SRC, /feedbackBtn\.disabled = true;/);
  assert.match(SRC, /feedbackBtn\.disabled = false;/);
});

test('nothing reads the property the lock stopped setting', () => {
  // The three ways #1757 half-landed, each a reader or writer left behind
  // when the lock moved from `disabled` to `readOnly`:
  //   * showFirstFeedback still DISABLED both fields, which is the focus-
  //     and-keyboard bug the change existed to remove;
  //   * the queue-flush handler still BRANCHED on `feedbackText.disabled`,
  //     which is now permanently false, so a flush landing on an
  //     already-sent composer never showed the confirmation;
  //   * `_open` unlocked after its early return rather than before.
  // Two of the three were green on their own and red only together.
  assert.doesNotMatch(SRC, /feedbackText\.disabled/, 'no writer AND no reader');
  assert.doesNotMatch(SRC, /feedbackTitle\.disabled/);
  assert.match(SRC, /else if \(feedbackText\.readOnly\) showFirstFeedback/,
    'the flush handler asks what the lock is actually made of');
  const open = SRC.slice(SRC.indexOf('Feedback._open ='));
  const unlock = open.indexOf('setComposerLocked(false)');
  const branch = open.indexOf('opts.firstFeedback && showFirstFeedback');
  assert.ok(unlock >= 0 && unlock < branch,
    'every open hands back an editable composer before the branch that re-locks it');
});

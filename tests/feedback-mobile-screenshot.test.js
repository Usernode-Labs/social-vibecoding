const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const controller = read('frontend/src/features/dialogs/feedback-controller.js');
const dialog = read('frontend/src/features/dialogs/feedback.tsx');

test('feedback offers native capture and a Photos fallback', () => {
  assert.match(dialog, /id="feedback-screenshot-picker-btn"/);
  assert.match(dialog, /Choose from Photos/);
  assert.match(dialog, /id="feedback-screenshot-input"/);
  assert.match(dialog, /accept="image\/png,image\/jpeg"/);
  assert.match(controller, /capabilities\.includes\('captureScreenshot'\)/);
  assert.match(controller, /window\.usernode\.captureScreenshot\(\)/);
  assert.match(controller, /screenshotTools\.prepareFile\(file\)/);
});

test('all image sources converge on the existing attachment path', () => {
  assert.match(controller, /const attachScreenshotBlob = async \(blob\) =>/);
  assert.equal(
    (controller.match(/await attachScreenshotBlob\(blob\)/g) || []).length,
    2,
    'capture and picker should share preview, upload, and offline handling'
  );
  assert.match(controller, /ScreenshotSelect/);
  assert.match(controller, /Saved with your feedback/);
});

test('mobile screenshot controls keep 48px tap targets', () => {
  const screenshotMarkup = dialog.slice(
    dialog.indexOf('id="feedback-screenshot-btn"'),
    dialog.indexOf('id="feedback-state-row"'),
  );
  assert.match(screenshotMarkup, /min-h-\[48px\]/);
  assert.match(screenshotMarkup, /w-12 h-12/);
});

test('a degraded native probe is retried and never hides Photos', () => {
  assert.match(controller, /info\?\.degraded === true/);
  assert.match(controller, /probeNativeCaptureSupport\(sequence, false\)/);
  assert.match(controller, /screenshotPickerBtn\.classList\.toggle\('hidden', attached\)/);
});

// ── #1284: a failed capture must never cost the user their words ─────────

test('one capture round trip serves the button and the reviewable state', () => {
  // Extracted so ?shot=feedback-capture-failed photographs the shipping path
  // — notice copy, dialog restore, draft retention — not a mock of it.
  assert.match(controller, /const runCapture = async \(capture, \{ nativeAttempt \}\) =>/);
  // A native attempt suspends BEFORE the shot (the phone photographs what is
  // on screen); a display-capture attempt suspends only once the grant lands,
  // which is why `hide` is passed in rather than called here.
  assert.match(controller, /blob = await capture\(hideDialog\)/);
  assert.match(controller, /onCaptureStart: hide/);
  assert.match(controller, /App\._simulateFeedbackCaptureFailure = \(\) => runCapture\(/);
});

test('a dismissal that lands mid-capture does not clear the draft', () => {
  // suspendDialog() closes the kit presentation and the kit calls back when
  // its exit animation ends (~300 ms). A capture that fails faster has
  // already resumed, so that callback is stale — and it used to reach
  // _reset(), wiping the description the screenshot was being attached to.
  assert.match(controller, /let captureInFlight = false/);
  assert.match(controller, /captureInFlight = true;/);
  const reset = controller.slice(controller.indexOf('Feedback._reset = () => {'));
  assert.match(reset, /if \(!captureInFlight\) \{/,
    '_reset must keep the draft while a capture round trip is open');
  const guarded = reset.slice(reset.indexOf('if (!captureInFlight) {'), reset.indexOf('feedbackText.disabled = false'));
  for (const kept of ["feedbackText.value = ''", "feedbackTitle.value = ''", "feedbackStatus.classList.add('hidden')"]) {
    assert.ok(guarded.includes(kept), `${kept} belongs inside the captureInFlight guard`);
  }
  // The flag is released whatever the attempt did, or the dialog would never
  // clear again.
  assert.match(controller, /captureInFlight = false;\n\s*clearCaptureDraft\(\);/);
});

test('every capture failure says the feedback itself is safe', () => {
  // The screenshot is retakeable; the paragraph the user just typed is not.
  const round = controller.slice(
    controller.indexOf('const runCapture = async'),
    controller.indexOf("screenshotBtn.addEventListener('click'"),
  );
  const notices = round.match(/showFeedbackNotice\([^;]*\);/g) || [];
  assert.ok(notices.length >= 5, `every capture failure branch should be found: ${notices.length}`);
  for (const notice of notices) {
    assert.match(notice, /your feedback is safe/i, `capture notice should reassure: ${notice}`);
  }
  // And one of them says it in the exact words dapp.json's check looks for.
  assert.ok(round.includes('your feedback is safe'),
    'the native-failure branch carries the lowercase phrase /?shot=feedback-capture-failed asserts');
});

test('the caret comes back where the user left it', () => {
  assert.match(controller, /document\.activeElement === feedbackText/);
  assert.match(controller, /feedbackText\.setSelectionRange\(caretStart, caretEnd\)/);
  // …inside restoreDialog, so it runs on the failure path too, not only when
  // a blob actually arrived.
  const restore = controller.slice(
    controller.indexOf('const restoreDialog = () => {'),
    controller.indexOf('let blob;'),
  );
  assert.match(restore, /resumeDialog\(\)/);
  assert.match(restore, /if \(caretWasHere\) requestAnimationFrame\(\(\) => restoreCaret\(2\)\)/,
    'the caret is re-claimed across frames — the kit focuses the card one frame after it presents');
});

test('a capture that kills the page leaves the words in sessionStorage', () => {
  assert.match(controller, /const CAPTURE_DRAFT_KEY = 'usernode\.feedbackCaptureDraft'/);
  // Text only — never the screenshot bytes, never the collected app state.
  const stash = controller.slice(controller.indexOf('const stashCaptureDraft'), controller.indexOf('const clearCaptureDraft'));
  assert.match(stash, /description,\n\s*title,\n\s*titleDirty,\n\s*target: feedbackTarget,/);
  assert.ok(!/screenshotBlob|screenshotId/.test(stash), 'the stash must stay text-only');
  // Armed before the page can die: the native suspend, and the camera roll.
  assert.match(controller, /stashCaptureDraft\(\);\n\s*suspendDialog\(\);/);
  assert.match(controller, /stashCaptureDraft\(\);\n\s*screenshotInput\.click\(\);/);
  // Ignored once stale, and never written from a ?shot= route (a synthetic
  // draft must not follow the reviewer into a real session).
  assert.match(controller, /CAPTURE_DRAFT_MAX_AGE_MS = 10 \* 60 \* 1000/);
  assert.match(controller, /Date\.now\(\) - draft\.savedAt > CAPTURE_DRAFT_MAX_AGE_MS/);
  assert.match(controller, /const onShotRoute = \(\)/);
  assert.match(stash, /if \(onShotRoute\(\)\) return;/);
});

test('the stash is handed back on the next open, and announced at boot', () => {
  const open = controller.slice(controller.indexOf('Feedback._open = (opts = {}) => {'));
  const rescue = open.indexOf('const rescued = readCaptureDraft()');
  assert.ok(rescue > 0, '_open should read the capture stash');
  // After the outbox's own hand-back, and only into an untouched field —
  // the same "live text always wins" rule.
  assert.ok(rescue > open.indexOf('FeedbackQueue.takeFailed()'),
    'the outbox hand-back keeps its place; the capture rescue follows it');
  assert.match(open, /if \(!feedbackText\.disabled && !feedbackText\.value\.trim\(\)\) \{/);
  assert.match(open, /feedbackText\.value = rescued\.description;/);
  // Read once, so a rescue the user ignored does not keep reappearing.
  assert.match(open, /const rescued = readCaptureDraft\(\);\n\s*if \(rescued\) \{\n\s*clearCaptureDraft\(\);/);
  // Boot notice, published like App.openFeedbackModal. Fired from BOTH ends
  // because hydration and /api/auth/me race: enterAuthed usually runs before
  // this island wires up, a slow bundle reverses it, and the once-per-boot
  // flag makes whichever lands second a no-op.
  assert.match(controller, /App\.noticeRescuedFeedbackDraft = \(\) => \{/);
  assert.match(controller, /if \(bootDraftAnnounced \|\| !App\.user\) return;/);
  assert.match(controller, /bootDraftAnnounced = true;/);
  assert.match(controller, /PlatformUI\?\.toast\?\.\(/);
  assert.match(controller, /\n  App\.noticeRescuedFeedbackDraft\(\);/,
    'init() announces too, for the boot where it publishes after enterAuthed');
  const app = read('public/js/app.js');
  assert.match(app, /App\.noticeRescuedFeedbackDraft\?\.\(\)/);
  // And dropped the moment the draft is genuinely consumed.
  assert.equal((controller.match(/clearCaptureDraft\(\)/g) || []).length >= 5, true);
});

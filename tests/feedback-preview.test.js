// #5687: before posting, an attached picture or clip opens full size over
// "Suggest an improvement"; after posting, Done is the thanks sheet's filled
// first action.
//
// The preview's behaviour around the dialog is what these pin: it is a portal
// to <body> rendered BESIDE the dialog root (a click on its dark area must not
// reach the form's backdrop rule), Escape is taken in the capture phase and
// stopped there (the native kit modal would otherwise close the form too),
// Back is claimed through the back stack, and there is no Download because
// the file is already on the device. The thumbnail taps themselves are driven
// in tests/feedback-multi-screenshot-ui.test.js.
//
// Run with: node --test tests/feedback-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PREVIEW = read('frontend', 'src', 'features', 'dialogs', 'feedback-preview.tsx');
const DIALOG = read('frontend', 'src', 'features', 'dialogs', 'feedback.tsx');
const CONTROLLER = read('frontend', 'src', 'features', 'dialogs', 'feedback-controller.js');
const DIALOGS = JSON.parse(read('frontend', 'locales', 'en', 'dialogs.json'));
const CORE = JSON.parse(read('frontend', 'locales', 'en', 'core.json'));

test('the preview is portalled to <body>, outside the dialog root', () => {
  assert.match(PREVIEW, /createPortal\(/, 'a portal, so no clipped or transformed ancestor sizes it');
  assert.match(PREVIEW, /document\.body/, 'to the body');
  // React bubbles a portal's events through the component tree: drawn inside
  // DialogRoot, a click on the dark area would reach the dialog's backdrop
  // handler and close the form with the preview.
  const rootClose = DIALOG.indexOf('</DialogRoot>');
  assert.ok(rootClose > 0, 'the dialog root is closed in feedback.tsx');
  assert.ok(DIALOG.indexOf('<FeedbackPreview item=') > rootClose, 'the preview is rendered beside the root');
});

test('Escape closes only the preview, ahead of the kit modal behind it', () => {
  // The native kit installs its Escape listener in native.js, capture on
  // window, registered before any React island. A listener the preview added
  // later cannot preempt it, so the shell's head carries a guard registered
  // BEFORE the kit's script: it stops the press there and hands it over.
  const HEAD = read('frontend', 'src', 'head.html');
  const guardAt = HEAD.indexOf('feedback-preview:escape');
  const kitAt = HEAD.indexOf('src="/usernode-native/v1/native.js"');
  assert.ok(guardAt > 0, 'head.html carries the Escape guard');
  assert.ok(guardAt < kitAt, 'registered before the kit\'s own listener');
  const guard = HEAD.slice(HEAD.lastIndexOf('<script>', guardAt), HEAD.indexOf('</script>', guardAt));
  assert.match(guard, /event\.stopImmediatePropagation\(\);/, 'the kit modal never gets the press');
  assert.match(guard, /event\.preventDefault\(\);/, 'nothing else treats the press as a dismissal');
  assert.match(guard, /document\.querySelector\('\[data-feedback-preview\]'\)/, 'only while a preview is up');
  assert.match(guard, /if \(event\.key !== 'Escape'\) return;/, 'only Escape');
  assert.match(PREVIEW, /window\.addEventListener\('feedback-preview:escape', onEscape\)/);
});

test('a tap on the dark area closes it, and not the dialog under it', () => {
  assert.match(PREVIEW, /event\.target !== event\.currentTarget/, 'only the backdrop itself, not the picture');
  assert.match(PREVIEW, /data-feedback-preview=""/, 'the overlay has its own marker');
});

test('Back closes the preview through the back stack, as the chat viewer does', () => {
  assert.match(PREVIEW, /pushDismissible\(\(\) => \{/);
  assert.match(PREVIEW, /if \(!backed\) release\(\);/);
});

test('the preview offers no Download, because the file is already on the device', () => {
  assert.doesNotMatch(PREVIEW, /DownloadIcon|useCanSaveImage|saveImage/);
  assert.doesNotMatch(PREVIEW, /imageViewer\.download|imageViewer\.downloading/);
});

test('the dialog clears its preview before the reset revokes the attached bytes', () => {
  const start = DIALOG.indexOf('onClose: () =>');
  const onClose = DIALOG.slice(start, DIALOG.indexOf('useKeyboardSurface(cardRef', start));
  assert.ok(onClose.indexOf('setPreview(null)') >= 0, 'the preview is cleared on close');
  assert.ok(onClose.indexOf('setPreview(null)') < onClose.indexOf('Feedback._reset()'),
    'cleared first: _reset revokes the object URL the preview is showing');
  const layout = DIALOG.slice(DIALOG.indexOf('useIsomorphicLayoutEffect(() => {\n    // The controller'));
  assert.match(layout, /Feedback\._preview = setPreview;\n    initFeedback\(\);/, 'the controller reaches the island before its thumbnails are wired');
});

test('every message id the preview and its thumbnails ask for exists', () => {
  const asked = [
    ...[...PREVIEW.matchAll(/t\('dialogs:([^']+)'/g)].map((m) => m[1]),
    ...[...CONTROLLER.matchAll(/t\('dialogs:(feedback\.(?:screenshot|video)\.(?:view|previewLabel))'/g)].map((m) => m[1]),
  ];
  assert.ok(asked.length >= 3, 'the new names are asked for');
  for (const id of new Set(asked)) assert.ok(id in DIALOGS, `dialogs:${id}`);
  assert.ok('common.close' in CORE, 'core:common.close');
  assert.equal(DIALOGS['feedback.screenshot.view'].text, 'View image {{number}}');
  assert.equal(DIALOGS['feedback.video.view'].text, 'View video');
  assert.equal(DIALOGS['feedback.video.previewLabel'].text, 'Attached video');
});

test('the thumbnail buttons hand the island their file', () => {
  assert.match(CONTROLLER, /data-feedback-screenshot-open/);
  assert.match(CONTROLLER, /Feedback\._preview\(\{\s*kind: 'image', src: shot\.objectUrl, alt: shot\.img\.alt, pins: shot\.pins \|\| null,/);
  assert.match(CONTROLLER, /data-feedback-video-open/);
  assert.match(CONTROLLER, /Feedback\._preview\(\{ kind: 'video', src: entry\.objectUrl \}\)/);
});

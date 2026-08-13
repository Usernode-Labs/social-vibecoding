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

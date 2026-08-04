// Contract coverage for issue #824's mobile/paste feedback attachment UI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const picker = fs.readFileSync(path.join(root, 'public/js/screenshot-select.js'), 'utf8');

test('feedback modal exposes an accessible multi-image picker on every platform', () => {
  assert.match(html, /id="feedback-photo-btn" type="button"/);
  assert.match(html, /id="feedback-photo-input" type="file" accept="image\/\*" multiple/);
  assert.match(html, /anyone with an image link can view it/i);
  assert.match(html, /id="feedback-screenshot-error"[^>]*role="alert"/);
});

test('picker, paste, cleanup, and ordered submit share one attachment path', () => {
  assert.match(app, /photoButton\.addEventListener\('click'/);
  assert.match(app, /feedbackText\.addEventListener\('paste'/);
  assert.match(app, /ScreenshotSelect\.normalizeImageFile\(file\)/);
  assert.match(app, /URL\.revokeObjectURL\(entry\.objectUrl\)/);
  assert.match(app, /body\.screenshotIds = screenshotIds/);
  assert.match(app, /screenshotProcessing > 0/);
});

test('selected files are bounded, downscaled, and re-encoded through canvas', () => {
  assert.match(picker, /MAX_SOURCE_BYTES = 40 \* 1024 \* 1024/);
  assert.match(picker, /MAX_EDGE_PX = 2400/);
  assert.match(picker, /createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/);
  assert.match(picker, /ctx\.drawImage\(source/);
  assert.match(picker, /return await exportBlob\(canvas\)/);
});

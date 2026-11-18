// A staging preview ALWAYS has a way out of it (#1443).
//
// The overlay used to have two other arrangements: under the header and the
// dev session strip (the strip's pencil segment was the way back), and docked
// beside a dev chat (its × closed it). Both hid #staging-back, and a preview
// opened outside a session once went under the strip anyway, hid both exits
// and handed the job to a control that was not rendered: nothing on screen
// closed the preview.
//
// The dev chat and its strip are retired. Since Nov 2026 the preview stands
// in a column beside a thread, in the side panel's place, or in the whole
// window (features/staging/placement.ts), and in every one of them its own
// round control is the way out: Back in the whole window, × docked. So the
// guarantee is simpler and this test pins it: that control is always
// rendered, wired, and never hidden by a stylesheet.
//
// Run with: node --test tests/staging-preview-has-an-exit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
const css = read('public/css/app.css');

test('the overlay renders its own Back, wired, and never ships it hidden', () => {
  const at = overlay.indexOf('id="staging-back"');
  assert.ok(at !== -1, 'the Back button is rendered');
  const tag = overlay.slice(overlay.lastIndexOf('<button', at), overlay.indexOf('</button>', at));
  assert.doesNotMatch(tag.match(/className="([^"]*)"/)[1], /\bhidden\b/, 'it is not hidden by class');
  assert.match(tag, /onClick=\{\(\) => stagingHandlers\.onBack\?\.\(\)\}/,
    'and wired to the handler app-view.js points at closing the preview');
});

test('no stylesheet rule hides the last exit', () => {
  // A rule that names #staging-back and hides it would bring the trap back:
  // whatever arrangement it is scoped to, the preview needs another exit
  // there first.
  const rules = [...css.matchAll(/([^{}]*#staging-back[^{}]*)\{([^}]*)\}/g)];
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden/,
      `${selector.trim()} hides #staging-back`);
  }
  assert.doesNotMatch(css, /staging-overlay-under-chrome|staging-overlay-docked/,
    'the arrangements that hid it are gone');
});

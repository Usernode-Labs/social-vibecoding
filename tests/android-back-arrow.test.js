'use strict';

// Overnight audit G01 (2 Nov 2026): Android's header back is a plain arrow
// with no disc, Material's arrow_back, not iOS's chevron in a tinted disc.
// The kit marks the device on <html> (`un-android`, usernode-native
// detectPlatform); the header ships both glyphs and app.css picks one.
//
// Run with: node --test tests/android-back-arrow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the header ships the arrow beside the chevron, with no id and no state of its own', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  const chevron = header.indexOf('id="back-icon-arrow"');
  const arrow = header.indexOf('<ArrowLeftIcon className="back-icon-android w-5 h-5" />');
  assert.ok(chevron > 0 && arrow > chevron, 'the arrow follows the chevron, its sibling');
  const icons = read('frontend/@/components/ui/icons.tsx');
  assert.match(icons, /export const ArrowLeftIcon = stroked\('ArrowLeftIcon', 'M10 19l-7-7m0 0l7-7m-7 7h18'\);/);
});

test('only on html.un-android: the disc goes and the arrow shows exactly when the chevron would', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.back-icon-android \{ display: none; \}/, 'never shown elsewhere');
  assert.match(css, /html\.un-android #back-btn \{\n  border-color: transparent;\n  background: transparent;\n\}/);
  assert.match(css, /html\.un-android #back-btn > #back-icon-arrow \{ display: none; \}/);
  assert.match(css, /html\.un-android #back-btn > #back-icon-arrow:not\(\.hidden\) \+ \.back-icon-android \{ display: block; \}/,
    'keyed off the chevron\'s own hidden, which app.js\'s pre-hydration fallback also toggles');
  const kit = read('public/usernode-native/v1/native.js');
  assert.match(kit, /document\.documentElement\.classList\.add\('un-' \+ platform\);/, 'the seam the rule hangs off');
});

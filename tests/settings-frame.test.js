// Settings in the one frame. The 2026-11-06 screen tour draws every section
// of Settings as the frame's page (s57 to s73): the section under its title
// in the content column, the other sections as a list in the context column
// beside it. The product already has both parts (features/settings/
// index.tsx: the section's sheet and the section list), the other way round
// and in one centred sheet, so under a look they are laid as the kit's page
// by app.css alone, for all its sections at once. On a phone the product's
// own two levels are the tour's: the list, then a section.
//
// Run with: node --test tests/settings-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
const ANY = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\)';

test('on a wide window the section comes first at the kit\'s 720px, the list of sections 320px after it', () => {
  const wide = hand.slice(hand.indexOf('SETTINGS (features/settings/index.tsx)'));
  assert.match(wide, new RegExp(`@media \\(min-width: 1024px\\) \\{\\s+${ANY} #settings-root \\{ max-width: 1136px; padding: 32px 32px 48px; \\}`));
  assert.match(wide, new RegExp(`${ANY} #settings-content-col \\{ order: 1; flex: 0 1 720px; \\}`));
  assert.match(wide, new RegExp(`${ANY} #settings-sidebar-col \\{ order: 2; flex: 0 0 320px; width: 320px; \\}`));
});

test('the section\'s sheet is put away so its groups sit on the page, and its title is the kit\'s', () => {
  assert.match(hand, new RegExp(`${ANY} #settings-section-content\\.settings-sheet \\{[^}]*background: none; box-shadow: none;`));
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.title.to, /\.settings-page-title/, 'each look\'s own title rule reaches it');
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) :is\(\.settings-page-title,#first-session-make-title\)\{font-size:28px;/);
});

test('the screen\'s own markup is untouched: the same ids the standard look and the declared checks read', () => {
  const src = read('frontend/src/features/settings/index.tsx');
  for (const id of ['settings-root', 'settings-sidebar-col', 'settings-content-col', 'settings-section-content']) {
    assert.match(src, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(src, /isFrameSkin|useLiveSkin/, 'laid out by the stylesheet alone');
});

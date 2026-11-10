// Make in the one frame. Opened from Create, "What do you want to make?"
// (features/first-session/make.tsx) and the made screen after it are laid
// under the platform's header across the whole window. Under a look the
// frame's sidebar and tab bar are part of the page, so the two take the
// frame's page area instead of running over them, on the look's own
// ground, and the title is the kit's. The form itself is the product's.
//
// Run with: node --test tests/make-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));

test('from Create, Make and the made screen sit in the frame\'s page area, not over its sidebar and bar', () => {
  const rule = hand.match(/html\[data-skin\]\[data-frame-chrome\] \.platform-kb-surface\.platform-under-header \{([^}]*)\}/);
  assert.ok(rule, 'only while the frame\'s chrome is up');
  assert.match(rule[1], /top: var\(--fr-shell-top, 0px\);/);
  assert.match(rule[1], /bottom: 0;\s+padding-bottom: var\(--fr-shell-bottom, 0px\);/, 'to the foot, the tab bar\'s height kept clear inside: the bar is see-through');
  assert.match(rule[1], /inset-inline-start: var\(--fr-shell-left, 0px\);/);
  assert.match(rule[1], /background: var\(--fr-ground\) !important;/, 'the look\'s ground, over the wallpaper the screen sets on itself');
  // The roots the rule reads are the product's, as written.
  const make = read('frontend/src/features/first-session/make.tsx');
  assert.match(make, /export const MAKE_ROOT_UNDER_HEADER = 'platform-kb-surface platform-under-header fixed inset-x-0 bottom-0 /);
  assert.match(make, /export const MAKE_ROOT = 'platform-kb-surface fixed inset-0 /, 'the first session\'s Make keeps the whole screen');
});

test('the title wears the kit\'s title', () => {
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.title.to, /#first-session-make-title/);
  assert.match(read('frontend/src/features/first-session/make.tsx'), /id="first-session-make-title"/);
});

// The waitlist fields keep a visible outline when they are focused (#1529).
//
// Both screens used `focus:outline-none`, a box-shadow ring, and a focused
// border set to transparent: the resting border is removed on focus and the
// ring is drawn in its place. iOS Safari does not paint box-shadow on a
// natively-styled control, so on a phone the border vanished on tap and
// nothing replaced it — a field that looks LESS defined the moment you are
// typing in it.
//
// The fix is not to drop the ring (it is the better indicator wherever it
// draws) but to stop removing the border: a focused field colours its border
// instead. That leaves a visible outline on every engine.
//
// Every assertion below reads CLASS ATTRIBUTES only, never the file text —
// the doc comments on both sides of this change quote the retired utility.
//
// Run with: node --test tests/waitlist-focus-outline.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCREENS = [
  'frontend/src/features/auth/waitlist.tsx',
  'frontend/src/features/auth/more.tsx',
];

/** Every `className="…"` literal in a screen, comments excluded by construction. */
function classAttributes(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return Array.from(src.matchAll(/className=(?:"([^"]*)"|'([^']*)')/g), (m) => m[1] ?? m[2]);
}

test('no waitlist field hides its border on focus', () => {
  for (const rel of SCREENS) {
    for (const cls of classAttributes(rel)) {
      assert.ok(!cls.includes('focus:border-transparent'),
        `${rel}: a transparent focused border is invisible wherever the ring is`);
    }
  }
});

test('every focus ring is paired with a focused border colour', () => {
  // The two always travel together: the ring for engines that paint it, the
  // border for the ones that do not.
  let checked = 0;
  for (const rel of SCREENS) {
    for (const cls of classAttributes(rel)) {
      if (!cls.includes('focus:ring-2')) continue;
      checked += 1;
      assert.ok(cls.includes('focus:border-violet-500'),
        `${rel}: a focus ring without a focused border reads as no outline on iOS Safari`);
    }
  }
  assert.ok(checked >= 15, `expected the whole waitlist form, saw ${checked} fields`);
});

test('the country select — the control the report named — is covered', () => {
  const src = fs.readFileSync(path.join(ROOT, SCREENS[0]), 'utf8');
  const select = src.slice(src.indexOf('id="waitlist-country"'));
  const classes = select.slice(0, 400).match(/className="([^"]*)"/)?.[1] || '';
  assert.match(classes, /border border-zinc-300/, 'still bordered at rest');
  assert.match(classes, /focus:border-violet-500/, 'and bordered when focused');
});

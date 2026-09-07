// The app chip's subtitle is a glyph on a phone, a word from `sm` up (#1613).
//
// The chip fits an app's name, the part of it you are in, and a chevron into
// one line. The name is the half that truncates — the subtitle is `shrink-0` —
// so "Board" costs roughly six characters of the app's own name on every
// narrow screen, permanently.
//
// Three things are pinned, and each is a way this could go wrong:
//
//   1. BOTH forms are in the markup, with CSS choosing. A matchMedia swap
//      would re-render on every resize and orientation change, and would take
//      the word out of the document entirely.
//   2. The WORD survives at `sm` and up. The proposal checks capture at 1280,
//      and one of them asserts the chip's subtitle reads "Board" — a
//      phone-only glyph that hid the word at every width would fail it.
//      (`expectText` reads `innerText`, so display:none text does not count.)
//   3. An unmapped subtitle keeps its word at every width, so a route added
//      later degrades to the old behaviour instead of rendering nothing.
//
// Run with: node --test tests/app-chip-subtitle-icon.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHIP = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/header/app-switcher-chip.tsx'), 'utf8');
const ICONS = fs.readFileSync(
  path.join(ROOT, 'frontend/@/components/ui/icons.tsx'), 'utf8');

test('the glyph is mobile-only and the word returns at sm', () => {
  const label = CHIP.slice(CHIP.indexOf('function SubtitleLabel'));
  const body = label.slice(0, label.indexOf('\n}'));
  assert.match(body, /className="sm:hidden/, 'the glyph hides from sm up');
  assert.match(body, /className="hidden sm:inline"/, 'and the word appears there');
  // Both are rendered; neither is chosen in JavaScript.
  // A CALL, not the word: the doc comment above explains why there isn't one.
  assert.doesNotMatch(CHIP, /matchMedia\s*\(/,
    'a resize must not re-render the header');
});

test('the word is what a text assertion still finds at 1280', () => {
  const label = CHIP.slice(CHIP.indexOf('function SubtitleLabel'));
  const body = label.slice(0, label.indexOf('\n}'));
  // The declared check "The Board names itself in the chip" reads innerText at
  // the capture viewport, so the word must be VISIBLE there, not merely
  // present.
  const word = body.slice(body.indexOf('hidden sm:inline'));
  assert.match(word, /\{subtitle\}/);
});

test('an unmapped subtitle keeps its word at every width', () => {
  const label = CHIP.slice(CHIP.indexOf('function SubtitleLabel'));
  assert.match(label, /if \(!Icon\) return <>\{subtitle\}<\/>;/);
});

test('every mapped glyph is a real export of the icon module', () => {
  const map = CHIP.slice(CHIP.indexOf('const SUBTITLE_ICON'));
  const names = Array.from(map.slice(0, map.indexOf('};')).matchAll(/:\s*([A-Za-z]+Icon)/g),
    (m) => m[1]);
  assert.ok(names.length >= 3, `expected the mapped subtitles, saw ${names.length}`);
  for (const name of names) {
    assert.ok(ICONS.includes(`export const ${name}`), `${name} is exported by icons.tsx`);
    assert.ok(CHIP.includes(name), `${name} is imported into the chip`);
  }
});

test('the glyph is decoration: the button already speaks the subtitle', () => {
  const label = CHIP.slice(CHIP.indexOf('function SubtitleLabel'));
  assert.match(label.slice(0, label.indexOf('\n}')), /aria-hidden="true"/);
  // The accessible name carries the word at every width.
  assert.match(CHIP, /aria-label=\{spokenSubtitle \? `\$\{text\}, \$\{spokenSubtitle\}/);
});

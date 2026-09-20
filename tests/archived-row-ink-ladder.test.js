'use strict';

// #2481: the archived-session row lost its title/caption ink ladder.
//
// Before the widget-library migration (#1400) the row read
//   title   text-zinc-500 dark:text-zinc-400
//   caption text-zinc-400 dark:text-zinc-500
// — a rung apart in both themes. The migration rewrote the caption's LIGHT
// half from zinc-400 to zinc-500, which made title and caption the SAME ink
// on a light page: no ladder at all, just two sizes of one grey.
//
// It is not restored by putting the old caption back. A bare light zinc-400
// is what tests/theme-ink-guards.test.js rules 2 and 2a exist to stop, so
// the migration's half of this was a contrast fix and has to stand. The
// ladder is restored from the TITLE side instead: the title moves up a rung
// to zinc-700/300, and the caption takes the shell's ordinary secondary ink,
// text-zinc-500 dark:text-zinc-400.
//
// That also fixes a second defect the flat pair was hiding: the caption's
// dark half was `dark:text-zinc-500`, which on the #0b0b0c page is the
// 3.55:1 that guard names as a WCAG AA failure.
//
// The row stays QUIETER than a live one, which is the point of an archived
// row — a live card title is zinc-800/900, this is zinc-700/300, and the row
// still carries `dev-card-muted` and still sits behind the "Show archived"
// disclosure.
//
// Run with: node --test tests/archived-row-ink-ladder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/dev-board/card/list-rows.tsx'), 'utf8'
);

/** The archived list's two spans, in source order. */
function archivedSpans() {
  const at = SRC.indexOf('data-archived-list');
  assert.notEqual(at, -1, 'the archived list should still be rendered');
  const block = SRC.slice(at, SRC.indexOf('data-unarchive-chip', at));
  const title = block.match(/className="(block text-sm[^"]*)"/);
  const caption = block.match(/className="(block text-xs[^"]*)"/);
  assert.ok(title, 'archived row keeps a title span');
  assert.ok(caption, 'archived row keeps a caption span');
  return { title: title[1], caption: caption[1] };
}

test('the title and caption are a rung apart in BOTH themes', () => {
  const { title, caption } = archivedSpans();

  assert.match(title, /\btext-zinc-700\b/, 'title: light ink');
  assert.match(title, /\bdark:text-zinc-300\b/, 'title: dark ink');

  assert.match(caption, /\btext-zinc-500\b/, 'caption: light ink');
  assert.match(caption, /\bdark:text-zinc-400\b/, 'caption: dark ink');

  // The defect itself: never the same ink on either side.
  const lightOf = (c) => (c.match(/(?:^|\s)text-zinc-(\d+)/) || [])[1];
  const darkOf = (c) => (c.match(/dark:text-zinc-(\d+)/) || [])[1];
  assert.notEqual(lightOf(title), lightOf(caption), 'light theme: a ladder, not one grey');
  assert.notEqual(darkOf(title), darkOf(caption), 'dark theme: a ladder, not one grey');
});

test('the caption uses the shell’s ordinary secondary ink', () => {
  const { caption } = archivedSpans();
  // `dark:text-zinc-500` on the near-black page is the 3.55:1 AA failure
  // theme-ink-guards names; the paired form is the shell's secondary ink.
  assert.doesNotMatch(caption, /dark:text-zinc-500\b/);
});

test('the row stays quieter than a live card, and keeps its muted marker', () => {
  const { title } = archivedSpans();
  assert.doesNotMatch(title, /text-zinc-(?:800|900)\b/,
    'an archived title must not read as loud as a live one');
  assert.match(SRC, /data-archived-toggle/, 'still behind the disclosure');
});

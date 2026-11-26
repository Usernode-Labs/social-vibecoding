'use strict';

// #7231: the Homeroom bot list's head card holds New chat's + and the All
// projects chip inside its own padding at every list width.
//
// Why it overflowed: the head card was a grid with one implicit auto track,
// whose minimum is its items' min-content. The search field's input brought
// in its built-in width (about 20 characters), so the track was wider than
// the card at the 280px list floor: the hero line stretched past the card
// (the + with it) and the tools line believed it had room, so the search and
// the chip shared one line and the chip ran over the edge.
//
// What this pins:
//   1. The head card's one column is minmax(0, 1fr), and its two lines can
//      be narrower than their contents.
//   2. The search field's input has no width of its own; it grows by flex-1.
//   3. The filter chip may shrink, so its truncate label can end in "…",
//      in the ONE LOOK block and in its className (the classic look too).
//
// Run with: node --test tests/ai-head-fit.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_CSS = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
const LISTS = fs.readFileSync(path.join(ROOT, 'frontend/src/features/ai/lists.tsx'), 'utf8');

// The declarations of the first rule whose selector is exactly `selector`.
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = APP_CSS.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `no rule for ${selector}`);
  return m[1];
}

test('the head card is one column that can be narrower than its contents', () => {
  const head = rule('html:root #ai-screen [data-ai-sheet="head"]');
  assert.match(head, /display: grid;/);
  assert.match(head, /grid-template-columns: minmax\(0, 1fr\);/,
    'an implicit auto track is as wide as the search field\'s min-content, which is past the card at the 280px floor');
  assert.match(head, /padding: 12px;/, 'the card keeps its own padding');

  const lines = rule('html:root #ai-screen [data-ai-sheet="head"] > :is([data-ai-hero], [data-ai-tools])');
  assert.match(lines, /padding: 0;/);
  assert.match(lines, /min-width: 0;/, 'the hero and the tools line may be narrower than their contents');
});

test('the search field grows by flex-1 alone: no built-in input width', () => {
  assert.match(rule('html:root #ai-screen [data-ai-search-box]'), /min-width: 7rem;/, 'the label keeps its own floor');
  assert.match(rule('html:root #ai-screen [data-ai-search-box] > input'), /width: 0;/);
});

test('the filter chip may shrink, so its label can end in an ellipsis', () => {
  const chip = rule('html:root #ai-screen [data-ai-project-more].one-chip');
  assert.match(chip, /max-width: 100%;/);
  assert.match(chip, /flex: 0 1 auto;/);
  assert.match(chip, /min-width: 0;/);
  // The button's own className carries the classic look's classes.
  const at = LISTS.indexOf('data-ai-project-more=""');
  assert.ok(at > 0, 'the filter chip is drawn');
  const tag = LISTS.slice(LISTS.lastIndexOf('<button', at), at);
  const own = /className=\{`([^`]*)`\}/.exec(tag);
  assert.ok(own, 'the chip has a className');
  assert.match(own[1], /\bmax-w-full shrink\b/, 'the chip may shrink');
  assert.doesNotMatch(own[1], /shrink-0/, 'shrink-0 is what kept the chip past the card');
  assert.match(own[1], /min-w-0/, 'and its truncate label may shorten');
});

test('the chip\'s glyphs keep their size while its label shortens', () => {
  const at = LISTS.indexOf('data-ai-project-more=""');
  const button = LISTS.slice(LISTS.lastIndexOf('<button', at), LISTS.indexOf('</button>', at));
  assert.match(button, /<SmallTile app=\{onlyPicked\} \/>/, 'a picked project keeps its tile');
  assert.match(button, /className="ai-filter-glyph h-4 w-4 shrink-0/, 'the glyph keeps its size');
  assert.match(button, /className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400"/, 'so does the chevron');
  assert.match(button, /<span className="min-w-0 truncate">\{filterWords\}<\/span>/, 'the label is the part that shortens');
});

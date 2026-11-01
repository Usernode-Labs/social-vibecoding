'use strict';

// iPhone Duo, 1 November 2026: scrolled up a chat, the messages were cut off
// 24px above the reply box, with bare page between. The band was outside the
// scroller: the "is typing" line holding 18px open while it said nothing, and
// 6px of the composer's own padding over its card. The transcript now runs to
// the card's edge, and the air under the newest message is the scroller's own
// end, which scrolls away with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CSS = read('public/css/app.css');

function rule(selectorLine) {
  const i = CSS.indexOf(`\n${selectorLine}`);
  assert.ok(i >= 0, `expected a rule starting \`${selectorLine}\``);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('an empty typing line takes no room, and stays in the page', () => {
  const body = rule('.messages-typing:empty {');
  assert.match(body, /min-height: 0;/);
  assert.match(body, /padding-block: 0;/);
  assert.doesNotMatch(body, /display: none/, 'its live region has to be there before a name arrives');
  // The group chat's lines are Tailwind `h-5`, which loads after app.css:
  // the ids outrank it.
  assert.match(rule('#gc-typing:empty,\n#gc-thread-typing:empty {'), /height: 0;/);
  // Still a sibling of the scroller rather than a row inside it, so a name
  // shows whether or not the reader is at the bottom.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /<\/div>\n\s*<div className="messages-typing" aria-live="polite">\{typingLine\(t, typing\)\}<\/div>/);
});

test('the composer has no padding over its card', () => {
  assert.match(rule('.messages-composer,\n.messages-composer-disabled {'), /padding: 0 12px 8px;/);
  // The notice of a first message is a line of text, not a card: it keeps
  // the air above it.
  assert.match(CSS, /\.messages-composer-hint \{ margin: 6px 4px 6px;/);
});

test('the air under the newest message is inside the scroller', () => {
  const body = rule('.messages-thread-scroll.platform-safe-scroll:has(~ .platform-safe-bar) {');
  assert.match(body, /padding-bottom: 12px !important;/);
  // It outranks the two `.platform-safe-scroll` rules that zero the foot with
  // the keyboard up, so the end is the same either way.
  assert.match(CSS, /\nhtml\.un-kb \.platform-safe-scroll \{\n  padding-bottom: 0 !important;/);
});

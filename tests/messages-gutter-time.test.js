'use strict';

// #5965: a continuation line's time stays on one line.
//
// A grouped row (the same person again, close behind their last message) puts
// only the time of day in the column its avatar would sit in. The column was
// 36px wide at 11px, and "9:18 AM" is about 40px there, so on a phone it broke
// into "9:18" over "AM" ("12:45 PM" is about 45px). It is now a 48px column
// that borrows 12px of the row's own padding, so the time never wraps and the
// message body does not move:
//
//   16 (row padding) - 12 (borrowed) + 48 (column) + 12 (row gap)
//     = 16 + 36 (the avatar it stands in for) + 12
//
// Run with: node --test tests/messages-gutter-time.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');

/** The declarations of the first top-level rule for exactly `selector`. */
function rule(selector) {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('\n}', at));
}

test('the continuation gutter is wide enough for a time and never wraps it', () => {
  const body = rule('.messages-message-gutter');
  assert.match(body, /white-space: nowrap;/, 'the time breaks into two lines without this');
  assert.match(body, /flex: 0 0 48px;/, '48px holds "12:45 PM" at 11px');
  assert.match(body, /width: 48px;/);
  assert.match(body, /margin-left: -12px;/, 'the 12px it borrows from the row\'s 16px padding');
  assert.match(body, /text-align: right;/, 'it still lines up at the avatar column\'s right edge');
});

test('the wider column does not move the message body', () => {
  const row = rule('.messages-message');
  assert.match(row, /gap: 12px;/);
  assert.match(row, /padding: 8px 16px;/);
  // 16 - 12 + 48 + 12 = 16 + 36 + 12: the body starts at x 64 either way.
  assert.equal(16 - 12 + 48 + 12, 16 + 36 + 12);
});

test('your own continuation row borrows the right edge instead', () => {
  const body = rule('.messages-message-bubble.messages-message-self > .messages-message-gutter');
  assert.match(body, /margin-left: 0;/, 'the left borrow would leave the right edge unchecked');
  assert.match(body, /margin-right: -12px;/);
  assert.match(rule('.messages-message-bubble.messages-message-self'), /flex-direction: row-reverse;/, 'the row it applies to runs right to left');
});

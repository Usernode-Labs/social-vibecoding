'use strict';

// QA 2026-09-24 Q22: a message's head — name, (tag,) time — stays inside its
// row on a phone.
//
// Two heads, one fault. An issue's GitHub comment head (`.dev-feed-msg-head`)
// was a nowrap name, a tag and a stamp that can carry a year ("Mar 5, 2024,
// 09:15 AM") in one row with no wrap and no `min-width: 0`: at 360px it ran
// past the bubble and off the screen. The Messages head
// (`.messages-message-head`) let a long name break at its hyphen
// ("@usernode- / capture") and squeezed the time into two lines.
//
// Now, in both: the name ends in an ellipsis rather than breaking, the time
// never wraps inside itself, and when even a short stub of the name and the
// time cannot share a line, the time takes a second line of the head.
//
// Run with: node --test tests/message-head-fit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');
const ROW = read('frontend/src/features/messages/message-row.tsx');

/** The declarations of the FIRST top-level rule for exactly `selector`. */
function rule(selector) {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('\n}', at));
}

for (const [head, author, time] of [
  ['.messages-message-head', '.messages-message-author', null],
  ['.dev-feed-msg-head', '.dev-feed-msg-author', '.dev-feed-msg-time'],
]) {
  test(`${head} wraps rather than overflowing, and can shrink inside its bubble`, () => {
    const body = rule(head);
    assert.match(body, /display: flex;/);
    assert.match(body, /flex-wrap: wrap;/);
    assert.match(body, /min-width: 0;/);
    assert.match(body, /gap: 0 \d+px;/, 'a column gap only, so a wrapped time sits tight under the name');
  });

  test(`${author} truncates with an ellipsis, and gives way before the time does`, () => {
    const body = rule(author);
    assert.match(body, /flex: 1 1 6em;/);
    assert.match(body, /min-width: 0;/);
    assert.match(body, /max-width: max-content;/, 'it grows to its own width and no further, so the time stays beside it');
    assert.match(body, /overflow: hidden;/);
    assert.match(body, /text-overflow: ellipsis;/);
    assert.match(body, /white-space: nowrap;/);
  });

  if (time) {
    test(`${time} never wraps inside itself`, () => {
      assert.match(CSS, new RegExp(`\\n${time.replace(/\./g, '\\.')} \\{[^}]*white-space: nowrap;`));
    });
  }
}

test('the Messages time and its "edited" never wrap inside themselves', () => {
  assert.match(CSS, /\.messages-message-head time,\n\.messages-message-head time ~ span \{[^}]*white-space: nowrap; \}/);
});

test('the Messages head names its author span, so the rule has something to hold', () => {
  assert.match(ROW, /<div className="messages-message-head"><span className=\{`messages-message-author \$\{mine \? 'text-violet-700 dark:text-violet-300' : ''\}`\}>/);
});

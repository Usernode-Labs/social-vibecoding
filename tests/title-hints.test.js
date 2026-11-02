'use strict';
// #6118: a title the layout cuts short (one line with "…", two lines with
// line-clamp) ended in dots with no way to read the rest without opening it.
// Every such title now carries the same string as its native `title` hint, so
// hovering shows it whole. ListRow does it for every row whose title is a
// plain string; the hand-drawn titles below pass it themselves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const LIST_ROW = 'frontend/@/components/ui/grouped-list.tsx';

test('ListRow shows a plain-string title as its own hint, and an explicit one still wins', () => {
  const plain = renderComponent(LIST_ROW, 'ListRow', { title: 'A title too long for its row' });
  assert.match(plain, /title="A title too long for its row"/);

  const explicit = renderComponent(LIST_ROW, 'ListRow', { title: 'Row label', tooltip: 'The hint' });
  assert.match(explicit, /title="The hint"/);
  assert.doesNotMatch(explicit, /title="Row label"/);

  // A JSX title is not a string, so the primitive writes nothing: the caller
  // that knows the string passes `tooltip` (bot-slots does).
  const jsx = renderComponent(LIST_ROW, 'ListRow', {
    title: createElement('span', { className: 'truncate' }, 'Row label'),
  });
  assert.doesNotMatch(jsx, /title=/);
});

test('the hand-drawn truncated titles carry their text as the hint', () => {
  const workRow = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  // list, board, line and act rows: the anchor and the inert span of each.
  assert.equal(workRow.match(/title=\{card\.title\.text\}/g).length, 6);

  assert.match(read('frontend/src/features/home/widget-strip.tsx'),
    /className="[^"]*truncate[^"]*" title=\{tile\.name\}>/);
  assert.match(read('frontend/src/features/apps/browse-list.tsx'),
    /className="browse-row-name truncate" title=\{view\.name\}/);
  assert.match(read('frontend/src/features/apps/browse-list.tsx'),
    /className="browse-row-name truncate" title=\{site\.label\}/);
  assert.match(read('frontend/src/features/dev-board/workshop/bot-slots.tsx'),
    /tooltip=\{title \|\| undefined\}/);
  assert.match(read('frontend/src/features/dev-board/topic/topic-head.tsx'),
    /className="min-w-0 flex-1 truncate[^"]*" title=\{title\}>/);
  assert.match(read('frontend/src/features/dev-board/topic/thread-changes.tsx'),
    /className="min-w-0 truncate" title=\{fromPlan\}>/);

  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /className="messages-row-name" title=\{rowName \|\| undefined\}/);
  assert.match(messages, /className="messages-thread-name" title=\{threadName \|\| undefined\}/);
  assert.match(messages, /data-reply-title="" title=\{mainTitle \|\| undefined\}/);
  assert.match(messages, /className="min-w-0 truncate" title=\{replyTitle\}>/);

  const header = read('frontend/src/features/header/header-title.tsx');
  // The switcher's name: the text, never the logotype.
  assert.match(header,
    /id="header-title-name" className="min-w-0 truncate" title=\{selfHosted \? undefined : \(name \|\| text\) \|\| undefined\}/);
  // The community page's name: the text, never the logotype.
  assert.match(header,
    /title=\{communityName\s*\? \(selfHosted \? undefined : \(name \|\| text\) \|\| undefined\)\s*: \(showsWordmark \? undefined : text \|\| undefined\)\}/);
});

'use strict';
// #5050: opening a reply thread (or any scroll to a message Messages makes
// for the reader) must not move the screen itself.
//
// The screenshot in the request showed it: a thread opened from the Homeroom
// bot's chat had pushed the whole screen up about 85px, both title rows gone
// under the top bar and a band of empty background below the sheets. The
// cause is `scrollIntoView({ block: 'center' })`, which scrolls every
// scrolling ancestor: when the row cannot be centred in the transcript alone
// (a root near its top, say), the browser goes on to scroll `#messages-screen`
// by as much as it has overflow. That root is `overflow: hidden`, which is a
// scroll container script can still scroll; `overflow: clip` clips the same
// way but cannot be scrolled at all.
//
// Pinned here (a source test, as tests/messages-screen.test.js is):
//   - `#messages-screen` clips (`overflow-clip`), and is no longer
//     `overflow-hidden`;
//   - the conversation's focus effect and the reply thread's focus effect
//     set their pane's own `scrollTop` from `centredTopIn`, and call
//     `scrollIntoView` on no row;
//   - the request-chip card reveal and the quote button scroll the card's
//     or the target's own `.messages-thread-scroll`, keeping `scrollIntoView`
//     only where no such scroller exists.
//
// Run with: node --test tests/messages-scroll-in-place.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INDEX = read('frontend/src/features/messages/index.tsx');
const REF_CARDS = read('frontend/src/features/messages/ref-cards.tsx');
const MESSAGE_ROW = read('frontend/src/features/messages/message-row.tsx');

test('#messages-screen clips instead of being a scroll container', () => {
  assert.match(INDEX, /<main ref=\{screenRef\} id="messages-screen" className="hidden flex-1 min-h-0 overflow-clip"/,
    'the screen root is overflow: clip, which clips without being scrollable');
  assert.doesNotMatch(INDEX, /id="messages-screen"[^>]*overflow-hidden/,
    'overflow: hidden is a scroll container script can scroll, which is what moved the screen');
});

test('both focus effects set their pane\'s own scrollTop, never scrollIntoView', () => {
  // The conversation pane's (#2387) and the reply thread pane's. Both keep
  // the lines around the scroll exactly as they were (tests/
  // messages-stick-to-bottom.test.js pins those), only the scroll itself
  // changes: centredTopIn says where, the assignment applies it to the pane
  // alone.
  const effects = INDEX.match(/requestAnimationFrame\(\(\) => \{ el\.scrollTop = centredTopIn\(el, row\); \}\)/g) || [];
  assert.equal(effects.length, 2, 'the conversation and the reply thread both scroll their own pane');
  assert.doesNotMatch(INDEX, /row\.scrollIntoView/,
    'scrollIntoView would move the screen root as well as the pane');
  assert.match(INDEX, /import \{[\s\S]*centredTopIn[\s\S]*\} from '\.\/unread-anchor';/);
});

test('the request-chip card reveal scrolls the card\'s own transcript', () => {
  assert.match(REF_CARDS, /const scroller = card\.closest\('\.messages-thread-scroll'\);\s*if \(scroller\) \(scroller as HTMLElement\)\.scrollTo\(\{ top: centredTopIn\(scroller, card\), behavior: still \? 'auto' : 'smooth' \}\);\s*else card\.scrollIntoView\?\./,
    'the transcript is scrolled directly; scrollIntoView only without one');
  assert.match(REF_CARDS, /import \{ centredTopIn \} from '\.\/unread-anchor';/);
});

test('the quote button scrolls the target\'s own transcript', () => {
  // The scroll lives in `scrollReplyIntoView` (tests/messages-plain-text.test.js
  // pins how close the quote button's markup sits to its words), so the button
  // itself must call it.
  assert.match(MESSAGE_ROW, /className="messages-quote" onClick=\{\(\) => scrollReplyIntoView\(message\.reply\?\.id\)\}/,
    'the quote button goes through the helper');
  assert.match(MESSAGE_ROW, /target\.closest\('\.messages-thread-scroll'\)/);
  assert.match(MESSAGE_ROW, /scroll as HTMLElement\)\.scrollTo\(\{ top: centredTopIn\(scroll, target\), behavior: 'smooth' \}\)/,
    'the transcript is scrolled directly, still smoothly');
  assert.match(MESSAGE_ROW, /else target\.scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/,
    'without a transcript to own the scroll, scrollIntoView is kept');
  assert.match(MESSAGE_ROW, /import \{ centredTopIn \} from '\.\/unread-anchor';/);
});

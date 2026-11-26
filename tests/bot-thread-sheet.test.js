'use strict';

// A PRIVATE THREAD WITH THE BOT IS ONE COMPACT SHEET (#6863, 19 Nov 2026).
// The thread alone in the Homeroom bot tab's column — the DM-style thread,
// a request's or a design's — is drawn as a public thread is: a head card
// with the other member's round picture, the thread's name and the lock
// badge; the replies in a discussion card, every one the flat named row a
// channel draws; and the reply box, as the public thread's reply card, at
// the foot. (Until 20 Nov 2026 the cards were at most 446px wide and the
// replies scrolled inside the middle one; now the page is a public thread's.)
//
// What this pins:
//   1. Only the bot tab's alone pane is marked (`alone && botChat`); no
//      other thread pane gets `data-bot-sheet`.
//   2. The alone head opens on the bot's face, round, before the title.
//   3. A flat row is the named row, never a bubble on a side.
//   4. 20 Nov 2026: the sheet is a public thread's page (group-chat/
//      thread-page.tsx), drawn by the public thread's rules; what app.css
//      keeps for it alone is the pane's ground and the rows of its cards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const messages = read('frontend/src/features/messages/index.tsx');
const row = read('frontend/src/features/messages/message-row.tsx');
const css = read('public/css/app.css');

test('only the bot tab\'s alone pane is the sheet', () => {
  assert.match(messages, /const sheet = alone && botChat;/,
    'the sheet is the thread alone in the bot tab\'s column, and only that');
  assert.match(messages, /data-bot-sheet=\{sheet \? '' : undefined\}/);
  assert.equal((messages.match(/data-bot-sheet/g) || []).length, 1,
    'no other pane — Messages, a channel\'s thread, a project\'s — is marked');
});

test('the alone head opens on the bot\'s round face', () => {
  assert.match(messages, /<span data-reply-avatar=""><UserAvatar user=\{face\} title=\{aloneTitle \|\| undefined\} size="lg" shape="circle" \/><\/span>/,
    'the head card holds the round avatar');
  assert.match(messages, /const other = active\s*\n\s*\? active\.peer && active\.peer\.id !== meId\s*\n\s*\? active\.peer\s*\n\s*: active\.members\.find\(\(member\) => isBotMention\(member\.username\)\) \|\| null/,
    'it is the conversation\'s bot, or the initials fallback');
  assert.match(messages, /const face = sheet && other \? \(other\.bot \? other : \{ \.\.\.other, bot: true \}\) : null;/,
    'the bot is drawn with its own avatar, also when the roster only names its handle');
  // The header's own literal stays as tests/ai-screen.test.js pins it.
  assert.match(messages, /<header className="messages-thread-header" data-reply-head=\{alone \? 'alone' : undefined\}>/);
});

test('a flat row is the named row, never a bubble', () => {
  assert.match(row, /flat = false,/);
  assert.match(row, /\n\s*flat\?: boolean;/);
  assert.match(row, /const sided = !flat && kind !== 'channel'/,
    'flat turns the side off, as a channel row never had one');
  assert.equal((messages.match(/flat=\{sheet\}/g) || []).length, 2,
    'the root message and every reply in the thread are flat');
});

test('20 Nov 2026: the sheet is a public thread\'s page, drawn by the public thread\'s rules', () => {
  // #6863's own copy (three 446px cards, the replies scrolling inside the
  // middle one, its own head rules) is gone: a thread alone in the bot tab's
  // column is drawn on ../group-chat/thread-page.tsx, and app.css draws it
  // from the public thread's rules.
  assert.doesNotMatch(css, /\.messages-reply-pane\[data-bot-sheet\]/, 'no rules of the sheet\'s own');
  assert.match(messages, /const page = sheet;/);
  assert.match(messages, /data-thread-page-host=\{page \? '' : undefined\}/);
  assert.match(css, /#ai-screen \.messages-layout\[data-bot-threads\] > \.messages-reply-pane\[data-thread-page-host\] \{\s+background: transparent;/,
    'the pane draws no sheet: the page lies on the column\'s ground, as a request\'s does');
  assert.match(css, /:is\(\.dev-ws-side, \.in-side-panel body, \.gc-tab-body:has\(> \.gc-spec-side-panel-open\)\) #dev-topic-thread \.dev-request:has\(\.dev-request-rail:not\(:empty\)\) \.dev-request-sheet \{ background: transparent; \}/,
    'a public thread\'s page in a panel paints no ground either, as the private pane does');
  assert.match(css, /#ai-screen \.dev-private-thread \[data-thread-page-replies\] \.messages-message \{ padding: 8px 16px; gap: 12px; \}/,
    'the replies card\'s rows are the flat named rows');
  assert.match(css, /#ai-screen \.dev-private-thread \[data-thread-page-post\] \.messages-message > :first-child:not\(\.min-w-0\) \{ display: none; \}/,
    'the opening card holds the words, as a request\'s card does, with no face');
});

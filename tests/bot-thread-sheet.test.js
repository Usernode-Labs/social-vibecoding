'use strict';

// A PRIVATE THREAD WITH THE BOT IS ONE COMPACT SHEET (#6863, 19 Nov 2026).
// The thread alone in the Homeroom bot tab's column — the DM-style thread,
// a request's or a design's — is drawn as a public thread is: a head card
// with the other member's round picture, the thread's name and the lock
// badge; the replies in a discussion card, every one the flat named row a
// channel draws; and the reply box, as the public thread's reply card, at
// the foot. The cards are at most 446px wide and centred in the column, so
// the sheet is one screenful with the reply box visible.
//
// What this pins:
//   1. Only the bot tab's alone pane is marked (`alone && botChat`); no
//      other thread pane gets `data-bot-sheet`.
//   2. The alone head opens on the bot's face, round, before the title.
//   3. A flat row is the named row, never a bubble on a side.
//   4. The CSS block is scoped to the standard and brand looks, at most
//      446px, three cards of `--thread-card` at a 20px radius, with the
//      scroller taking the room between them.

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
  assert.match(row, /const sided = !flat && !frame && kind !== 'channel'/,
    'flat turns the side off, as a channel row never had one');
  assert.equal((messages.match(/flat=\{sheet\}/g) || []).length, 2,
    'the root message and every reply in the thread are flat');
});

test('the sheet\'s CSS draws three 446px cards in the standard and brand looks', () => {
  const scope = 'html:is(:not([data-skin]), [data-skin="brand"]) #ai-screen .messages-layout[data-bot-threads] > .messages-reply-pane[data-bot-sheet]';
  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(css, new RegExp(escaped(scope)),
    'a frame look keeps its own thread: nothing here applies under one');
  assert.match(css, new RegExp(`${escaped(scope)} > :is\\(\\.messages-thread-header, \\.messages-thread-scroll, \\.chat-status, \\.messages-composer, \\[data-private-thread\\], \\[data-live-draft\\]\\) \\{\\s+width: 100%;\\s+max-width: 446px;\\s+margin-inline: auto;`),
    'the three cards are one compact width, centred in the column');
  assert.match(css, new RegExp(`${escaped(scope)} \\{\\s+--thread-card: var\\(--thread-card-look, var\\(--dc-sheet-fill\\)\\);`));
  assert.match(css, new RegExp(`${escaped(scope)} \\{\\s+--thread-card: [^}]*--thread-card-r: 20px;`),
    'the public thread\'s card variables, at its 20px radius');
  assert.match(css, new RegExp(`${escaped(scope)} > \\.messages-thread-header \\{\\s+flex: 0 0 auto;[^}]*border-radius: var\\(--thread-card-r\\);[^}]*background: var\\(--thread-card\\);[^}]*box-shadow: var\\(--thread-card-edge\\);`),
    'the head card');
  assert.match(css, new RegExp(`${escaped(scope)} > \\.messages-thread-scroll \\{\\s+flex: 1 1 auto;\\s+min-height: 0;\\s+overflow-y: auto;\\s+padding-inline: 0;[^}]*border-radius: var\\(--thread-card-r\\);[^}]*background: var\\(--thread-card\\);\\s+box-shadow: var\\(--thread-card-edge\\);`),
    'the discussion card scrolls between the other two');
  assert.match(css, new RegExp(`${escaped(scope)} > \\.messages-composer \\{\\s+flex: 0 0 auto;\\s+padding-inline: 0;`),
    'the reply card stays at the foot and stylable');
  assert.match(css, new RegExp(`${escaped(scope)} > \\.messages-composer > \\.messages-composer-card:focus-within \\{\\s+box-shadow: var\\(--thread-card-edge\\), 0 0 0 2px var\\(--accent\\);`),
    'the box keeps its focus ring on the card');
});

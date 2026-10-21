'use strict';

// #5680: your own messages on the right.
//
// A direct message and a group chat are conversations between a few people,
// so each message is drawn on its sender's side, in a bubble: yours on the
// right in the accent tint and without your face, everyone else's on the
// left in the plain surface with their avatar, name and time. Pinned here:
//
//   1. Which rows have a side (`sided`): a DM and a group do; a channel does
//      not (#2783), and neither does a row that is not something a person
//      said — the bot's cards and plans, its step lines, a platform notice,
//      a change block.
//   2. The markup: a sided row wears `messages-message-bubble` beside the id,
//      the `data-message-id` and the classes it already had, its own rows
//      carry no avatar, and the words sit in `.messages-bubble` inside
//      `.messages-bubble-wrap`, with the head and the extras outside it.
//   3. The stylesheet draws the sides: the row runs right to left for its
//      author, the wrap lines up at that edge, and the bubble wears the
//      accent tint and the saved outline.
//   4. The two declared checks on the demo DM and group assert the new
//      shape, by #5680's name.
//
// Run with: node --test tests/messages-bubble-sides.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ROW = read('frontend/src/features/messages/message-row.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));

const ME = { id: 7, username: 'me', avatarUrl: null };
const ADA = { id: 8, username: 'ada', avatarUrl: null };
const BOT = { id: 2, username: 'homeroom_bot', bot: true };

function message(sender, n, over = {}) {
  return {
    id: n, conversationId: 42, sender,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) + n * 60000).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [], deleted: false,
    ...over,
  };
}

// One window, the way the row's modules read it (./lib/render-tsx notes).
globalThis.window = {
  App: { user: ME },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

function row(props) {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  return renderToHtml(createElement(MessageRow, { conversationId: 42, ...props }));
}

// ── 1. Which rows have a side ─────────────────────────────────────────────

test('a DM and a group give their rows a side; a channel does not', () => {
  for (const kind of ['direct', 'group']) {
    const theirs = row({ message: message(ADA, 1, { content: 'Hello there' }), kind });
    assert.match(theirs, /class="messages-message group messages-message-bubble /, `${kind}: their row has a side`);
    assert.match(theirs, /<div class="min-w-0 flex-1 messages-bubble-wrap">/, `${kind}: the words are in the wrap`);
    assert.match(theirs, /<div class="messages-bubble">/, `${kind}: in a bubble`);
    assert.match(theirs, /Hello there/);
  }
  // #2783: a channel keeps its named rows, whatever the viewer's own.
  const channel = row({ message: message(ME, 2, { content: 'Morning all' }), kind: 'channel' });
  assert.doesNotMatch(channel, /messages-message-bubble/);
  assert.doesNotMatch(channel, /messages-bubble/);
  assert.match(channel, /class="min-w-0 flex-1"/, 'the plain content column, as before');
});

test('the row that is not something a person said keeps its full-width named row', () => {
  // A change block, a quiet step line, and a platform notice: none of them
  // is a message from a person in the conversation.
  const block = row({ message: message(BOT, 3), kind: 'direct', block: { key: 'todo-list#7', part: 'only', repeat: false } });
  assert.doesNotMatch(block, /messages-message-bubble/, 'a change block has no side');
  assert.match(block, /class="min-w-0 flex-1 messages-bot-block-body"/);

  const step = row({ message: message(BOT, 4, { metadata: { homeroomBot: { kind: 'step' } } }), kind: 'direct' });
  assert.doesNotMatch(step, /messages-message-bubble/, 'a step line has no side');

  const notice = row({ message: message(BOT, 5, { system: true }), kind: 'group' });
  assert.doesNotMatch(notice, /messages-message-bubble/, 'a platform notice has no side');

  // The bot's plain words in its own chat are something it said: a bubble
  // on the left, with its avatar — its cards are what stay full width.
  const bot = row({ message: message(BOT, 6, { content: 'How is it going?' }), kind: 'direct', botChat: true });
  assert.match(bot, /class="messages-message group messages-message-bubble /);
  assert.match(bot, /<div class="messages-bubble">/);
});

test('a grouped continuation keeps its side and its bubble, with the time in the gutter', () => {
  const html = row({ message: message(ME, 7, { content: 'Second thought' }), kind: 'direct', grouped: true });
  assert.match(html, /messages-message-bubble messages-message-grouped/);
  assert.match(html, /<time class="messages-message-gutter"/);
  assert.match(html, /<div class="messages-bubble">/);
});

// ── 2. The markup ─────────────────────────────────────────────────────────

test('your own message carries no avatar, and its head sits before its bubble', () => {
  const html = row({ message: message(ME, 8, { content: 'Looking now' }), kind: 'direct' });
  assert.match(html, /messages-message-self/);
  assert.doesNotMatch(html, /w-9 h-9/, 'no avatar on your own row');
  assert.match(html, /<div class="messages-message-head"><span class="messages-message-author text-violet-700[^"]*">me<\/span><time[\s\S]*?<\/time><\/div><div class="messages-bubble"><div class="messages-markdown gc-msg-content">Looking now<\/div><\/div>/);
});

test('the other person keeps the avatar, the name and the time above their bubble', () => {
  const html = row({ message: message(ADA, 9, { content: 'Thanks!' }), kind: 'direct' });
  assert.doesNotMatch(html, /messages-message-self/);
  assert.match(html, /<span aria-hidden="true" class="w-9 h-9/, 'the avatar, as before');
  assert.match(html, /<div class="messages-message-head"><span class="messages-message-author ">ada<\/span><time[\s\S]*?<\/time><\/div><div class="messages-bubble"><div class="messages-markdown gc-msg-content">Thanks!<\/div><\/div>/);
});

test('a deleted message keeps its bubble, and the id, data and classes the checks select on', () => {
  const html = row({ message: message(ADA, 10, { content: '', deleted: true }), kind: 'group' });
  assert.match(html, /<article id="messages-message-10" data-message-id="10" class="messages-message group messages-message-bubble /);
  assert.match(html, /<div class="messages-bubble"><p class="messages-deleted">/);
});

// ── 3. The stylesheet ─────────────────────────────────────────────────────

test('the stylesheet puts your bubble on the right and tints it', () => {
  assert.match(CSS, /\.messages-message-bubble \{\n  padding: 4px 16px;\n\}/);
  assert.match(CSS, /\.messages-message-bubble\.messages-message-self \{ flex-direction: row-reverse; \}/);
  assert.match(CSS, /\.messages-message-bubble > \.messages-bubble-wrap \{[^}]*align-items: flex-start;[\s\S]*?gap: 6px;/);
  assert.match(CSS, /\.messages-message-bubble\.messages-message-self > \.messages-bubble-wrap \{ align-items: flex-end; \}/);
  assert.match(CSS, /\.messages-message-self \.messages-message-head \{ justify-content: flex-end; \}/);
  assert.match(CSS, /\.messages-message-self \.messages-bubble \{ background: var\(--accent-tint\); \}/);
  assert.match(CSS, /\.messages-bubble \{[^}]*max-width: 78%;/);
  // A saved bubble reads as saved: the inset bar excludes bubble rows.
  assert.match(CSS, /\.messages-message-bubble\.messages-message-saved \.messages-bubble \{\n  box-shadow: inset 0 0 0 1\.5px var\(--accent\);/);
});

// ── 4. The declared checks ────────────────────────────────────────────────

test('the demo DM and group declare the new shape, by #5680', () => {
  const check = (route, needle) => DAPP.tests.find((entry) => entry.path === `/?demo=1#messages/${route}` && entry.name.includes(needle));
  const dm = check('910001', '#5680');
  assert.ok(dm, 'the DM check is rewritten, not dropped');
  assert.match(dm.name, /own message on the right in its tinted bubble/);
  // The wrap is the self row's first child: no avatar before it, then the
  // head and the bubble. (The selector engine both runners use does not
  // evaluate `:not(:has())`, and a selector longer than the manifest's
  // 256-character cap is silently truncated — so the shape is spelled this
  // way and no longer.)
  assert.match(dm.expectSelector, /\.messages-message-self>\.messages-bubble-wrap:first-child>\.messages-message-head\+\.messages-bubble$/);
  assert.match(dm.expectSelector, /:has\(\.messages-message-bubble:not\(\.messages-message-self\)>span\[aria-hidden\]\+\.messages-bubble-wrap>\.messages-bubble\)/);
  assert.ok(dm.expectSelector.length <= 256, `the selector fits the manifest's cap (${dm.expectSelector.length})`);

  const group = check('910002', '#5680');
  assert.ok(group, 'the group check is rewritten, not dropped');
  assert.match(group.name, /your own messages on the right and everyone else's on the left/);
  assert.match(group.expectSelector, /messages-thread-group:has\(\.messages-message-bubble\.messages-message-self \.messages-bubble\)/);
  assert.match(group.expectSelector, /\.messages-message-bubble:not\(\.messages-message-self\) > \.messages-bubble-wrap > \.messages-message-head time$/);
  assert.ok(group.expectSelector.length <= 256, `the selector fits the manifest's cap (${group.expectSelector.length})`);

  // And the old named-row promise is gone from both.
  for (const entry of DAPP.tests) {
    if (entry.path === '/?demo=1#messages/910001' || entry.path === '/?demo=1#messages/910002') {
      assert.doesNotMatch(entry.name, /no bubble|named-row transcript/, entry.name);
      assert.doesNotMatch(String(entry.expectSelector || ''), /:not\(:has\(\.messages-bubble\)\)/, entry.name);
    }
  }
});

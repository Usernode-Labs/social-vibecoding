'use strict';

// The change a Homeroom bot message is about.
//
// (This suite was messages-bot-change-blocks: #4564 drew everything the bot
// said about one change, in its chat's own stream, as one outlined block.
// That stream is drawn on no screen since every conversation with the bot
// became a thread, 14 Nov 2026, and the blocks went with it.) What is left,
// and pinned here:
//
//   1. The change a bot message is about (`changeKey`): the request its
//      metadata already names, never the words. The plan layout orders a
//      first version's plans by it.
//   2. The drawing: a bot row about a request draws that request's card at
//      its head, with no outline around it, and a ready card names its
//      request for a chip to find.
//
// Run with: node --test tests/messages-bot-change-key.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOT = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
const ADA = { id: 7, username: 'ada' };
const SLUG = 'todo-list';
const MINUTE = 60 * 1000;

/** A message by `sender`, numbered in order, minutes apart so they group. */
function message(sender, n, over = {}) {
  return {
    id: n, conversationId: 42, sender,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) + n * MINUTE).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [], deleted: false,
    ...over,
  };
}

/** The bot's message about request #n of the demo project. */
function botMessage(n, over = {}) {
  return message(BOT, n, {
    metadata: { homeroomBot: { kind: 'build_done', appSlug: SLUG, appName: 'Todo List', issueNumber: 7 } },
    content: '**Todo List** · request #7\n\nYour change is going live now.',
    ...over,
  });
}

// ── 1. The change a message is about ─────────────────────────────────────

test('a bot message names its request as app#number; anything else has none', () => {
  const { changeKey } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const bySlug = botMessage(1);
  assert.equal(changeKey(bySlug), 'todo-list#7');
  // No slug, the app's name says which project: an older message.
  assert.equal(changeKey(botMessage(2, { metadata: { homeroomBot: { kind: 'build_done', appName: 'Todo List', issueNumber: 7 } } })), 'Todo List#7');
  // A first version is request 1 under its own project, so it groups by project.
  assert.equal(changeKey(botMessage(3, { metadata: { homeroomBot: { kind: 'build_done', appSlug: SLUG, issueNumber: 1 } } })), 'todo-list#1');
  assert.equal(changeKey(message(ADA, 4)), null, 'a person’s message is about no change');
  assert.equal(changeKey(message(BOT, 5, { deleted: true })), null, 'a deleted one neither');
  assert.equal(changeKey(botMessage(6, { id: 0 })), null, 'nor one still sending');
  assert.equal(changeKey(botMessage(7, { metadata: { homeroomBot: { kind: 'hello', appSlug: SLUG } } })), null,
    'bot words about no request are about no change');
});

test('the plan layout reads the change by the same key', () => {
  const source = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(source, /import \{ changeKey \} from '\.\/bot-shared';/);
  assert.doesNotMatch(source, /function requestKey/, 'no reading of the request of its own');
  // The blocks that read it too are gone, with the stream they outlined.
  const shared = read('frontend/src/features/messages/bot-shared.ts');
  assert.doesNotMatch(shared, /changeBlocks|ChangeBlock/);
});

// ── 2. The drawing ────────────────────────────────────────────────────────

// One window, the way the row's modules read it (./lib/render-tsx notes).
globalThis.window = {
  App: { user: ADA },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const MERGED_META = { kind: 'merged', appSlug: SLUG, appName: 'Todo List', issueNumber: 7, sessionId: 41 };
const REQUEST_LINE = `**Todo List** · request #7: Sort the list`;
const MERGED_WORDS = 'Your change is going live now and will be ready in a few minutes.';
const CHANGE_CARD = { type: 'proposal', available: true, appSlug: SLUG, sessionId: 41, title: 'Sort the list', state: 'live' };

function mergedRow(over = {}) {
  return message(BOT, 11, {
    metadata: { homeroomBot: MERGED_META },
    content: `${REQUEST_LINE}\n\n${MERGED_WORDS}`,
    objects: [CHANGE_CARD],
    ...over,
  });
}

test('a bot row about a request draws the request’s card at its head, and no outline', () => {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const html = renderToHtml(createElement(MessageRow, { message: mergedRow(), conversationId: 42, grouped: true }));
  assert.match(html, /class="messages-message group messages-message-grouped /);
  assert.match(html, /class="min-w-0 flex-1"/);
  assert.match(html, /data-bot-head-card="request"/, 'the request’s card');
  assert.match(html, /messages-object-list/, 'and the change’s own card under the words');
  assert.match(html, /going live now/);
  assert.doesNotMatch(html, /messages-bot-block|data-bot-block/);
  assert.doesNotMatch(html, /sr-only">Request #7/);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.doesNotMatch(row, /block = null|block\?\.|blockClass|dropHead|spokenLabel/, 'the row takes no block');
  assert.doesNotMatch(read('public/css/app.css'), /messages-bot-block/);
});

test('a ready card names its request for a chip to find', () => {
  const { ReadyCardView } = loadTsx('frontend/src/features/messages/bot-ready.tsx');
  const meta = { kind: 'proposal', appSlug: SLUG, appName: 'Todo List', issueNumber: 7, ready: {} };
  const html = renderToHtml(createElement(ReadyCardView, {
    meta, state: 'open',
    actions: [{ id: 1, type: 'preview', label: 'Try it', sessionId: 41 }],
    now: new Date(Date.UTC(2026, 9, 9, 12, 0)),
  }));
  assert.match(html, /data-bot-ready-request="todo-list#7"/);
  assert.match(html, /data-bot-ready="open"/);
  // A card that names no request (a first version's) carries no key.
  const first = renderToHtml(createElement(ReadyCardView, {
    meta: { ...meta, issueNumber: 1, firstVersion: true }, state: 'open',
    actions: [{ id: 2, type: 'preview', label: 'Try it', sessionId: 41 }],
    now: new Date(Date.UTC(2026, 9, 9, 12, 0)),
  }));
  assert.doesNotMatch(first, /data-bot-ready-request/);
});

test('a chip finds the ready card that names its request, like an activity card', () => {
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  const { findRequestCard } = loadTsx('frontend/src/features/messages/ref-cards.tsx');
  // A transcript in document order, just big enough for findRequestCard:
  // the same shim tests/messages-ref-chip-cards.test.js reads it with.
  const doc = {};
  const els = [];
  doc.querySelectorAll = () => els.filter((el) => el.card);
  for (const [i, spec] of [
    { id: 'ready', card: 'ready', attrs: { 'data-bot-ready-request': 'todo-list#7' } },
    { id: 'chip' },
  ].entries()) {
    els.push({
      ...spec,
      order: i,
      ownerDocument: doc,
      getAttribute: (name) => (spec.attrs || {})[name] ?? null,
      matches: (sel) => sel === 'a.messages-object-card' && spec.card === 'object',
      closest: (sel) => (sel === '.messages-thread-scroll' ? doc : null),
      compareDocumentPosition: (other) => (other.order > i ? 4 : 2),
    });
  }
  assert.equal(findRequestCard(els[1], SLUG, 7).id, 'ready');
  assert.equal(findRequestCard(els[1], SLUG, 8), null);
});

'use strict';

// A reply in a DM reads as one iMessage-style bubble: the quoted message
// tucks inside the reply's own bubble — a small name line and a one-line
// snippet under it — instead of hanging above it as a separate block
// (#3742). Every other conversation keeps the quote block above the row.
//
// Run with: node --test tests/messages-dm-reply-bubble.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
const ROW = 'frontend/src/features/messages/message-row.tsx';

const user = (id, username) => ({ id, username });
const message = (over = {}) => ({
  id: 7, conversationId: 3,
  sender: user(11, 'ana'),
  content: 'Here is the answer.',
  createdAt: '2026-10-03T10:00:00.000Z',
  reply: null,
  reactions: [], attachments: [], objects: [],
  ...over,
});
const replied = message({
  reply: { id: 5, sender: user(12, 'bo'), content: 'What is the answer?' },
});
const row = (msg, props = {}) => renderComponent(ROW, 'MessageRow', { message: msg, conversationId: 3, ...props });

test('a DM reply draws one bubble with the quote tucked inside it', () => {
  const html = row(replied, { kind: 'direct' });
  const bubbleAt = html.indexOf('class="messages-reply-bubble');
  assert.ok(bubbleAt >= 0, 'the reply is drawn in a bubble');
  const quoteAt = html.indexOf('class="messages-quote"', bubbleAt);
  const textAt = html.indexOf('gc-msg-content', bubbleAt);
  assert.ok(quoteAt > bubbleAt, 'the quote sits inside the bubble');
  assert.ok(textAt > quoteAt, 'the reply\'s own text follows the quote in the same bubble');
  assert.match(html.slice(quoteAt, textAt), /@bo/, 'the snippet names its sender');
  assert.match(html.slice(quoteAt, textAt), /What is the answer\?/, 'the snippet carries the original\'s words');
});

test('a DM message that is not a reply keeps today\'s look', () => {
  assert.ok(!row(message(), { kind: 'direct' }).includes('messages-reply-bubble'));
});

test('a group reply keeps the quote block, with no bubble', () => {
  const html = row(replied, { kind: 'group' });
  assert.ok(!html.includes('messages-reply-bubble'));
  assert.ok(html.includes('class="messages-quote"'), 'the quote still draws above the row');
});

test('a deleted DM reply draws no bubble', () => {
  const html = row(message({ deleted: true, reply: replied.reply }), { kind: 'direct' });
  assert.ok(!html.includes('messages-reply-bubble'));
});

/** The declarations of the FIRST top-level rule for exactly `selector`. */
function rule(selector) {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('\n}', at));
}

test('the reply bubble uses the measures and surfaces the old DM bubbles had', () => {
  const bubble = rule('.messages-reply-bubble');
  assert.match(bubble, /max-width: 78%;/);
  assert.match(bubble, /min-width: 0;/);
  assert.match(bubble, /border-radius: 20px;/);
  assert.match(bubble, /padding: 10px 16px;/);
  assert.match(bubble, /background: var\(--messages-surface\);/);
  assert.match(rule('.messages-message-self .messages-reply-bubble'), /background: var\(--accent-tint\);/);
});

test('the snippet inside the bubble keeps the quote\'s shape, scaled to the bubble', () => {
  assert.match(rule('.messages-reply-bubble .messages-quote span'), /font-size: 13px;/);
  assert.match(
    rule('.messages-message-self .messages-reply-bubble .messages-quote span'),
    /color: var\(--accent-tint-ink\);/,
    'the accent name stays legible on the accent tint',
  );
});

test('the composer\'s staged-reply chip is untouched', () => {
  const sharedAt = CSS.indexOf('.messages-quote,\n.messages-reply-draft {');
  // The draft's OWN rule sits below the shared block it appears inside.
  const sharedEnd = CSS.indexOf('\n}', sharedAt);
  assert.ok(sharedAt >= 0, 'the quote and the staged chip still share one rule');
  const draftAt = CSS.indexOf('\n.messages-reply-draft {', sharedEnd);
  assert.ok(draftAt >= 0, 'the staged chip keeps its own rule');
  const draft = CSS.slice(draftAt, CSS.indexOf('\n}', draftAt));
  assert.match(draft, /border-radius: 0 12px 12px 0;/);
  assert.match(draft, /padding: 6px 10px;/);
  assert.match(draft, /background: var\(--accent-tint\);/);
});

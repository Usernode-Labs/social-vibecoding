'use strict';

// #1953: clicking the blank area of the conversation list (below the last
// row) closes the open conversation. Only a click on the list container itself
// counts, so rows, the empty state and the retry button are unaffected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');

test('the list container closes the open conversation on a click on itself', () => {
  const at = SCREEN.indexOf('className="messages-list-scroll platform-safe-scroll"');
  assert.ok(at > 0, 'the list keeps its literal className');
  const tag = SCREEN.slice(SCREEN.lastIndexOf('<div', at), SCREEN.indexOf('>\n', at));
  assert.match(tag, /onClick=\{\(e\) => \{/);
  assert.match(tag, /e\.target === e\.currentTarget/, 'only the blank space, never a row');
  assert.match(tag, /snap\.route\.conversationId\) openConversation\(null\)/, 'only when one is open');
});

test('closing goes through the store\'s own navigation', () => {
  assert.match(SCREEN, /open as openConversation,/);
  // open(null) routes to the bare #messages hash — the two-pane layout then
  // shows "Choose a conversation".
  assert.match(STORE, /export function open\(conversationId\?: number \| null\): void \{[\s\S]*?: '#messages';/);
  assert.match(SCREEN, /<h2>Choose a conversation<\/h2>/);
});

'use strict';

// #3757 — the conversation thread follows a new message when the reader was
// at the bottom BEFORE it landed.
//
// Run with: node --test tests/messages-thread-follow.test.js
//
// The bug was not a missing follow; it was a follow decided too late.
// ConversationThread's effect measured `scrollHeight - scrollTop - clientHeight`
// AFTER React had committed the new row, so a reader parked at distance 0 read
// as distance = the new row's height, and any reply taller than the threshold
// was treated as "the reader scrolled away". The fix records was-at-bottom on
// the scroller's scroll event — which never fires on DOM growth — and the
// effect reads that ref. This file holds both halves: the executed decision,
// and the source contract that the post-commit measurement cannot return.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const screen = read('frontend/src/features/messages/index.tsx');
const agentSession = read('frontend/src/features/agent-session/index.tsx');
const globalChat = read('frontend/src/features/global-chat/index.tsx');

let mod = null;
const messages = () => (mod || (mod = loadTsx('frontend/src/features/messages/index.tsx')));

// ConversationThread's follow effect, the block that decides. Sliced so the
// assertions read only this decision, not the other scrollers in the file
// (the reply-thread pane and the app discussion follow by their own rules).
const followEffect = screen.slice(
  screen.indexOf('// The viewer\'s own send always lands in view'),
  screen.indexOf('previousLast.current = last;', screen.indexOf('// The viewer\'s own send always lands in view')),
);
assert.ok(followEffect.length > 0 && followEffect.length < 1200, 'the follow effect was found where the assertions look');

test('the follow decision follows a reader who was at the bottom, however tall the message', () => {
  const shouldFollowThread = messages().shouldFollowThread;
  assert.equal(typeof shouldFollowThread, 'function',
    'the decision is exported so it can be executed, not only grepped');
  // A freshly opened conversation opens at the bottom.
  assert.equal(shouldFollowThread({ firstLoad: true, ownSend: false, wasAtBottom: false }), true);
  // The viewer's own send always lands in view, wherever they had scrolled.
  assert.equal(shouldFollowThread({ firstLoad: false, ownSend: true, wasAtBottom: false }), true);
  // The tall reply — the case this file exists for: the reader was at the
  // bottom before the message landed. The old post-commit scrollHeight
  // measurement answered "no" for any message taller than the threshold;
  // the pre-update ref answers the question the viewer actually asked.
  assert.equal(shouldFollowThread({ firstLoad: false, ownSend: false, wasAtBottom: true }), true);
  // A reader who scrolled up is not yanked down.
  assert.equal(shouldFollowThread({ firstLoad: false, ownSend: false, wasAtBottom: false }), false);
});

test('the 180 measurement lives in the scroller\'s onScroll handler, writing the ref', () => {
  // The handler writes the pre-update answer on every scroll event, with the
  // threshold the thread already used.
  assert.match(screen, /const atBottom = useRef\(false\);/);
  assert.match(screen, /const onScroll = \(\) => \{\s*\n\s*const el = scroller\.current;\s*\n\s*if \(el\) atBottom\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 180;/,
    'was-at-bottom is measured on scroll, before the next message exists in the DOM');
  // The thread's own scroller carries the handler. The class string is the
  // one the safe-area test pins, so this names ConversationThread's scroller
  // and not another in the file.
  assert.match(screen, /className="messages-thread-scroll platform-safe-scroll" aria-live="polite" onScroll=\{onScroll\}/);
});

test('the follow condition reads the ref, and no longer measures after the commit', () => {
  // The effect hands the decision the ref's answer…
  assert.match(followEffect, /wasAtBottom: atBottom\.current/);
  // …and no distance measurement is left in it: the effect's only remaining
  // scroll writes are the follow itself. `clientHeight` is what every
  // distance-from-bottom measurement here needs, so its absence is the exact
  // line that read "scrolled away" for a tall reply parked at the bottom,
  // gone. (Other scrollers in the file may still measure — only this
  // effect's decision had the flaw.)
  assert.doesNotMatch(followEffect, /clientHeight/,
    'the effect decides from the pre-update answer, not a measurement that already contains the new message');
});

test('the ref is armed true when a conversation opens, so the first follow is not blocked', () => {
  // The [conversationId] reset effect, with the two refs it already cleared.
  assert.match(screen, /previousLast\.current = null; initialScroll\.current = null;\s*\n\s*\/\/ A fresh conversation opens at the bottom[\s\S]*?atBottom\.current = true;/,
    'a stale "scrolled away" from the previous thread must not block the fresh one');
});

test('the surfaces that do not share the flaw stay as they are', () => {
  // The agent-session transcript records was-at-bottom on scroll and follows
  // only when its `stick` is true — the pattern this fix brought the thread
  // to. It predates this change and must survive it untouched.
  assert.match(agentSession, /stick\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 80;/,
    'the agent session transcript keeps its own pre-update stick');
  assert.match(agentSession, /if \(stick\.current\) el\.scrollTop = el\.scrollHeight;/,
    'the agent session transcript keeps its ref-conditional follow');
  // Global chat and the reply-thread panes follow every new message
  // unconditionally, so they never miss one; out of scope, and unchanged.
  assert.match(globalChat, /scroll\.current\.scrollTop = scroll\.current\.scrollHeight;/,
    'the global chat pane keeps its unconditional follow');
  assert.match(screen, /if \(el && n !== count\.current\) requestAnimationFrame\(\(\) => \{ el\.scrollTop = el\.scrollHeight; \}\);/,
    'the reply-thread pane keeps its unconditional follow');
});

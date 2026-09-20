'use strict';

// #2498: "No messages yet. Start the thread." stayed on screen after you
// sent the first message, until the page was reloaded.
//
// `renderThread` (public/js/group-chat.js) publishes that line as the
// transcript's `lead.placeholder` while `st.messages` is empty. The live
// path is different: `_handleThreadIncoming` pushes to the model and calls
// `appendTranscriptMessage`, which is a deliberate single-row append rather
// than a re-publish — that is what keeps an incoming message from rebuilding
// the transcript under the reader's scroll position (#2389).
//
// But its updater spread `...view` and replaced only `messages`, so `lead`
// came through untouched. The placeholder therefore outlived the emptiness
// it described, sitting above the message that disproved it, and nothing on
// that path ever re-published the view — so it survived until the next
// mount.
//
// The invariant belongs in the append itself: a transcript with a message in
// it has no empty state.
//
// Run with: node --test tests/transcript-placeholder-clears.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MOUNT = read('frontend/src/features/group-chat/mount.ts');
const GC = read('public/js/group-chat.js');

/** The body of `appendTranscriptMessage`. */
function appendBody() {
  const at = MOUNT.indexOf('export function appendTranscriptMessage');
  assert.notEqual(at, -1, 'the single-row append should still exist');
  const next = MOUNT.indexOf('\nexport ', at + 1);
  return MOUNT.slice(at, next === -1 ? MOUNT.length : next);
}

test('appending a message drops the empty-state line', () => {
  assert.match(appendBody(), /lead: view\.lead\.placeholder \?/,
    'the append must revisit lead, not carry it through');
  assert.match(appendBody(), /placeholder: null/);
});

test('it still appends rather than re-publishing', () => {
  const body = appendBody();
  // #2389's property: one row onto the existing array, not a rebuilt view.
  assert.match(body, /messages: \[\.\.\.view\.messages, message\]/);
  assert.match(body, /flushSync\(/, 'and still flushed, so the scroll measures the new row');
});

test('the untouched case allocates nothing new', () => {
  // `lead` is rebuilt only when there IS a placeholder to drop; the common
  // append — a live message into a thread that already had some — keeps the
  // same object, so nothing downstream sees a changed identity for a field
  // that did not change.
  assert.match(appendBody(), /: view\.lead,/);
});

test('the thread is the surface that publishes a placeholder at all', () => {
  // The general chat publishes `placeholder: null` unconditionally, which is
  // why this only ever showed on a thread — and why the fix is pinned to the
  // shared append rather than to the thread's own render.
  assert.match(GC, /placeholder: st\.loaded\s*\n\s*\? \(st\.messages\.length \|\| chat \? null : 'No messages yet\. Start the thread\.'\)/);
  assert.match(GC, /placeholder: null,/, 'the main transcript never had one');
});

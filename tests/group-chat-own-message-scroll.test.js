// #2389: in an app's general Discussion, the message you just sent landed
// under the fold. Two causes, both pinned here:
//   1. the live append was batched by React, so `scrollToBottom()` on the next
//      line measured the transcript without the new row;
//   2. your own message only scrolled when you were already at the bottom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function setup({ lockedToBottom }) {
  const appended = [];
  let scrolled = 0;
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    App: { user: { id: 7, username: 'evan' } },
    document: { getElementById: (id) => (id === 'gc-messages' ? {} : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._lockedToBottom = lockedToBottom;
  gc._messageView = (msg) => ({ id: msg.id });
  gc._react = () => ({ appendTranscriptMessage: (view) => appended.push(view.id) });
  gc.scrollToBottom = () => { scrolled += 1; };
  return { gc, appended, scrolled: () => scrolled };
}

const chat = (id, userId) => ({ type: 'chat', id, userId, content: 'hi' });

test('your own message scrolls the general chat to the bottom even when you had scrolled up', () => {
  const h = setup({ lockedToBottom: false });
  h.gc.handleIncoming(chat(1, 7));
  assert.deepEqual(h.appended, [1]);
  assert.equal(h.scrolled(), 1);
});

test('someone else\'s message does not yank a reader who has scrolled up', () => {
  const h = setup({ lockedToBottom: false });
  h.gc.handleIncoming(chat(2, 99));
  assert.deepEqual(h.appended, [2]);
  assert.equal(h.scrolled(), 0);
});

test('someone else\'s message still follows a reader who is at the bottom', () => {
  const h = setup({ lockedToBottom: true });
  h.gc.handleIncoming(chat(3, 99));
  assert.equal(h.scrolled(), 1);
});

test('the snake_case user_id form counts as your own message too', () => {
  const h = setup({ lockedToBottom: false });
  h.gc.handleIncoming({ type: 'chat', id: 4, user_id: 7, content: 'hi' });
  assert.equal(h.scrolled(), 1);
});

test('the live append is flushed synchronously, so the scroll measures the new row', () => {
  const src = read('frontend/src/features/group-chat/mount.ts');
  const fn = src.match(/export function appendTranscriptMessage\([\s\S]*?\n\}/);
  assert.ok(fn, 'appendTranscriptMessage');
  assert.match(fn[0], /flushSync\(\(\) => \{\s*transcriptStore\.set\(/);
  // Not the whole store: its patch path runs from inside a React effect.
  assert.doesNotMatch(src, /transcriptStore\.setFlush\(/);
});

// #4511: the same rule on a REQUEST's page. Its thread re-renders the whole
// stream (`renderThread`) instead of appending one row, and that call
// published batched — so the `scrollHeight` the branch measured on the next
// line did not include the row the flush had not yet committed, and a reply
// you had just sent sat under the fold.

// A scroller that behaves like the real one: you cannot scroll past the
// bottom, so `scrollTop = scroll.scrollHeight` only moves the view when the
// scrollHeight itself has grown (which here happens only on a flushed
// publish, mimicking the React commit the batched path defers).
function fakeScroller() {
  return {
    id: 'gc-thread-scroll',
    clientHeight: 400,
    scrollHeight: 1000,
    _top: 0,
    get scrollTop() { return Math.min(this._top, this.scrollHeight - this.clientHeight); },
    set scrollTop(v) {
      this._top = Math.max(0, Math.min(Number(v), this.scrollHeight - this.clientHeight));
    },
  };
}

function threadSetup({ atBottom }) {
  const scroll = fakeScroller();
  const list = { dataset: {} };
  const published = [];
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    App: { user: { id: 7, username: 'evan' } },
    document: {
      getElementById: (id) => (id === 'gc-thread-messages' ? list : id === 'gc-thread-scroll' ? scroll : null),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._messageView = (msg) => ({ id: msg.id });
  gc._react = () => ({
    mountTranscript: () => {},
    publishTranscript: (rows, key, lead, opts) => {
      published.push({ rows, opts });
      // The real store commits the rows synchronously only under `flush`;
      // a batched publish reaches the DOM later, after this handler measures.
      if (opts && opts.flush) scroll.scrollHeight += 50;
    },
  });
  gc.activeThread = { type: 'issue', ref: 4417, language: 'request' };
  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  else scroll.scrollTop = 100; // a reader part-way up the thread
  const before = scroll.scrollTop;
  return {
    gc, published, scroll,
    scrollTop: () => scroll.scrollTop,
    before,
    send: (msg) => gc._handleThreadIncoming({
      id: msg.id, userId: msg.userId, msgType: 'message', content: 'hi',
      thread: { type: 'issue', ref: 4417 },
    }),
  };
}

test('your own reply on an open request thread is published flushed and scrolls to the new bottom', () => {
  const h = threadSetup({ atBottom: true });
  h.send({ id: 903, userId: 7 });
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].opts.flush, true);
  // The scroll measured the row the flush committed: it landed at the new
  // bottom (scrollHeight minus the viewport), below where the reader was.
  assert.equal(h.scrollTop(), h.scroll.scrollHeight - h.scroll.clientHeight);
  assert.ok(h.scrollTop() > h.before);
});

test('someone else\'s request-thread message does not yank a reader who has scrolled up', () => {
  const h = threadSetup({ atBottom: false });
  h.send({ id: 904, userId: 99 });
  // The rows still reach the page (flushed, as every live row there now is),
  // but the view stays where the reader left it.
  assert.equal(h.published.length, 1);
  assert.equal(h.scrollTop(), h.before);
});

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

// #4511: on a request's page the live message re-renders the whole stream
// (`renderThread`) instead of appending one row, and that publish is batched
// unless `flush` is passed — so the `scrollHeight` measured on the next line
// was still the old height and the new message landed under the fold.
function setupRequest() {
  const renderOpts = [];
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    App: { user: { id: 7, username: 'evan' } },
    document: {
      getElementById: (id) => {
        if (id === 'gc-thread-messages') return { dataset: {} };
        if (id === 'gc-thread-scroll') return scroll;
        return null;
      },
    },
  };
  const scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._lockedToBottom = false;
  gc.activeThread = { type: 'issue', ref: 1, language: 'request' };
  // Stands in for the committed row: a flushed publish has the new row in
  // the DOM by the time renderThread returns, so the stream is taller.
  gc.renderThread = (opts) => {
    // A copy: `opts` was made inside the vm sandbox, whose Object.prototype
    // deepEqual in this realm treats as a different structure.
    renderOpts.push({ ...opts });
    scroll.scrollHeight += 500;
  };
  return { gc, scroll, renderOpts };
}

const threadChat = (id, userId) => ({
  type: 'chat', id, userId, content: 'hi', thread: { type: 'issue', ref: 1 },
});

test('on a request page your own message flushes the render and scrolls to it, even scrolled up', () => {
  const h = setupRequest();
  h.scroll.scrollTop = 0; // 500px above the bottom, and still yours
  h.gc.handleIncoming(threadChat(10, 7));
  assert.deepEqual(h.renderOpts, [{ keepScroll: true, flush: true }]);
  assert.equal(h.scroll.scrollTop, 1500);
});

test('on a request page someone else\'s message still follows a reader near the bottom', () => {
  const h = setupRequest();
  h.scroll.scrollTop = 480; // 20px from the bottom: within the stick threshold
  h.gc.handleIncoming(threadChat(11, 99));
  assert.deepEqual(h.renderOpts, [{ keepScroll: true, flush: true }]);
  assert.equal(h.scroll.scrollTop, 1500);
});

test('on a request page someone else\'s message does not yank a reader who has scrolled up', () => {
  const h = setupRequest();
  h.scroll.scrollTop = 0;
  h.gc.handleIncoming(threadChat(12, 99));
  assert.deepEqual(h.renderOpts, [{ keepScroll: true, flush: true }]);
  assert.equal(h.scroll.scrollTop, 0);
});

test('the live append is flushed synchronously, so the scroll measures the new row', () => {
  const src = read('frontend/src/features/group-chat/mount.ts');
  const fn = src.match(/export function appendTranscriptMessage\([\s\S]*?\n\}/);
  assert.ok(fn, 'appendTranscriptMessage');
  assert.match(fn[0], /flushSync\(\(\) => \{\s*transcriptStore\.set\(/);
  // Not the whole store: its patch path runs from inside a React effect.
  assert.doesNotMatch(src, /transcriptStore\.setFlush\(/);
});

// #4511 / #4513: an open thread (a request's or a change's page, a topic, a
// channel's reply thread) keeps a reader who is at its newest line there.
//
//   #4513: typing a second line grows the composer, which sits below the
//   scroller and takes its height. The general chat's ResizeObserver put its
//   own scroller back; a thread had none, so the bottom drifted under the
//   composer while you typed.
//   #4511: after you send, the thread follows you down when you were at or
//   near the bottom, including when the row is drawn after the socket frame
//   (a request page renders in a batch) or grows later. A reader up in the
//   history is never moved, by their own send either.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function fakeScroller({ scrollHeight, clientHeight, scrollTop }) {
  const listeners = {};
  const el = {
    id: 'gc-thread-scroll',
    scrollHeight, clientHeight, scrollTop,
    children: [{ id: 'gc-thread-head' }, { id: 'gc-thread-messages' }],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    // The reader scrolls: the browser moves scrollTop and fires `scroll`.
    scrollTo(top) { el.scrollTop = top; for (const fn of listeners.scroll || []) fn(); },
  };
  return el;
}

function setup(box) {
  const scroll = fakeScroller(box);
  const observers = [];
  class ResizeObserver {
    constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
  }
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' }, ResizeObserver,
    App: { user: { id: 7, username: 'evan' } },
    document: { getElementById: (id) => (id === 'gc-thread-scroll' ? scroll : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._attachThreadFollow(scroll);
  // The browser's resize: the scroller's box or a child changed size.
  const resize = () => { for (const o of observers) o.fn(); };
  return { gc, scroll, observers, resize };
}

test('the thread scroller and what it holds are watched for size, once', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 });
  assert.equal(h.observers.length, 1);
  assert.deepEqual(h.observers[0].targets.map((t) => t.id), ['gc-thread-scroll', 'gc-thread-head', 'gc-thread-messages']);
  h.gc._attachThreadFollow(h.scroll);
  assert.equal(h.observers.length, 1, 'a second mount on the same node binds nothing more');
});

test('#4513: at the bottom, the composer growing keeps the newest line in view', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  h.scroll.scrollTo(1400);
  assert.equal(h.gc._threadPinned, true);
  // A second line: the composer takes 24px from the scroller.
  h.scroll.clientHeight = 576;
  h.resize();
  assert.equal(h.scroll.scrollTop, 2000, 'back at the bottom');
  // And shrinking back after the send.
  h.scroll.clientHeight = 600;
  h.resize();
  assert.equal(h.scroll.scrollTop, 2000);
});

test('#4513: a reader up in the history is not moved by the composer', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  h.scroll.scrollTo(300);
  assert.equal(h.gc._threadPinned, false);
  h.scroll.clientHeight = 576;
  h.resize();
  assert.equal(h.scroll.scrollTop, 300);
});

test('#4513: a short thread that fit stays showing its newest line when the composer grows', () => {
  const h = setup({ scrollHeight: 500, clientHeight: 600, scrollTop: 0 });
  // Nobody scrolled it, so nothing set the flag; it fit with room to spare.
  h.resize();
  h.scroll.scrollHeight = 600;
  h.scroll.clientHeight = 560;
  h.resize();
  assert.equal(h.gc._threadPinned, true);
  assert.equal(h.scroll.scrollTop, 600);
});

test('near the bottom (within the thread\'s 80px) counts as at it', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  h.scroll.scrollTo(1330);
  assert.equal(h.gc._threadPinned, true);
  h.scroll.scrollTo(1300);
  assert.equal(h.gc._threadPinned, false);
});

test('#4511: a row drawn or grown after your send is followed while pinned', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  h.scroll.scrollTo(1400);
  // The send lands; the request page's batched render commits a moment later.
  h.scroll.scrollHeight = 2120;
  h.resize();
  assert.equal(h.scroll.scrollTop, 2120);
});

test('a topic opening at its card is not pulled down as its history loads', () => {
  const src = read('public/js/group-chat.js');
  assert.match(src, /scroll\.scrollTop = 0;\s*GroupChat\._threadPinned = false;/,
    '#363: the unified layout opens at the top, unpinned');
  assert.match(src, /GroupChat\._threadPinned = false;\s*GroupChat\._attachThreadFollow\(GroupChat\._threadScrollEl\(\)\);/,
    'every mount starts unpinned and attaches the follow');
});

// _handleThreadIncoming, driven with a mounted thread.
function incoming({ scrollTop, pinned, userId }) {
  const scroll = fakeScroller({ scrollHeight: 2000, clientHeight: 600, scrollTop });
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    App: { user: { id: 7, username: 'evan' } },
    document: { getElementById: (id) => (id === 'gc-thread-scroll' ? scroll : id === 'gc-thread-messages' ? {} : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.activeThread = { type: 'issue', ref: 5, language: 'flat' };
  gc._threadPinned = pinned;
  gc._messageView = (msg) => ({ id: msg.id });
  gc._react = () => ({ appendTranscriptMessage: () => { scroll.scrollHeight += 100; } });
  gc._handleThreadIncoming({ type: 'chat', id: 1, userId, content: 'hi', thread: { type: 'issue', ref: 5 } });
  return { gc, scroll };
}

test('#4511: your send follows you down from at or near the bottom', () => {
  const h = incoming({ scrollTop: 1350, pinned: false, userId: 7 });
  assert.equal(h.scroll.scrollTop, 2100);
  assert.equal(h.gc._threadPinned, true);
});

test('#4511: your send leaves a reader up in the history where they are', () => {
  const h = incoming({ scrollTop: 200, pinned: false, userId: 7 });
  assert.equal(h.scroll.scrollTop, 200);
  assert.equal(h.gc._threadPinned, false);
});

test('a pinned thread follows anyone\'s message', () => {
  const h = incoming({ scrollTop: 1400, pinned: true, userId: 99 });
  assert.equal(h.scroll.scrollTop, 2100);
});

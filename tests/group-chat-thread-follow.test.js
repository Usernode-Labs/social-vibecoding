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
  // Polish board #12: put at its top ONCE, as it mounts. The replies' first
  // page lands later, and sending the reader back up then was a second jump.
  assert.match(src, /if \(GroupChat\._threadPlaced\) return;\s*GroupChat\._threadPlaced = true;\s*scroll\.scrollTop = 0;/);
  assert.match(src, /GroupChat\._threadPlaced = false;\s*GroupChat\._threadPinned = false;\s*GroupChat\._attachThreadFollow/,
    'every mount is placed afresh');
});

test('polish board #12: a topic page still loading is not pinned to its bottom as its card paints', () => {
  const h = setup({ scrollHeight: 500, clientHeight: 600, scrollTop: 0 });
  const messages = { id: 'gc-thread-messages', dataset: { loaded: '' } };
  h.scroll.querySelector = (sel) => (sel === '#gc-thread-messages' ? messages : null);
  h.resize();
  // The composer takes height while the page still fits, then the card paints.
  h.scroll.clientHeight = 560;
  h.resize();
  assert.equal(h.gc._threadPinned, false, 'not pinned while its history is on its way');
  h.scroll.scrollHeight = 900;
  h.resize();
  assert.equal(h.scroll.scrollTop, 0, 'the reader stays at the card');
  // Once its history is in, a page that fits is followed as before (#4513).
  messages.dataset.loaded = '1';
  h.scroll.scrollHeight = 500;
  h.scroll.clientHeight = 600;
  h.resize();
  h.scroll.clientHeight = 560;
  h.resize();
  assert.equal(h.gc._threadPinned, true);
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

// #6022: opening a long message ("Show more", features/group-chat/long-body.tsx)
// grows the row below the reader's line. A pinned follow would answer that
// with a jump to the new bottom, past the text just revealed.
test('#6022: opening a long message near the bottom keeps the reader where they are', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  const row = { id: 'long-body' };
  h.scroll.contains = (el) => el === row;
  h.scroll.scrollTo(1400);
  assert.equal(h.gc._threadPinned, true, 'the reader is at the newest line');
  // The body asks for the hold, then opens: 2000px of text appears under it.
  h.gc.holdReadingPosition(row);
  h.scroll.scrollHeight = 4000;
  h.resize();
  assert.equal(h.scroll.scrollTop, 1400, 'the pressed message stays put; the reader is not sent to the bottom');
  assert.equal(h.gc._threadPinned, false);
  // Scrolling to the new bottom follows again, as any scroll there does.
  h.scroll.scrollTo(3400);
  assert.equal(h.gc._threadPinned, true);
  h.scroll.scrollHeight = 4100;
  h.resize();
  assert.equal(h.scroll.scrollTop, 4100);
});

test('#6022: without the hold the same growth jumps to the bottom (the bug), and another scroller\'s row holds nothing', () => {
  const h = setup({ scrollHeight: 2000, clientHeight: 600, scrollTop: 0 });
  h.scroll.contains = () => false;
  h.scroll.scrollTo(1400);
  h.gc.holdReadingPosition({ id: 'a row in another pane' });
  assert.equal(h.gc._threadPinned, true, 'a row this scroller does not hold leaves its follow alone');
  h.scroll.scrollHeight = 4000;
  h.resize();
  assert.equal(h.scroll.scrollTop, 4000);
});

'use strict';

// A bell row that names ONE message of an app's discussion — a mention, a
// reply, a reaction, a saved message — opens the discussion ON that message
// (the prototype's `hl`), rather than at the newest with the message somewhere
// above. Notifications._openAppDiscussion asks GroupChat.revealMessage; the
// first history load of that app, a remount of one already loaded, or the call
// itself when that discussion is the one open in Messages brings the row to
// the middle of the stream and flashes it — the highlight a quote's
// jump-to-original already lands on.
//
// The REAL public/js/group-chat.js runs in a vm over a stand-in stream whose
// rows move as it scrolls.
//
// Run with: node --test tests/group-chat-reveal-message.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SRC = read('public/js/group-chat.js');

// The stream is 600px tall at y=100; a row's box follows the scroll offset.
function setup({ pane = null } = {}) {
  const patches = [];
  const frames = [];
  const timers = [];
  const rows = new Map();
  const container = {
    scrollTop: 2400,
    getBoundingClientRect: () => ({ top: 100, height: 600, bottom: 700 }),
    querySelector(sel) {
      const m = /data-msg-id="(\d+)"/.exec(sel);
      return m ? rows.get(Number(m[1])) || null : null;
    },
    closest: (sel) => (sel === '[data-discussion-app]' ? pane : null),
  };
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' }, Date, Number,
    App: { user: { id: 7, username: 'evan' } },
    document: { getElementById: (id) => (id === 'gc-messages' ? container : null) },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const gc = sandbox.window.GroupChat;
  gc._react = () => ({ patchTranscriptMessage: (id, patch) => patches.push([id, patch.flash]) });
  return {
    gc, container, patches, frames, timers,
    // A row `offset` px down the transcript, 40px tall.
    row(id, offset) {
      rows.set(id, { getBoundingClientRect: () => ({ top: 100 + offset - container.scrollTop, height: 40 }) });
    },
    loaded(ids) { gc.messages = ids.map((id) => ({ id })); },
    mounted(slug) { gc.appSlug = slug; gc._didInitialScroll = true; },
    center(id) {
      const box = rows.get(id).getBoundingClientRect();
      return box.top + box.height / 2;
    },
  };
}

test('the discussion opens on the named message once its history has loaded', () => {
  const h = setup();
  h.gc.revealMessage('garden-ab12', 5552);
  assert.deepEqual(h.patches, [], 'nothing mounted yet: the request waits');
  // The first history load of that app lands, scrolled to the newest…
  h.mounted('garden-ab12');
  h.loaded([5550, 5552, 5553]);
  h.row(5552, 1400);
  h.gc._lockedToBottom = true;
  assert.equal(h.gc._applyPendingReveal(), true);
  // …and the message is brought to the middle of the stream, and flashed.
  assert.equal(h.center(5552), 400, 'centred in the 600px stream at y=100');
  assert.equal(h.gc._lockedToBottom, false,
    'unlocked from the bottom, or the ResizeObserver pins it straight back');
  assert.equal(h.gc._savedScrollTop, h.container.scrollTop, 'and a remount restores this position');
  assert.deepEqual(h.patches, [[5552, true]]);
  const off = h.timers.find(([, ms]) => ms === 1500);
  assert.ok(off, 'the flash is the jump-to-original\'s 1.5s');
  off[0]();
  assert.deepEqual(h.patches, [[5552, true], [5552, false]]);
  assert.equal(h.gc._pendingReveal, null, 'and the request is spent');
});

test('with that discussion already open in Messages, it happens at once', () => {
  const h = setup({ pane: { getAttribute: (n) => (n === 'data-discussion-app' ? 'garden-ab12' : null) } });
  h.mounted('garden-ab12');
  h.loaded([5540]);
  h.row(5540, 900);
  h.gc.revealMessage('garden-ab12', 5540);
  assert.equal(h.center(5540), 400);
  assert.deepEqual(h.patches, [[5540, true]]);
});

test('a stream anywhere else waits for the Messages mount the click moves to', () => {
  // The old full-screen chat of the same app is not where the reader is going.
  const h = setup({ pane: null });
  h.mounted('garden-ab12');
  h.loaded([5540]);
  h.row(5540, 900);
  const before = h.container.scrollTop;
  h.gc.revealMessage('garden-ab12', 5540);
  assert.equal(h.container.scrollTop, before);
  assert.ok(h.gc._pendingReveal, 'kept for the mount it lands on');
  // …and another app's stream never takes it.
  h.mounted('other-app');
  assert.equal(h.gc._applyPendingReveal(), false);
  assert.ok(h.gc._pendingReveal);
});

test('the rows land a frame after the transcript is published: it waits for them', () => {
  // publishTranscript is batched (features/group-chat/mount.ts), so the first
  // load's render() returns before its rows exist.
  const h = setup();
  h.gc.revealMessage('garden-ab12', 5552);
  h.mounted('garden-ab12');
  h.loaded([5550, 5552]);
  assert.equal(h.gc._applyPendingReveal(), false);
  assert.equal(h.frames.length, 1, 'asks again next frame');
  h.row(5552, 1400);
  h.frames.shift()();
  assert.equal(h.center(5552), 400);
  assert.deepEqual(h.patches, [[5552, true]]);
});

test('a message older than the loaded page is not coming: the stream stays at the newest', () => {
  const h = setup();
  h.gc.revealMessage('garden-ab12', 1234);
  h.mounted('garden-ab12');
  h.loaded([5550, 5552]);
  const before = h.container.scrollTop;
  assert.equal(h.gc._applyPendingReveal(), false);
  assert.equal(h.frames.length, 0, 'no waiting for a row that is not coming');
  assert.equal(h.container.scrollTop, before);
  assert.deepEqual(h.patches, []);
  assert.equal(h.gc._pendingReveal, null);
});

test('a request lapses, so a discussion opened much later is not moved by it', () => {
  const h = setup();
  h.gc.revealMessage('garden-ab12', 5552);
  h.gc._pendingReveal.at -= h.gc.REVEAL_TTL_MS + 1;
  h.mounted('garden-ab12');
  h.loaded([5552]);
  h.row(5552, 1400);
  assert.equal(h.gc._applyPendingReveal(), false);
  assert.equal(h.gc._pendingReveal, null);
  assert.deepEqual(h.patches, []);
});

test('nonsense is refused at the door', () => {
  const h = setup();
  for (const [slug, id] of [[null, 5], ['garden-ab12', 0], ['garden-ab12', 'x'], ['garden-ab12', -3]]) {
    h.gc.revealMessage(slug, id);
    assert.equal(h.gc._pendingReveal, null, `${slug} ${id}`);
  }
});

test('both ways a discussion comes on screen apply it', () => {
  // The first history load, straight after its initial scroll to the newest…
  const load = SRC.slice(SRC.indexOf('  async loadHistory() {'));
  assert.match(load, /GroupChat\.scrollToBottom\(\);\s*GroupChat\._didInitialScroll = true;\s*GroupChat\._applyPendingReveal\(\);/);
  // …and the remount of an app whose socket is still live.
  const mount = SRC.slice(SRC.indexOf('  mount(appSlug, app) {'));
  assert.match(mount, /GroupChat\.restoreScroll\(\);\s*GroupChat\._applyPendingReveal\(\);\s*return;/);
});

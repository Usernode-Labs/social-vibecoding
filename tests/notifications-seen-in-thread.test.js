'use strict';

// #6441: SEEN IN THE THREAD COUNTS AS READ.
//
// A reply or a mention used to leave Unread only when its dotted message was
// clicked. With a thread open and the message on screen, nothing marked it
// read, so the bell kept a count of news the person was looking at. Pinned
// here:
//   1. The transcript draws the dot's own hook on a row that carries it
//      (`data-gc-unread`, read back by the observer), and on no other row.
//   2. The observer itself — taken from the shipped source and run against a
//      stubbed IntersectionObserver and document — reads a row that is
//      mostly on screen while the tab is in front, reads nothing for a row
//      scrolled past out of view, nothing while the tab is hidden, and
//      catches up when a hidden tab comes back.
//   3. GroupChat.reconcileDotsFromNotifications dots every kind a message
//      rings with, thread replies included, so a reply that arrives while
//      the thread is open is dotted and then read by (2).
//
// Run with: node --test tests/notifications-seen-in-thread.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const TRANSCRIPT_SRC = read(TRANSCRIPT);
const GROUP_CHAT_SRC = read('public/js/group-chat.js');

// ── 1. The row carries the observer's hook ──────────────────────────────

const base = {
  kind: 'message', username: 'alice', time: '09:05 AM', timeTitle: 'Sep 16, 2026, 09:05 AM',
  bodyHtml: '<p>hi</p>', systemText: '', mine: false, editedTitle: null, unread: false,
  bookmarked: false, canEdit: false, flash: false, showEdit: false, showBookmark: false,
  showReact: false, quote: null, reactions: [], attachments: [], voteRowClass: '',
  voteRef: null, specShare: null, event: null, eventHref: null, senderId: 3,
};
const row = (id, over = {}) => ({ ...base, id, bodyHtml: `<p>m${id}</p>`, ...over });
const renderRows = (view) => renderToHtml(createElement(loadTsx(TRANSCRIPT).TranscriptRows, { view, source: 'thread' }));

test('a dotted message row carries the marker the observer reads, and only it', () => {
  const html = renderRows({
    messages: [row(10), row(11, { unread: true }), row(12)],
    lead: { earlier: false, placeholder: null, unread: null },
  });
  assert.match(html, /data-msg-id="11" data-gc-unread=""/, 'the dotted row is marked');
  assert.doesNotMatch(html, /data-msg-id="10" data-gc-unread/);
  assert.doesNotMatch(html, /data-msg-id="12" data-gc-unread/);
  assert.equal((html.match(/data-gc-unread/g) || []).length, 1);
});

// ── 2. The observer, run from its shipped source ────────────────────────

const EFFECT = (() => {
  const m = TRANSCRIPT_SRC.match(
    /useEffect\(\(\) => \{\s*if \(typeof document === 'undefined' \|\| typeof IntersectionObserver !== 'function'\) return undefined;([\s\S]*?)\n {2}\}, \[view\.messages\]\);/
  );
  assert.ok(m, 'the transcript observes the rows it drew');
  // The source is TypeScript; these are the effect's only annotations.
  return m[1]
    .replace(/new Set<number>\(\)/g, 'new Set()')
    .replace(/new Set<Element>\(\)/g, 'new Set()')
    .replace(/\(el: Element\)/g, '(el)');
})();

function harness({ nodes, visibility = 'visible' }) {
  const reads = [];
  const listeners = new Map();
  const observed = [];
  let io = null;
  class StubObserver {
    constructor(callback, options) { io = this; this.callback = callback; this.threshold = options && options.threshold; }
    observe(el) { observed.push(el); }
    unobserve(el) { const at = observed.indexOf(el); if (at >= 0) observed.splice(at, 1); }
    disconnect() { observed.length = 0; }
  }
  const document = {
    visibilityState: visibility,
    querySelectorAll: () => nodes,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const run = new Function('document', 'IntersectionObserver', 'controller', `return (() => {${EFFECT}})();`);
  const cleanup = run(document, StubObserver, () => ({ _clearMessageDot: (id) => reads.push(id) }));
  const el = (id) => ({ getAttribute: (name) => (name === 'data-msg-id' ? String(id) : null) });
  return {
    reads,
    el,
    observed,
    get threshold() { return io && io.threshold; },
    intersect(entries) { io.callback(entries); },
    hide() { document.visibilityState = 'hidden'; if (listeners.has('visibilitychange')) listeners.get('visibilitychange')(); },
    show() { document.visibilityState = 'visible'; if (listeners.has('visibilitychange')) listeners.get('visibilitychange')(); },
    cleanup,
  };
}

test('a message mostly on screen while the tab is in front is marked read, once', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const nodes = [
    { getAttribute: (n) => (n === 'data-msg-id' ? '11' : null) },
    { getAttribute: (n) => (n === 'data-msg-id' ? '12' : null) },
  ];
  const h = harness({ nodes });
  assert.equal(h.threshold, 0.6, 'most of the message, not any sliver of it');
  assert.deepEqual(h.observed, nodes, 'every dotted row is watched');
  h.intersect([
    { target: nodes[0], isIntersecting: true, intersectionRatio: 0.8 },
    { target: nodes[1], isIntersecting: true, intersectionRatio: 0.2 },
  ]);
  assert.deepEqual(h.reads, [11], 'only the one actually on screen');
  h.intersect([{ target: nodes[0], isIntersecting: true, intersectionRatio: 0.9 }]);
  assert.deepEqual(h.reads, [11], 'read once, never twice');
  h.cleanup();
});

test('a row scrolled past, or a tab in the background, reads nothing', () => {
  const off = { getAttribute: (n) => (n === 'data-msg-id' ? '21' : null) };
  const h = harness({ nodes: [off] });
  h.intersect([{ target: off, isIntersecting: false, intersectionRatio: 0 }]);
  assert.deepEqual(h.reads, [], 'out of view');

  const back = { getAttribute: (n) => (n === 'data-msg-id' ? '22' : null) };
  const hidden = harness({ nodes: [back], visibility: 'hidden' });
  hidden.intersect([{ target: back, isIntersecting: true, intersectionRatio: 1 }]);
  assert.deepEqual(hidden.reads, [], 'a background tab has seen nothing');
  hidden.show();
  assert.deepEqual(hidden.reads, [22], 'and reads it when it comes back to the front');
});

test('a transcript with no dotted row observes nothing', () => {
  const h = harness({ nodes: [] });
  assert.deepEqual(h.observed, []);
  assert.equal(h.cleanup, undefined, 'nothing to tear down');
});

// ── 3. Every kind a message rings with gets its dot ─────────────────────

const RECONCILE = (() => {
  const m = GROUP_CHAT_SRC.match(/reconcileDotsFromNotifications\(\) \{([\s\S]*?)\n {2}\},\n/);
  assert.ok(m, 'reconcileDotsFromNotifications() defined in group-chat.js');
  return m[1];
})();

function reconcile(items, messages) {
  const patches = [];
  const GroupChat = {
    messages,
    _react: () => ({ patchTranscriptMessage: (id, patch) => patches.push({ id, patch }) }),
  };
  const Notifications = { items };
  const run = new Function('window', 'Notifications', 'GroupChat', `return (() => {${RECONCILE}}).call(GroupChat);`);
  run({ Notifications }, Notifications, GroupChat);
  return patches;
}

test('a thread reply that arrived while the thread is open is dotted, and a read one is not', () => {
  const messages = [
    { id: 31, has_unread_notification: false },
    { id: 32, has_unread_notification: true },
    { id: 33, has_unread_notification: false },
  ];
  const patches = reconcile([
    { id: 1, kind: 'thread_reply', chatMessageId: 31, readAt: null },
    { id: 2, kind: 'change_thread_reply', chatMessageId: 32, readAt: '2026-11-06T17:00:00Z' },
    { id: 3, kind: 'issue_thread_reply', chatMessageId: 33, readAt: null },
  ], messages);
  assert.deepEqual(patches, [
    { id: 31, patch: { unread: true } },
    { id: 32, patch: { unread: false } },
    { id: 33, patch: { unread: true } },
  ]);
  assert.deepEqual(messages.map((m) => m.has_unread_notification), [true, false, true]);
});

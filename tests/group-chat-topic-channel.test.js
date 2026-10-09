'use strict';

// #4417 follow-up: a project's TOPIC channel is #general's pane, scoped to
// the topic's stream, so its messages open reply threads beside it exactly
// as #general's do, and a notification for one of its messages brings that
// message into view there and marks it, as #general's bell rows do.
//
// It was a thread mount (GroupChat.mountThread), and the group chat holds one
// thread at a time: a topic's message could not open a reply thread of its
// own, and nothing scrolled a thread to a message. Now the general pane shows
// a CHANNEL (`GroupChat._channel`, null for the app's own general stream):
//
//   * a topic's message offers "Reply in thread" (`canThread`), and its
//     reply thread opens beside the channel on its project page, named for
//     the topic (`_openThreadInPage` → AppView._stashDiscussionTarget);
//   * every read names the channel, every send and typing frame carries it,
//     and the socket's frames are sorted by it: the topic's own messages and
//     the replies of its reply threads in the pane, #general's not;
//   * reading it moves the topic's own cursor (app_category_chat_reads) and
//     its count in the places list;
//   * a message link, and a notification's address, name the topic
//     (`#messages/app/<slug>/c/<topic>/m/<id>`), and a reveal asked for a
//     topic's message is applied by that channel's pane alone.
//
// The REAL public/js/group-chat.js runs in a vm (as in
// tests/group-chat-reveal-message.test.js); the project page's half is pinned
// from project-discussion.tsx, and its door's target is read with loadTsx.
//
// Run with: node --test tests/group-chat-topic-channel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SRC = read('public/js/group-chat.js');
const PD_PATH = 'frontend/src/features/dev-board/workshop/project-discussion.tsx';
const PD = read(PD_PATH);
const VIEW = read('public/js/app-view.js');

const TOPIC = 7;

function setup({ pane = null, rows = new Map() } = {}) {
  const sent = [];
  const fetches = [];
  const stashed = [];
  const channelReads = [];
  const refreshes = [];
  const patches = [];
  const timers = [];
  const location = { search: '', hash: '' };
  const container = {
    scrollTop: 2400,
    getBoundingClientRect: () => ({ top: 100, height: 600, bottom: 700 }),
    querySelector(sel) {
      const m = /data-msg-id="(\d+)"/.exec(sel);
      return m ? rows.get(Number(m[1])) || null : null;
    },
    closest: (sel) => (pane && (sel === '[data-discussion-app]' || sel === '[data-ws-discussion]') ? pane : null),
  };
  const App = { user: { id: 7, username: 'evan' } };
  const sandbox = {
    window: {
      App,
      UsernodeReact: {
        places: { channelRead: (...args) => channelReads.push(args) },
        messages: { refresh: () => refreshes.push(true) },
      },
    },
    URLSearchParams, location, Date, Number, JSON, App,
    AppView: { _stashDiscussionTarget: (slug, t) => stashed.push([slug, JSON.parse(JSON.stringify(t))]) },
    document: {
      visibilityState: 'visible',
      getElementById: (id) => (id === 'gc-messages' ? container : null),
      // escapeHtml's round trip through a div, for a row's words.
      createElement() {
        let text = '';
        return {
          set textContent(v) { text = String(v); },
          get textContent() { return text; },
          get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
          set innerHTML(_v) {},
        };
      },
    },
    requestAnimationFrame: () => 0,
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
    clearTimeout: () => {},
    fetch: async (url, init) => {
      fetches.push([url, init && init.body ? JSON.parse(init.body) : null]);
      return { ok: true, text: async () => '', json: async () => ({ messages: [] }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const gc = sandbox.window.GroupChat;
  const appended = [];
  gc._react = () => ({
    patchTranscriptMessage: (id, patch) => patches.push([id, patch.flash]),
    appendTranscriptMessage: (view, key) => appended.push([view.id, key || 'main']),
  });
  // What the pane's own mount does around the stream is not under test here.
  gc._initSpecPanelResizer = () => {};
  gc._restoreSpecPanelIfSaved = () => {};
  gc.render = () => {};
  gc.attachScrollHandlers = () => {};
  const loads = [];
  gc.loadHistory = async () => { loads.push(gc._channelRef()); };
  gc.appSlug = 'homeroom';
  gc.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  return { gc, sandbox, sent, fetches, stashed, channelReads, refreshes, patches, appended, loads, location, container, rows };
}

const app = (channel) => ({ slug: 'homeroom', name: 'Homeroom', readOnly: false, ...(channel ? { channel } : {}) });
const topicMsg = (id, ref = TOPIC) => ({ id, user_id: 9, username: 'ada', content: `topic ${id}`, msg_type: 'message', thread_type: 'category', thread_ref: ref });

// ── 1. A topic's message starts a reply thread ──────────────────────────

test('a topic channel\'s message starts a reply thread, as a #general message does', () => {
  const { gc } = setup();
  assert.equal(gc._messageView(topicMsg(50)).canThread, true, 'Reply in thread, in a topic channel');
  assert.equal(gc._messageView({ id: 51, user_id: 9, content: 'x', msg_type: 'message' }).canThread, true, '#general, as before');
  assert.equal(gc._messageView({ ...topicMsg(52), msg_type: 'system' }).canThread, false, 'a notice starts none');
  assert.equal(gc._messageView({ id: 53, content: 'x', msg_type: 'message', thread_type: 'message', thread_ref: 50 }).canThread, false,
    'a reply is in a thread already: no nesting');
  assert.equal(gc._messageView({ id: 54, content: 'x', msg_type: 'message', thread_type: 'issue', thread_ref: 4 }).canThread, false,
    'a request\'s discussion keeps its own threads');
  assert.equal(gc._messageView({ ...topicMsg(55), deleted: true }).canThread, false);
});

// ── 2. The pane shows a channel ─────────────────────────────────────────

test('the general pane moves to a topic\'s channel and back without a second socket', () => {
  const { gc, loads } = setup();
  gc.messages = [{ id: 1, content: '#general' }];
  gc.mount('homeroom', app({ type: 'category', ref: TOPIC, markers: [] }));
  assert.deepEqual({ ...gc._channel }, { type: 'category', ref: TOPIC });
  assert.equal(gc.messages.length, 0, 'the stream starts over, from the topic');
  assert.deepEqual(loads, [TOPIC]);
  assert.equal(gc._firstPageUrl('homeroom', null), `/api/apps/homeroom/messages?thread_type=category&thread_ref=${TOPIC}&limit=50`,
    'read the way the topic\'s page always was, so the worker\'s copy is the same one');
  // The same channel again is a remount, not a new stream.
  gc.messages = [topicMsg(60)];
  gc.mount('homeroom', app({ type: 'category', ref: TOPIC }));
  assert.equal(gc.messages.length, 1);
  assert.deepEqual(loads, [TOPIC]);
  // Another topic, then the app's own stream (Homeroom's archive in Messages).
  gc.mount('homeroom', app({ type: 'category', ref: 8 }));
  gc.mount('homeroom', app(null));
  assert.equal(gc._channel, null);
  assert.deepEqual(loads, [TOPIC, 8, null]);
  assert.equal(gc._firstPageUrl('homeroom', null), '/api/apps/homeroom/messages?limit=50');
  // A thread's own reads are unchanged by it.
  assert.equal(gc._firstPageUrl('homeroom', { type: 'message', ref: 60 }), '/api/apps/homeroom/messages?thread_type=message&thread_ref=60&limit=50');
});

test('the pane\'s composer posts and types in the channel it shows; a thread\'s in its thread', () => {
  const { gc, sent } = setup();
  gc._app = app();
  gc._channel = { type: 'category', ref: TOPIC };
  gc.send('Which files does it touch?');
  gc.sendTyping();
  gc.typingTimeout = null;
  gc.send('In the thread.', { type: 'message', ref: 60 });
  assert.deepEqual(sent.map((p) => [p.type, p.content || null, p.thread]), [
    ['chat', 'Which files does it touch?', { type: 'category', ref: TOPIC }],
    ['typing', null, { type: 'category', ref: TOPIC }],
    ['chat', 'In the thread.', { type: 'message', ref: 60 }],
  ]);
  // #general's composer, as it always was: no scope at all.
  gc._channel = null;
  gc.send('In #general.');
  assert.equal(sent.at(-1).thread, undefined);
});

test('the socket\'s frames are sorted by the channel the pane shows', () => {
  const { gc, appended } = setup();
  const frame = (over) => ({ type: 'chat', userId: 9, username: 'ada', content: 'x', msgType: 'message', ...over });
  const inPane = () => [...gc.messages.map((m) => m.id)];
  gc._channel = { type: 'category', ref: TOPIC };
  gc.handleIncoming(frame({ id: 50, thread: { type: 'category', ref: TOPIC } }));
  gc.handleIncoming(frame({ id: 51 }));
  gc.handleIncoming(frame({ id: 52, thread: { type: 'category', ref: 8 } }));
  gc.handleIncoming(frame({ id: 53, thread: { type: 'message', ref: 50 }, threadRoot: { id: 50, thread_type: 'category', thread_ref: TOPIC } }));
  gc.handleIncoming(frame({ id: 54, thread: { type: 'message', ref: 40 }, threadRoot: { id: 40, thread_type: null, thread_ref: null } }));
  assert.deepEqual(inPane(), [50, 53], 'the topic\'s message, and a reply of a thread that starts in it');
  assert.deepEqual(appended, [[50, 'main'], [53, 'main']], 'drawn in the pane\'s transcript');
  assert.equal(gc.threads.has(`category:${TOPIC}`), false, 'the pane\'s own stream is not a thread');
  assert.deepEqual([...gc.threads.get('message:50').messages.map((m) => m.id)], [53], 'the reply is its thread\'s too');
  assert.deepEqual([...gc.threads.get('category:8').messages.map((m) => m.id)], [52], 'another topic keeps its frames');

  // The app's own stream, as before #4417's topics: #general's and the
  // replies whose root is there.
  gc.messages = [];
  gc._channel = null;
  gc.handleIncoming(frame({ id: 60 }));
  gc.handleIncoming(frame({ id: 61, thread: { type: 'category', ref: TOPIC } }));
  gc.handleIncoming(frame({ id: 62, thread: { type: 'message', ref: 60 }, threadRoot: { id: 60, thread_type: null, thread_ref: null } }));
  gc.handleIncoming(frame({ id: 63, thread: { type: 'message', ref: 50 }, threadRoot: { id: 50, thread_type: 'category', thread_ref: TOPIC } }));
  assert.deepEqual(inPane(), [60, 62]);
});

// ── 3. Reading it ───────────────────────────────────────────────────────

test('reading a topic\'s channel moves its own cursor, past its replies, and its count in the places list', async () => {
  const { gc, fetches, channelReads, refreshes } = setup();
  gc._channel = { type: 'category', ref: TOPIC };
  gc.messages = [topicMsg(60), topicMsg(64), { id: 65, thread_type: 'message', thread_ref: 60 }];
  await gc.markRead();
  assert.deepEqual(fetches, [['/api/apps/homeroom/messages/read', { message_id: 64, thread_type: 'category', thread_ref: TOPIC }]]);
  assert.deepEqual(channelReads, [['homeroom', TOPIC]]);
  assert.deepEqual(refreshes, [], 'Messages\' list is #general\'s');
  // "Mark unread" moves the same cursor back, and holds while it is open.
  await gc.markUnread(60);
  assert.deepEqual(fetches.at(-1), ['/api/apps/homeroom/messages/unread', { message_id: 60, thread_type: 'category', thread_ref: TOPIC }]);
  assert.deepEqual(channelReads.at(-1), ['homeroom', TOPIC, true]);
  assert.equal(gc._unreadHold, 'homeroom');
  // #general's read names no channel.
  gc._channel = null;
  gc._unreadHold = null;
  gc._readUpTo = 0;
  gc.messages = [{ id: 70, content: 'x' }];
  await gc.markRead();
  assert.deepEqual(fetches.at(-1), ['/api/apps/homeroom/messages/read', { message_id: 70 }]);
  assert.equal(refreshes.length, 1);
});

// ── 4. Its reply threads ────────────────────────────────────────────────

test('a topic message\'s reply thread opens beside the channel on its page, named for the topic', () => {
  const pane = { getAttribute: (n) => (n === 'data-discussion-app' ? 'homeroom' : null) };
  const { gc, stashed, location } = setup({ pane });
  gc._channel = { type: 'category', ref: TOPIC };
  gc.openReplyThread(60);
  assert.deepEqual(stashed, [['homeroom', { threadRootId: 60, topicRef: TOPIC }]]);
  assert.equal(location.hash, '', 'in place: the page keeps its address');
  gc._channel = null;
  gc.openReplyThread(61);
  assert.deepEqual(stashed.at(-1), ['homeroom', { threadRootId: 61, topicRef: null }], '#general\'s names none');
  // Not on its page: the thread's own address, beside the topic.
  const away = setup();
  away.gc._channel = { type: 'category', ref: TOPIC };
  away.gc.openReplyThread(60);
  assert.equal(away.location.hash, `#messages/app/homeroom/c/${TOPIC}/thread/60`);
  assert.equal(away.gc._threadAddress('homeroom', 60), `#messages/app/homeroom/c/${TOPIC}/thread/60`);
});

test('a link to a topic\'s message, or to a reply in its thread, is the topic\'s address', () => {
  const { gc } = setup();
  gc._channel = { type: 'category', ref: TOPIC };
  gc.messages = [topicMsg(60), { id: 65, thread_type: 'message', thread_ref: 60 }];
  const st = gc._threadState('message', 60);
  st.root = { id: 60, thread_type: 'category', thread_ref: TOPIC };
  st.messages = [{ id: 66, thread_type: 'message', thread_ref: 60 }];
  assert.equal(gc.messageAddress(60), `#messages/app/homeroom/c/${TOPIC}/m/60`);
  assert.equal(gc.messageAddress(65), `#messages/app/homeroom/c/${TOPIC}/m/65`, 'a reply drawn in the channel');
  assert.equal(gc.messageAddress(66), `#messages/app/homeroom/c/${TOPIC}/m/66`, 'a reply in its open thread');
  // A live reply says where its root is; #general's keep their address.
  gc.messages.push({ id: 67, thread: { type: 'message', ref: 40 }, threadRoot: { id: 40, thread_type: null, thread_ref: null } });
  assert.equal(gc.messageAddress(67), '#messages/app/homeroom/m/67');
  gc.messages.push({ id: 68, content: 'x' });
  gc._channel = null;
  assert.equal(gc.messageAddress(68), '#messages/app/homeroom/m/68');
});

// ── 5. A notification brings its message into view ──────────────────────

test('a topic message\'s reveal waits for that channel\'s pane, then scrolls to it and marks it', () => {
  const rows = new Map();
  const { gc, patches, container } = setup({ rows });
  gc._didInitialScroll = true;
  gc.messages = [topicMsg(5550), topicMsg(5552), topicMsg(5553)];
  rows.set(5552, { getBoundingClientRect: () => ({ top: 100 + 1400 - container.scrollTop, height: 40 }) });
  gc.revealMessage('homeroom', 5552, TOPIC);
  assert.equal(gc._pendingReveal.channel, TOPIC);
  // #general's pane (or another topic's) does not take it…
  gc._channel = null;
  assert.equal(gc._applyPendingReveal(), false);
  gc._channel = { type: 'category', ref: 8 };
  assert.equal(gc._applyPendingReveal(), false);
  assert.ok(gc._pendingReveal, 'kept for the pane it is for');
  // …the topic's does: centred in the stream and flashed.
  gc._channel = { type: 'category', ref: TOPIC };
  assert.equal(gc._applyPendingReveal(), true);
  const box = rows.get(5552).getBoundingClientRect();
  assert.equal(box.top + box.height / 2, 400, 'centred in the 600px stream at y=100');
  assert.deepEqual(patches, [[5552, true]]);
  assert.equal(gc._pendingReveal, null);
  // The mark outlasts a whole publish in its 1.5s (the pane's first page is
  // followed at once by its bot cards' render), and then it is gone.
  assert.equal(gc._messageView(topicMsg(5552)).flash, true, 'rebuilt marked');
  assert.equal(gc._messageView(topicMsg(5553)).flash, false);
  gc._revealFlash.until = Date.now() - 1;
  assert.equal(gc._messageView(topicMsg(5552)).flash, false);
  // A #general reveal (the bell's _openAppDiscussion) is #general's alone.
  gc.revealMessage('homeroom', 5553);
  assert.equal(gc._applyPendingReveal(), false);
  gc._channel = null;
  gc.messages = [{ id: 5553, content: 'x' }];
  rows.set(5553, { getBoundingClientRect: () => ({ top: 100 + 900 - container.scrollTop, height: 40 }) });
  assert.equal(gc._applyPendingReveal(), true);
});

test('a topic message older than the loaded page is looked for in the topic\'s own stream', async () => {
  const { gc, fetches } = setup();
  gc._didInitialScroll = true;
  gc._channel = { type: 'category', ref: TOPIC };
  gc.messages = [topicMsg(5550)];
  gc.hasMore = false;
  gc.revealMessage('homeroom', 1234, TOPIC);
  assert.equal(gc._applyPendingReveal(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches[0][0], `/api/apps/homeroom/messages?around=1234&limit=1&thread_type=category&thread_ref=${TOPIC}`);
});

test('a reply in a topic message\'s thread, named by a link, opens that thread beside the topic', () => {
  const { gc, sandbox } = setup();
  const opened = [];
  sandbox.window.UsernodeReact.messages.openAddress = (href) => opened.push(href);
  gc._didInitialScroll = true;
  gc._channel = { type: 'category', ref: TOPIC };
  gc.messages = [topicMsg(900), { id: 1234, thread_type: 'message', thread_ref: 900 }];
  gc.revealMessage('homeroom', 1234, TOPIC);
  assert.equal(gc._applyPendingReveal(), false);
  assert.deepEqual(opened, [`#messages/app/homeroom/c/${TOPIC}/thread/900`]);
});

// ── 6. The project page's half ──────────────────────────────────────────

test('the topic\'s place mounts #general\'s pane, scoped to the topic, with its reply thread beside it', () => {
  const channel = PD.slice(PD.indexOf('function TopicChannel('));
  // The pane is #general's (AppView.renderGroupChatTab), named for the topic.
  assert.match(channel, /view\?\.renderGroupChatTab\?\.\(\{[\s\S]*?channel: \{ type: 'category', ref, markers: markersRef\.current \},[\s\S]*?placeholder: `Message #\$\{topic\.handle\}`,/);
  assert.doesNotMatch(channel, /mountThread/, 'no longer a thread mount: the one thread slot is its reply thread\'s');
  // Held only while the page is the screen on show (one general pane).
  assert.match(channel, /const onShow = screen === 'app-view' && !!tab;/);
  assert.match(channel, /if \(!el \|\| !onShow\) return undefined;/);
  // Its reply thread is #general's pane beside it, closed in place.
  assert.match(channel, /<AppReplyThreadPane[\s\S]*?readOnly=\{readOnly \|\| closed\}[\s\S]*?where=\{`#\$\{topic\.handle\}`\}[\s\S]*?onClick=\{\(\) => setThread\(null\)\}/);
  assert.match(channel, /className=\{`dev-ws-discussion dev-ws-topic-channel\$\{thread \? ' dev-ws-discussion-threaded' : ''\}`\}/);
  assert.match(channel, /data-discussion-app=\{slug\}/);
  // The door's target is the topic's: a message revealed, a thread opened.
  assert.match(channel, /const target = takeDiscussionTarget\(slug, ref\);/);
  assert.match(channel, /GroupChat\?\.revealMessage\?\.\(slug, target\.focusMessageId, ref\)/);
  assert.match(channel, /setThread\(\(cur\) => \(\{ rootId, key: \(cur\?\.key \|\| 0\) \+ 1 \}\)\)/);
  assert.match(channel, /window\.addEventListener\('usernode:workshop-discussion', onTarget\);/);
  // A thread beside a channel is a level below it.
  assert.match(channel, /below: \(\) => !!threadRef\.current,\s*up: \(\) => setThread\(null\),\s*depth: 2,/);
  // The pane takes what it is told about the channel.
  assert.match(VIEW, /\.\.\.\(ctx\.channel \? \{ channel: ctx\.channel \} : \{\}\),/);
  assert.match(VIEW, /\.\.\.\(ctx && ctx\.placeholder \? \{ placeholder: ctx\.placeholder \} : \{\}\),/);
});

test('a door\'s target is taken by the channel it names: a topic\'s by its place, #general\'s by #general', () => {
  const { takeDiscussionTarget } = loadTsx(PD_PATH, { stubs: { '../../messages': { EmbeddedConversation: () => null, AppReplyThreadPane: () => null } } });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  let waiting = null;
  globalThis.window = {
    AppView: {
      _peekDiscussionTarget: () => waiting,
      _takeDiscussionTarget: () => { const t = waiting; waiting = null; return t; },
    },
  };
  try {
    waiting = { threadRootId: 60, focusMessageId: 0, topicRef: TOPIC };
    assert.equal(takeDiscussionTarget('homeroom'), null, '#general leaves a topic\'s target');
    assert.equal(takeDiscussionTarget('homeroom', 8), null, 'and so does another topic');
    assert.deepEqual(takeDiscussionTarget('homeroom', TOPIC), { threadRootId: 60, focusMessageId: null, conversationId: null });
    assert.equal(waiting, null, 'taken once');
    waiting = { threadRootId: null, focusMessageId: 41, topicRef: null };
    assert.equal(takeDiscussionTarget('homeroom', TOPIC), null, 'a topic leaves #general\'s');
    assert.deepEqual(takeDiscussionTarget('homeroom'), { threadRootId: null, focusMessageId: 41, conversationId: null });
  } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
  }
});

test('beside a thread on a desktop the topic\'s line runs over both, and on a phone it goes with the room', () => {
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 767\.98px\) \{\s*\.dev-ws-topic-channel\.dev-ws-discussion-threaded > \.dev-ws-topic-head \{ display: none; \}\s*\}/);
  assert.match(css, /\.dev-ws-topic-channel\.dev-ws-discussion-threaded \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) min\(420px, 42%\);\s*grid-template-rows: auto minmax\(0, 1fr\);\s*\}/);
  assert.match(css, /\.dev-ws-topic-channel\.dev-ws-discussion-threaded > \.dev-ws-topic-head \{ grid-column: 1 \/ -1; \}/);
});

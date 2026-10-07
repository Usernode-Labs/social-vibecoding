'use strict';

// #4177: one place that re-reads what is on screen after a gap.
//
// The reported case: a proposal opened in a new tab showed an empty
// Discussion. The service worker answered the thread's first page from an
// older saved copy (public/sw.js, API_TIMEOUT_MS), its late correction reached
// a screen loader that deliberately left the thread alone, and the thread
// only loads once. The same shape (read once, then trust the socket) left
// vote rosters, a change page's row and the chat streams wrong after a socket
// drop, a relay gap or a hidden tab.
//
// These tests pin the pieces:
//   1. frontend/src/lib/live-reads.ts: the triggers and who hears them;
//   2. public/sw.js: a re-read waits for the network instead of the copy;
//   3. the relay: a fresh LISTEN tells this server's sockets to re-read;
//   4. public/js/group-chat.js: loaded streams catch up instead of paging back;
//   5. the proposal page: its row, its rosters and app.js's reconnect sweep.
//
// Run with: node --test tests/live-reads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. The module ─────────────────────────────────────────────────────

const live = () => loadTsx('frontend/src/lib/live-reads.ts');

function install({ hidden = false } = {}) {
  const lr = live();
  lr._resetLiveReads();
  const listeners = { win: new Map(), doc: new Map() };
  const on = (side) => (type, fn) => {
    if (!listeners[side].has(type)) listeners[side].set(type, []);
    listeners[side].get(type).push(fn);
  };
  const win = { location: { origin: 'https://h.test' }, addEventListener: on('win'), UsernodeReact: {} };
  const doc = { visibilityState: hidden ? 'hidden' : 'visible', addEventListener: on('doc') };
  lr.installLiveReads(win, doc);
  const fire = (side, type, event) => {
    for (const fn of listeners[side].get(type) || []) fn(event || {});
  };
  return { lr, win, doc, fire };
}

function recorder() {
  const calls = [];
  const fn = (resync) => { calls.push(resync); };
  fn.calls = calls;
  return fn;
}

test('a reconnect re-reads every watcher, once per pass, with no urls', () => {
  const { lr } = install();
  const a = recorder();
  const b = recorder();
  lr.watch(a);
  lr.watch(b, { reads: () => false });
  lr.resync('reconnect');
  lr.resync('reconnect');
  lr.flush();
  assert.equal(a.calls.length, 1, 'two triggers in one pass are one re-read');
  assert.equal(b.calls.length, 1, 'a watcher with reads still hears an everything-re-read');
  assert.equal(a.calls[0].urls, null);
  assert.equal(a.calls[0].reason, 'reconnect');
});

test('a correction reaches only the watcher that owns the read', () => {
  const { lr, fire } = install();
  const owner = recorder();
  const other = recorder();
  const blind = recorder();
  lr.watch(owner, { reads: (u) => u.pathname === '/api/apps/demo/messages' });
  lr.watch(other, { reads: (u) => u.pathname === '/api/sessions/5/votes' });
  lr.watch(blind);
  fire('win', 'usernode:api-updated', { detail: { url: 'https://h.test/api/apps/demo/messages?limit=50' } });
  lr.flush();
  assert.deepEqual(owner.calls.map((c) => c.urls), [['https://h.test/api/apps/demo/messages?limit=50']]);
  assert.equal(owner.calls[0].reason, 'correction');
  assert.equal(other.calls.length, 0);
  assert.equal(blind.calls.length, 0, 'a watcher that names no reads hears no corrections');
});

test('nothing re-reads while the tab is hidden; it runs when the tab is seen', () => {
  const { lr, doc, fire } = install({ hidden: true });
  const w = recorder();
  lr.watch(w);
  lr.resync('reconnect');
  lr.flush();
  assert.equal(w.calls.length, 0, 'a hidden tab reads nothing');
  doc.visibilityState = 'visible';
  fire('doc', 'visibilitychange');
  lr.flush();
  assert.equal(w.calls.length, 1, 'what was asked for while hidden runs when seen');
});

test('coming back after being away re-reads everything; a glance away does not', () => {
  const { lr, doc, fire } = install();
  const w = recorder();
  lr.watch(w);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    doc.visibilityState = 'hidden';
    fire('doc', 'visibilitychange');
    now += 5_000;
    doc.visibilityState = 'visible';
    fire('doc', 'visibilitychange');
    lr.flush();
    assert.equal(w.calls.length, 0, 'five seconds away: the sockets were still delivering');

    doc.visibilityState = 'hidden';
    fire('doc', 'visibilitychange');
    now += lr.AWAY_MS;
    doc.visibilityState = 'visible';
    fire('doc', 'visibilitychange');
    lr.flush();
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].reason, 'visible');
    assert.equal(w.calls[0].urls, null);
  } finally {
    Date.now = realNow;
  }
});

test('coming back online re-reads everything', () => {
  const { lr, fire } = install();
  const w = recorder();
  lr.watch(w);
  fire('win', 'online');
  lr.flush();
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].reason, 'online');
});

test('one watcher failing does not stop the others, and unwatch removes one', async () => {
  const { lr } = install();
  const after = recorder();
  lr.watch(() => { throw new Error('boom'); });
  lr.watch(() => Promise.reject(new Error('later boom')));
  const unwatch = lr.watch(recorder());
  lr.watch(after);
  unwatch();
  lr.resync('reconnect');
  lr.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(after.calls.length, 1);
});

test('the bridge is published for the classic scripts, with the fresh init', () => {
  const { win } = install();
  const bridge = win.UsernodeReact.liveReads;
  assert.equal(typeof bridge.watch, 'function');
  assert.equal(typeof bridge.resync, 'function');
  assert.equal(bridge.FRESH.cache, 'no-cache');
  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/live-reads';/,
    'the browser entry installs it before DOMContentLoaded');
});

// ── 2. The service worker ─────────────────────────────────────────────

const sw = require('../public/sw.js');

test('a no-cache or reload read asks the worker for the current answer', () => {
  assert.equal(sw.wantsFreshAnswer('no-cache'), true);
  assert.equal(sw.wantsFreshAnswer('reload'), true);
  assert.equal(sw.wantsFreshAnswer('default'), false);
  assert.equal(sw.wantsFreshAnswer(undefined), false);
  assert.match(read('public/sw.js'), /const timeoutMs = wantsFreshAnswer\(event\.request\.cache\) \? null/,
    'networkFirstApi gives such a read no deadline');
});

test('with no deadline, a slow network answer wins over the saved copy', async () => {
  let scheduled = 0;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const pending = sw.raceNetworkAndCache({
    startFetch: () => slow,
    matchCache: async () => 'saved copy',
    timeoutMs: null,
    schedule: () => { scheduled++; return () => {}; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release('network answer');
  const { response, fromCache } = await pending;
  assert.equal(response, 'network answer');
  assert.equal(fromCache, false);
  assert.equal(scheduled, 0, 'no deadline is ever armed');
});

test('with no deadline, the saved copy still answers when the network fails', async () => {
  const { response, fromCache } = await sw.raceNetworkAndCache({
    startFetch: () => Promise.reject(new Error('offline')),
    matchCache: async () => 'saved copy',
    timeoutMs: null,
    schedule: () => () => {},
  });
  assert.equal(response, 'saved copy');
  assert.equal(fromCache, true);
});

// ── 3. The relay ──────────────────────────────────────────────────────

test('each fresh LISTEN runs the listening handler, which cannot throw out', () => {
  const bus = require('../src/services/ws-bus');
  let heard = 0;
  bus.start({ pool: null, connectionString: null, onMessage: () => {}, onListening: () => { heard++; } });
  bus._listening();
  bus._listening();
  assert.equal(heard, 2);
  bus.start({ pool: null, connectionString: null, onMessage: () => {}, onListening: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => bus._listening());
  const src = read('src/services/ws-bus.js');
  assert.match(src, /await client\.query\(`LISTEN \$\{CHANNEL\}`\);[\s\S]{0,200}_listening\(\);/,
    'the handler runs after every successful LISTEN, reconnects included');
});

test('a fresh LISTEN nudges every events socket and every chat room on this server', () => {
  const src = read('src/services/ws.js');
  assert.match(src, /onListening: _onBusListening,/);
  const fn = src.slice(src.indexOf('function _onBusListening()'), src.indexOf('// The Homeroom bot follows issue activity.'));
  assert.match(fn, /const hint = \{ type: 'resync_hint' \};/);
  assert.match(fn, /deliverGlobal\(hint\);/);
  assert.match(fn, /for \(const appId of rooms\.keys\(\)\) deliverToRoom\(appId, hint\);/);
});

// ── 4. The chat streams ───────────────────────────────────────────────

const gcJs = read('public/js/group-chat.js');

function loadGroupChat({ fetch, liveReads } = {}) {
  const document = {
    createElement: () => ({ style: {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const window = { matchMedia: () => ({ matches: false }), UsernodeReact: liveReads ? { liveReads } : {} };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
    URL, URLSearchParams,
    document,
    window,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console,
    fetch: fetch || (async () => ({ ok: true, json: async () => ({ messages: [] }) })),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

const ids = (list) => Array.from(list, (m) => Number(m.id));
const msg = (id, extra) => ({ id, content: `m${id}`, ...(extra || {}) });

const liveSet = (...list) => new Set(list.map(String));

test('the newest page is the truth from its first id on', () => {
  const GroupChat = loadGroupChat();
  // Held: 1..6, of which 5 was deleted on the server and 4 edited; 9 arrived
  // over the socket while the read was in flight. The page spans 3..8.
  const current = [1, 2, 3, 4, 5, 6, 9].map((id) => msg(id));
  const latest = [msg(3), msg(4, { content: 'edited' }), msg(6), msg(7), msg(8)];
  const { messages, reset } = GroupChat._reconcileLatest(current, latest, true, { before: 6, live: liveSet(9) });
  assert.equal(reset, false);
  assert.deepEqual(ids(messages), [1, 2, 3, 4, 6, 7, 8, 9]);
  assert.equal(messages[3].content, 'edited');
});

test('a page that is the whole stream replaces everything held', () => {
  const GroupChat = loadGroupChat();
  const { messages } = GroupChat._reconcileLatest([msg(1), msg(2), msg(3)], [msg(2), msg(4)], false, { before: 3 });
  assert.deepEqual(ids(messages), [2, 4], 'message 1 and 3 are gone from the server');
});

test('a gap wider than a page starts the stream over from the newest page', () => {
  const GroupChat = loadGroupChat();
  const { messages, reset } = GroupChat._reconcileLatest([msg(1), msg(2)], [msg(60), msg(61)], true, { before: 2 });
  assert.equal(reset, true);
  assert.deepEqual(ids(messages), [60, 61]);
});

// ── The five review findings on 68127b4d ──────────────────────────────

test('review 2: a socket edit, delete or reaction during the read outranks its older answer', () => {
  const GroupChat = loadGroupChat();
  // Held 1..3. While the read is on the wire, 2 is edited, 3 is deleted and
  // 1 gets a reaction; the answer was read before all three.
  const current = [msg(1, { reactions: [{ emoji: '👍', count: 1 }] }), msg(2, { content: 'new' }), msg(3, { deleted: true, content: '' })];
  const latest = [msg(1, { reactions: [] }), msg(2, { content: 'old' }), msg(3, { content: 'still here' })];
  const { messages } = GroupChat._reconcileLatest(current, latest, false, { before: 3, live: liveSet(1, 2, 3) });
  assert.equal(messages[0].reactions.length, 1);
  assert.equal(messages[1].content, 'new', 'old → new stays new, not back to old');
  assert.equal(messages[2].deleted, true);
});

test('review 2, end to end: an edit that lands during the catch-up survives it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const GroupChat = loadGroupChat({
    fetch: async () => { await gate; return { ok: true, json: async () => ({ messages: [msg(1), msg(2, { content: 'old' })] }) }; },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1), msg(2, { content: 'old' })];
  GroupChat.oldestMessageId = 1;
  const pending = GroupChat._refreshLatest(null);
  GroupChat.handleIncoming({ type: 'chat_edit', messageId: 2, content: 'new', editedAt: 'now' });
  release();
  await pending;
  assert.equal(GroupChat.messages.find((m) => Number(m.id) === 2).content, 'new');
  assert.equal(GroupChat._liveWindows.size, 0, 'the window closes with the read');
});

test('review 3: a message delivered after the gap does not hide it', () => {
  const GroupChat = loadGroupChat();
  // Held [1, 2] before the gap; 110 arrived over the socket during the read;
  // the newest page is 60..109, so 3..59 are missing.
  const page = Array.from({ length: 50 }, (_, i) => msg(60 + i));
  const { messages, reset } = GroupChat._reconcileLatest([msg(1), msg(2), msg(110)], page, true,
    { before: 2, live: liveSet(110) });
  assert.equal(reset, true, 'the stream starts over, so "Load earlier" pages back from 60');
  assert.deepEqual(ids(messages), [...page.map((m) => m.id), 110]);
});

test('review 3, end to end: the gap is measured from before the read', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = Array.from({ length: 50 }, (_, i) => msg(60 + i));
  const GroupChat = loadGroupChat({
    fetch: async () => { await gate; return { ok: true, json: async () => ({ messages: page }) }; },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1), msg(2)];
  GroupChat.oldestMessageId = 1;
  const pending = GroupChat._refreshLatest(null);
  GroupChat.handleIncoming({ type: 'chat', ...msg(110) });
  release();
  await pending;
  assert.equal(GroupChat.oldestMessageId, 60);
  assert.equal(GroupChat.hasMore, true);
  assert.deepEqual(ids(GroupChat.messages).slice(-2), [109, 110]);
  assert.equal(ids(GroupChat.messages)[0], 60);
});

test('review 4: a held message the answer lacks is gone, unless it arrived during the read', () => {
  const GroupChat = loadGroupChat();
  // 12 was the newest reply line, deleted on the server; 13 arrived live.
  const { messages } = GroupChat._reconcileLatest([msg(10), msg(11), msg(12), msg(13)], [msg(10), msg(11)], false,
    { before: 12, live: liveSet(13) });
  assert.deepEqual(ids(messages), [10, 11, 13]);
  const empty = GroupChat._reconcileLatest([msg(1), msg(2)], [], false, { before: 2 });
  assert.deepEqual(ids(empty.messages), [], 'an empty whole-stream answer keeps nothing');
});

test('review 1: a catch-up asked for during a read runs again when it lands', async () => {
  const releases = [];
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      requests.push(url);
      await new Promise((resolve) => releases.push(resolve));
      return { ok: true, json: async () => ({ messages: requests.length === 1 ? [msg(1)] : [msg(1), msg(2)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1)];
  GroupChat.oldestMessageId = 1;
  const first = GroupChat._refreshLatest(null);
  await new Promise((resolve) => setImmediate(resolve));
  GroupChat.resyncLoaded(); // a second gap while the first read is on the wire
  assert.equal(requests.length, 1, 'not two reads at once');
  releases[0]();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, 'one more read after the first lands');
  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ids(GroupChat.messages), [1, 2]);

  // The same for a thread.
  const threadRequests = [];
  const threadReleases = [];
  const GC2 = loadGroupChat({
    fetch: async (url) => {
      // The general stream, never loaded here, takes its own first page.
      if (!url.includes('thread_type=')) return { ok: true, json: async () => ({ messages: [] }) };
      threadRequests.push(url);
      await new Promise((resolve) => threadReleases.push(resolve));
      return { ok: true, json: async () => ({ messages: [msg(5)] }) };
    },
  });
  GC2.appSlug = 'demo';
  Object.assign(GC2._threadState('session', 9), { loaded: true, messages: [msg(5)], oldestId: 5 });
  GC2.activeThread = { type: 'session', ref: 9 };
  const t1 = GC2._refreshLatest({ type: 'session', ref: 9 });
  await new Promise((resolve) => setImmediate(resolve));
  GC2.resyncLoaded();
  threadReleases[0]();
  await t1;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(threadRequests.length, 2);
  threadReleases[1]();
});

test('review 5: a channel whose first page came back empty still takes its correction', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ messages: [msg(7), msg(8)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true; // its first page loaded, empty
  GroupChat.messages = [];
  GroupChat.oldestMessageId = null;
  GroupChat._onLiveResync({ reason: 'correction', urls: ['http://localhost/api/apps/demo/messages?limit=50'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.cache, 'no-cache');
  assert.deepEqual(ids(GroupChat.messages), [7, 8]);
  assert.equal(GroupChat.oldestMessageId, 7);
});

test('a reconnect catches the general stream UP, freshly, instead of paging back', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ messages: [msg(2), msg(3), msg(4)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat._streamLoaded = true;
  GroupChat.messages = [msg(1), msg(2)];
  GroupChat.oldestMessageId = 1;
  GroupChat.resyncLoaded();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/apps/demo/messages?limit=50', 'the newest page, never ?before=');
  assert.equal(requests[0].init.cache, 'no-cache');
  // A short page is the whole stream: 1 is no longer on the server (hidden,
  // or from someone the reader blocked), so it goes; 3 and 4 were missed.
  assert.deepEqual(ids(GroupChat.messages), [2, 3, 4]);
  assert.equal(GroupChat.hasMore, false);

  const open = gcJs.slice(gcJs.indexOf('ws.onopen = () => {'), gcJs.indexOf('ws.onmessage'));
  assert.match(open, /GroupChat\.resyncLoaded\(\);/);
  assert.doesNotMatch(open, /GroupChat\.loadHistory\(\)/, 'onopen no longer pages backward on a loaded stream');
});

test('the open thread catches up; a thread cached off screen is marked stale', async () => {
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ messages: [msg(10), msg(11)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  const open = GroupChat._threadState('session', 6284);
  Object.assign(open, { loaded: true, messages: [msg(10)], oldestId: 10 });
  const away = GroupChat._threadState('issue', 12);
  Object.assign(away, { loaded: true, messages: [msg(5)], oldestId: 5 });
  const never = GroupChat._threadState('issue', 13);
  GroupChat.activeThread = { type: 'session', ref: 6284, language: 'chat' };
  GroupChat.oldestMessageId = null;
  GroupChat._historyLoad = {}; // the general stream's own first read is in flight
  GroupChat.resyncLoaded();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/apps/demo/messages?thread_type=session&thread_ref=6284&limit=50']);
  assert.deepEqual(ids(open.messages), [10, 11]);
  assert.equal(away.stale, true, 'caught up when it is mounted again');
  assert.notEqual(never.stale, true, 'a thread that never loaded is left to its own first read');
  assert.match(gcJs, /else if \(st\.stale\) void GroupChat\._refreshLatest\(\{ type, ref \}\);/,
    'mountThread catches a stale thread up');
});

test('a correction re-reads exactly the stream it names', () => {
  const GroupChat = loadGroupChat();
  GroupChat.appSlug = 'demo';
  const refreshed = [];
  GroupChat._refreshLatest = (thread) => { refreshed.push(thread ? `${thread.type}:${thread.ref}` : 'general'); };
  GroupChat.oldestMessageId = 1;
  Object.assign(GroupChat._threadState('session', 7), { loaded: true });
  Object.assign(GroupChat._threadState('issue', 3), { loaded: true });
  GroupChat.activeThread = { type: 'session', ref: 7 };
  GroupChat._onLiveResync({ reason: 'correction', urls: [
    'http://localhost/api/apps/demo/messages?thread_type=session&thread_ref=7&limit=50',
    'http://localhost/api/apps/demo/messages?thread_type=issue&thread_ref=3&limit=50',
    'http://localhost/api/apps/demo/messages?limit=50&before=40',
  ] });
  assert.deepEqual(refreshed, ['session:7'], 'an older page is not the newest one');
  assert.equal(GroupChat._threadState('issue', 3).stale, true);
});

test('a correction that lands during the first read is caught up once that read is done', async () => {
  // The reported case: the worker answers the thread's first page from an
  // older saved copy, and its correction can arrive before that page is in.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const GroupChat = loadGroupChat({
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) { await gate; return { ok: true, json: async () => ({ messages: [] }) }; }
      return { ok: true, json: async () => ({ messages: [msg(1), msg(2)] }) };
    },
  });
  GroupChat.appSlug = 'demo';
  GroupChat.activeThread = { type: 'session', ref: 6284, language: 'chat' };
  const first = GroupChat.loadThreadHistory('session', 6284);
  GroupChat._onLiveResync({ reason: 'correction', urls: [
    'http://localhost/api/apps/demo/messages?thread_type=session&thread_ref=6284&limit=50',
  ] });
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.cache, 'no-cache');
  assert.deepEqual(ids(GroupChat._threadState('session', 6284).messages), [1, 2],
    'the empty saved copy is replaced by the thread as it is');
});

test('the chat registers with live reads once, for its own messages reads', () => {
  const registered = [];
  const GroupChat = loadGroupChat({ liveReads: { watch: (fn, opts) => { registered.push(opts); return () => {}; } } });
  GroupChat._watchLiveReads();
  GroupChat._watchLiveReads();
  assert.equal(registered.length, 1);
  GroupChat.appSlug = 'demo';
  assert.equal(registered[0].reads(new URL('http://localhost/api/apps/demo/messages?limit=50')), true);
  assert.equal(registered[0].reads(new URL('http://localhost/api/apps/other/messages?limit=50')), false);
  assert.match(gcJs, /GroupChat\._openSocket\(\);\s*GroupChat\.attachScrollHandlers\(\);[\s\S]{0,200}GroupChat\._watchLiveReads\(\);/,
    'connect registers it');
});

test('the chat socket answers resync_hint and moderation_changed by catching up', () => {
  const GroupChat = loadGroupChat();
  let resyncs = 0;
  GroupChat.resyncLoaded = () => { resyncs++; };
  GroupChat.handleIncoming({ type: 'resync_hint' });
  GroupChat.handleIncoming({ type: 'moderation_changed' });
  assert.equal(resyncs, 2);
});

test('a broadcast already brought in by a catch-up is not drawn twice', () => {
  const GroupChat = loadGroupChat();
  GroupChat.appSlug = 'demo';
  GroupChat.messages = [msg(5)];
  GroupChat.handleIncoming({ type: 'chat', ...msg(5) });
  assert.deepEqual(ids(GroupChat.messages), [5]);
  const st = GroupChat._threadState('session', 9);
  st.messages = [msg(8)];
  GroupChat.handleIncoming({ type: 'chat', ...msg(8), thread: { type: 'session', ref: 9 } });
  assert.deepEqual(ids(st.messages), [8]);
});

// ── 5. The proposal page ──────────────────────────────────────────────

test('the reconnect sweep hands the moved screens to live reads', () => {
  const app = read('public/js/app.js');
  const sweep = app.slice(app.indexOf('  resyncCurrentView() {'), app.indexOf('  _listedNewApps:'));
  assert.match(sweep, /window\.UsernodeReact\?\.liveReads\?\.resync\?\.\('reconnect'\);/);
  assert.doesNotMatch(sweep, /change-detail-refresh/, 'the change page re-reads through live reads now');
});

test('a change page re-reads its own row and roster when live reads asks', () => {
  const src = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  const detail = src.slice(src.indexOf('export function ChangeDetail('));
  assert.match(detail, /const paths = new Set\(\[changeDetailPath\(item\), `\/api\/sessions\/\$\{id\}\/votes`\]\);/);
  assert.match(detail, /watch\(\(\) => \{\s*freshNext\.current = true;\s*setRevision\(\(n\) => n \+ 1\);\s*\}, \{ reads: \(url\) => paths\.has\(url\.pathname\) \}\);/);
  assert.match(detail, /unwatch\(\);/, 'and stops when it unmounts');
  assert.doesNotMatch(detail, /detail === 'all'/);
});

test('a fresh change-page read skips the saved copy and re-reads the roster for anyone', async () => {
  const { readChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const invalidated = [];
  const loads = [];
  global.window = { AppView: { appData: { slug: 'example' }, _demoQS: () => '',
    _invalidateVoteRoster(id) { invalidated.push(id); },
    _loadVoteRoster(id, opts) { loads.push(opts); } } };
  const inits = [];
  global.fetch = async (url, init) => {
    inits.push(init);
    return { ok: true, json: async () => ({ proposal: { id: 7, status: 'promoted' } }) };
  };
  const signal = new AbortController().signal;
  try {
    await readChangeDetail({ id: 7, status: 'promoted' }, false, signal);
    assert.equal(inits[0].cache, undefined, 'an ordinary read is unchanged');
    assert.deepEqual(invalidated, [], 'and leaves a reader\'s roster cached');
    await readChangeDetail({ id: 7, status: 'promoted' }, false, signal, { fresh: true });
    assert.equal(inits[1].cache, 'no-cache');
    assert.equal(inits[1].signal, signal);
    assert.deepEqual(invalidated, [7]);
    assert.equal(loads[1].fresh, true);
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

function loadAppView({ fetch, liveReads, currentTab = 'dev' } = {}) {
  const sandbox = {
    console,
    relTime: () => ({ text: '', title: '' }),
    relStamp: () => ({ text: '', title: '' }),
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo', currentTab },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, body: { appendChild: () => {} },
    },
    fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    UsernodeReact: liveReads ? { liveReads } : {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._renderTopicHead = () => {};
  return AppView;
}

test('an open governance topic re-reads its roster, freshly, after a gap', async () => {
  const requests = [];
  let reads = null;
  const AppView = loadAppView({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ yes: ['bob'], no: [], reasons: [] }) };
    },
    liveReads: { watch: (fn, opts) => { reads = opts.reads; AppView.__reread = fn; return () => {}; } },
  });
  AppView._govVoteRoster[7] = { phase: 'ready', yes: { label: 'Yes (0)', names: '' } };
  AppView._devTopic = { kind: 'gov', id: 7 };
  AppView._watchTopicLiveReads();
  assert.equal(reads(new URL('http://localhost/api/apps/demo/governance/7/votes')), true);
  assert.equal(reads(new URL('http://localhost/api/apps/demo/governance/8/votes')), false);
  await AppView.__reread({ reason: 'reconnect', urls: null });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/apps/demo/governance/7/votes');
  assert.equal(requests[0].init.cache, 'no-cache');
  assert.match(AppView._govVoteRoster[7].yes.names, /@bob/, 'another person\'s vote now shows');

  AppView._devTopic = { kind: 'proposal', id: 7 };
  await AppView.__reread({ reason: 'reconnect', urls: null });
  assert.equal(requests.length, 1, 'only a governance topic has this roster to re-read');
});

test('opening a governance topic marks its cached roster for a re-read', () => {
  const src = read('public/js/app-view.js');
  const open = src.slice(src.indexOf('  async _renderTopicSubView(content, ref) {'));
  assert.match(open.slice(0, 2500), /if \(ref\.kind === 'gov'\) AppView\._invalidateGovVoteRoster\(ref\.id\);/);
  assert.match(open.slice(0, 2500), /AppView\._watchTopicLiveReads\(\);/);
});

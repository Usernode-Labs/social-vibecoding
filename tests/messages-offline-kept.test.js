'use strict';

// Messages and the Homeroom bot tab, readable offline (offline test,
// 2 Nov 2026, findings 5 and 6). With the internet off:
//
//   - Messages, and a conversation opened minutes earlier, showed the
//     browser's own exception in red ("FetchEvent.respondWith received an
//     error: TypeError: Load failed"), with nothing saved to show instead,
//     and the conversation's header was blank;
//   - the bot tab's Needs you was an empty card, with no word of why.
//
// The service worker could not help: GET /api/conversations* and
// GET /api/ai/work answer `private, no-store`, which it honours, so it never
// had a copy. What this pins:
//
//   1. frontend/src/lib/kept-copies.ts: a small per-viewer store, read back
//      only under the session it was kept for, forgotten when the session
//      changes or ends (App._dropCachedSession), bounded in age, size and in
//      how many conversations it keeps.
//   2. frontend/src/features/messages/api.ts keeps the list and the newest
//      page and detail of the last few conversations, as the server sent
//      them, and normalizes them again when they are drawn.
//   3. frontend/src/features/messages/store.ts draws a kept copy only when a
//      read had no answer; with none it says so in the catalog's words,
//      never the exception's, and a conversation's header keeps its name.
//   4. frontend/src/features/ai/: the bot tab draws its kept lists, or says
//      over Needs you why it has none, with Try again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const KEPT = 'frontend/src/lib/kept-copies.ts';
const API = 'frontend/src/features/messages/api.ts';
const STORE = 'frontend/src/features/messages/store.ts';
const LISTS = 'frontend/src/features/ai/lists.tsx';
const AI = 'frontend/src/features/ai/index.tsx';

const ADA = 'a'.repeat(64);
const BEA = 'b'.repeat(64);
// What the iPhone app drew, word for word.
const WEBKIT_FAILURE = 'FetchEvent.respondWith received an error: TypeError: Load failed';

function fakeStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** A browser signed in under `scope` (its API cache partition), with its own storage. */
function browser(t, { scope = ADA } = {}) {
  const saved = ['window', 'document', 'localStorage', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const storage = fakeStorage();
  globalThis.localStorage = storage;
  globalThis.document = { cookie: scope ? `usernode_api_scope=${scope}` : '' };
  globalThis.window = { location: { search: '', hash: '' } };
  return {
    storage,
    signIn(next) { globalThis.document.cookie = next ? `usernode_api_scope=${next}` : ''; },
    demo(on) { globalThis.window.location.search = on ? '?demo=1' : ''; },
    keys: () => [...storage.map.keys()],
  };
}

// ── 1. The store of copies ───────────────────────────────────────────────

test('a copy is read back only for the session it was kept for, and goes when the session does', (t) => {
  const b = browser(t);
  const kept = loadTsx(KEPT);
  kept.keepCopy('conversations', { conversations: [{ id: 1 }] });
  assert.deepEqual(kept.keptCopy('conversations'), { conversations: [{ id: 1 }] });

  b.signIn(BEA);
  assert.equal(kept.keptCopy('conversations'), null, 'another account on this device reads nothing');
  assert.ok(!b.keys().some((key) => key.includes('conversations')), 'and the first use under it forgot the last one\'s copies');

  b.signIn(null);
  kept.keepCopy('conversations', { conversations: [] });
  assert.equal(kept.keptCopy('conversations'), null, 'nobody signed in: nothing kept, nothing read');

  b.signIn(BEA);
  kept.keepCopy('conversations', { conversations: [{ id: 2 }] });
  b.demo(true);
  assert.equal(kept.keptCopy('conversations'), null, 'a staging demo\'s made-up rows are kept apart from the real ones');
  b.demo(false);
  assert.deepEqual(kept.keptCopy('conversations'), { conversations: [{ id: 2 }] });

  assert.equal(kept.keptCopy('conversations', Date.now() + kept.KEPT_MAX_AGE_MS + 1000), null, 'too old to draw');
  assert.equal(kept.keptCopy('conversations'), null, 'and forgotten once found too old');

  kept.keepCopy('big', 'x'.repeat(kept.KEPT_MAX_CHARS));
  assert.equal(kept.keptCopy('big'), null, 'a copy past the size limit is not kept');

  kept.keepCopy('ai:work', { next: [] });
  assert.equal(globalThis.window.UsernodeReact.keptCopies.clear, kept.forgetKeptCopies, 'the bridge app.js clears it through');
  globalThis.window.UsernodeReact.keptCopies.clear();
  assert.deepEqual(b.keys(), [], 'a sign-out forgets everything kept');
  // App._dropCachedSession: the sign-out, a session that ended, another tab's.
  const drop = read('public/js/app.js');
  // Found by name, not by its whole signature: its options grow.
  const body = drop.slice(drop.indexOf('  _dropCachedSession('), drop.indexOf('  _sessionFromSnapshot: false,'));
  assert.match(body, /window\.UsernodeReact\?\.keptCopies\?\.clear\?\.\(\);/);
});

test('only the conversations opened last are kept', (t) => {
  const b = browser(t);
  const kept = loadTsx(KEPT);
  for (const id of [1, 2, 3]) {
    kept.keepCopy(`conversation:${id}:page`, { id });
    kept.keepRecent('conversation', id, 2);
  }
  kept.keepRecent('conversation', 2, 2);
  assert.equal(kept.keptCopy('conversation:1:page'), null, 'the oldest is forgotten');
  assert.deepEqual(kept.keptCopy('conversation:2:page'), { id: 2 });
  assert.deepEqual(kept.keptCopy('conversation:3:page'), { id: 3 });
  kept.forgetKept('conversation:3:');
  assert.equal(kept.keptCopy('conversation:3:page'), null);
  assert.ok(b.keys().every((key) => key.startsWith('usernode:kept:')), 'every key is the store\'s own');
});

test('all copies together stay under their budget, so boot state on the origin always has room', (t) => {
  const b = browser(t);
  const kept = loadTsx(KEPT);
  // About a quarter of WebKit's ~2.5M characters for the origin, and a
  // page of the bot's 50 heaviest messages fits one entry.
  assert.equal(kept.KEPT_TOTAL_CHARS, 600_000);
  assert.equal(kept.KEPT_MAX_CHARS, 150_000);
  const total = () => b.keys().reduce((sum, key) => sum + key.length + globalThis.localStorage.getItem(key).length, 0);
  const page = (fill) => 'p'.repeat(140_000 - fill);
  for (let id = 1; id <= 12; id += 1) {
    kept.keepCopy(`conversation:${id}:page`, page(id));
    kept.keepRecent('conversation', id, 6);
    assert.ok(total() <= kept.KEPT_TOTAL_CHARS, `under the budget after conversation ${id}: ${total()}`);
  }
  kept.keepCopy('conversations', page(0));
  assert.ok(total() <= kept.KEPT_TOTAL_CHARS);
  assert.ok(kept.keptCopy('conversations'), 'the list made room for itself');
});

test('past the budget, the conversations opened longest ago go first, never the one being kept', (t) => {
  const b = browser(t);
  const kept = loadTsx(KEPT);
  const big = 'x'.repeat(140_000);
  for (const id of [1, 2, 3, 4]) {
    kept.keepCopy(`conversation:${id}:page`, big);
    kept.keepRecent('conversation', id, 6);
  }
  // Opened again: 1 is the most recent now, 2 the least.
  kept.keepRecent('conversation', 1, 6);
  kept.keepCopy('conversation:5:page', big);
  kept.keepRecent('conversation', 5, 6);
  const present = (id) => !!kept.keptCopy(`conversation:${id}:page`);
  assert.deepEqual([1, 2, 3, 4, 5].map(present), [true, false, true, true, true], 'the least recent, 2, made room');
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('usernode:kept:conversation:recent')), ['5', '1', '4', '3']);

  // The one being kept is never evicted to make room for itself: its
  // second part does not fit beside the rest, so it is not kept.
  kept.forgetKeptCopies();
  const alone = kept;
  for (const name of ['big1', 'big2', 'big3']) alone.keepCopy(name, big);
  alone.keepCopy('conversation:7:page', big);
  alone.keepRecent('conversation', 7, 6);
  alone.keepCopy('conversation:7:detail', big);
  assert.ok(alone.keptCopy('conversation:7:page'), 'its page stays');
  assert.equal(alone.keptCopy('conversation:7:detail'), null, 'and the part with no room is not kept');

  // Nothing to evict and no room: not kept, and its older copy goes.
  alone.keepCopy('note', 'small');
  assert.equal(alone.keptCopy('note'), 'small');
  alone.forgetKept('conversation:7:');
  alone.keepCopy('big4', big);
  alone.keepCopy('note', big);
  assert.equal(alone.keptCopy('note'), null, 'an older copy is never drawn as current');
  assert.ok(b.keys().every((key) => key.startsWith('usernode:kept:')));
});

// ── 2. What Messages' reads keep ─────────────────────────────────────────

function serverMessage(id) {
  return { id, conversation_id: 42, sender: { id: 9, username: 'ana' }, content: `m${id}`, created_at: '2026-11-02T12:00:00Z' };
}

function answering(routes) {
  return async (url) => {
    const pathOnly = String(url);
    for (const [prefix, body] of routes) {
      if (pathOnly.startsWith(prefix)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
}

test('the inbox and a conversation\'s newest page are kept as sent, and drawn again normalized', async (t) => {
  browser(t);
  const ana = { id: 9, username: 'ana', status: 'member' };
  const dm = { id: 42, kind: 'direct', title: '', membership_status: 'member', members: [ana], peer: ana };
  const page = Array.from({ length: 60 }, (_, i) => serverMessage(i + 1));
  globalThis.fetch = answering([
    ['/api/conversations/42/messages', { messages: page, next_before: null }],
    ['/api/conversations/42', { conversation: dm }],
    ['/api/conversations', { conversations: [dm, { ...dm, id: 43 }] }],
  ]);
  const api = loadTsx(API);
  assert.equal(api.keptConversations(), null, 'nothing kept yet');
  await api.listConversations();
  await api.getConversation(42);
  await api.listMessages(42, null, undefined, 100);
  assert.deepEqual(api.keptConversations().map((item) => item.id), [42, 43]);
  const conversation = api.keptConversation(42);
  assert.equal(conversation.detail.id, 42);
  assert.equal(conversation.detail.title, 'ana', 'normalized as a fresh answer is');
  assert.equal(conversation.page.messages.length, 50, 'the newest 50 of a page of 60');
  assert.deepEqual([conversation.page.messages[0].id, conversation.page.messages.at(-1).id], [11, 60]);
  assert.equal(conversation.page.nextBefore, 11, 'and the older ones are a page to read when online');

  // An older page is not the one an offline open draws.
  globalThis.fetch = answering([['/api/conversations/42/messages', { messages: [serverMessage(1)], next_before: null }]]);
  await api.listMessages(42, 5);
  assert.equal(api.keptConversation(42).page.messages.length, 50);

  // Left, or taken away by a block: its copies go, and its row.
  api.forgetKeptConversation(42);
  assert.equal(api.keptConversation(42), null);
  assert.deepEqual(api.keptConversations().map((item) => item.id), [43]);

  // At most six conversations.
  globalThis.fetch = answering([['/api/conversations/', { conversation: dm }]]);
  for (const id of [101, 102, 103, 104, 105, 106, 107]) await api.getConversation(id);
  const keptIds = [101, 102, 103, 104, 105, 106, 107].filter((id) => globalThis.localStorage.getItem(`usernode:kept:conversation:${id}:detail`));
  assert.deepEqual(keptIds, [102, 103, 104, 105, 106, 107]);
});

test('signed out, nothing is kept', async (t) => {
  const b = browser(t, { scope: null });
  globalThis.fetch = answering([['/api/conversations', { conversations: [{ id: 1, kind: 'direct' }] }]]);
  const api = loadTsx(API);
  await api.listConversations();
  assert.deepEqual(b.keys(), []);
});

// ── 3. The store: a read with no answer ──────────────────────────────────

function storeHarness(t, overrides = {}) {
  const saved = ['window', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  class MessagesApiError extends Error {
    constructor(status, text) { super(text); this.status = status; }
  }
  const ME = { id: 7, username: 'evan' };
  const ANA = { id: 9, username: 'ana', status: 'member' };
  const dm = {
    id: 42, kind: 'direct', title: 'ana', untitled: false, membershipStatus: 'member', canSend: true,
    members: [{ ...ME, status: 'member' }, ANA], peer: ANA, unreadCount: 0, memberCount: 2,
    lastActivityAt: '2026-11-02T12:00:00Z',
  };
  const api = {
    MessagesApiError,
    strictId: (value) => (Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [dm],
    getConversation: async () => dm,
    listMessages: async () => ({ messages: [], nextBefore: null }),
    markRead: async () => {},
    keptConversations: () => null,
    keptConversation: () => null,
    forgetKeptConversation: () => {},
    ...overrides,
  };
  let snapshot = null;
  const react = { useSyncExternalStore: (_subscribe, get) => { snapshot = get; return get(); } };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  const store = loadTsx(STORE, { stubs: { './api': api, react } });
  store.useMessagesSnapshot();
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return { store, api, dm, state: () => snapshot(), flush, MessagesApiError };
}

test('the inbox with no answer: the one this device kept, or plain words, never the exception', async (t) => {
  const offline = async () => { throw new TypeError(WEBKIT_FAILURE); };
  const kept = storeHarness(t, { listConversations: offline });
  kept.api.keptConversations = () => [kept.dm];
  await kept.store.loadConversations(true);
  assert.deepEqual(kept.state().conversations.map((item) => item.id), [42], 'the kept list is drawn');
  assert.equal(kept.state().error, null, 'with nothing over it');

  const none = storeHarness(t, { listConversations: offline });
  await none.store.loadConversations(true);
  assert.equal(none.state().error, message('messages:store.error.unreachableList'));
  assert.doesNotMatch(none.state().error, /TypeError|FetchEvent/);

  const down = storeHarness(t);
  down.api.listConversations = async () => { throw new down.MessagesApiError(503, 'Messages are resting.'); };
  await down.store.loadConversations(true);
  assert.equal(down.state().error, 'Messages are resting.', 'the server\'s own sentence still shows');
  down.api.keptConversations = () => [down.dm];
  down.store.messagesController.refresh();
  await down.flush();
  assert.deepEqual(down.state().conversations.map((item) => item.id), [42], 'a server that is down draws the kept list too');
  assert.equal(down.state().error, null);

  const refused = storeHarness(t);
  refused.api.listConversations = async () => { throw new refused.MessagesApiError(403, 'Not for you.'); };
  refused.api.keptConversations = () => [refused.dm];
  await refused.store.loadConversations(true);
  assert.equal(refused.state().error, 'Not for you.');
  assert.deepEqual(refused.state().conversations, [], 'and an answer is never covered by a kept copy');
});

test('a conversation with no answer and nothing kept keeps its name in the header, and says why in words', async (t) => {
  const h = storeHarness(t, { getConversation: async () => { throw new TypeError(WEBKIT_FAILURE); } });
  await h.store.loadConversations(true);
  h.store.messagesController.route(42);
  await h.flush();
  const snap = h.state();
  assert.equal(snap.active?.id, 42, 'the inbox row still names the conversation');
  assert.equal(snap.threadError, message('messages:store.error.unreachableThread'));
  assert.deepEqual(snap.messages, []);
  // The header draws from `active`; the composer is not drawn under a conversation that did not load.
  assert.match(read('frontend/src/features/messages/composer.tsx'),
    /if \(!inThread && snap\.threadError && !snap\.messages\.length\) return null;/);

  // Opened cold, before the list is in memory: the kept list names it.
  const cold = storeHarness(t, {
    listConversations: async () => { throw new TypeError(WEBKIT_FAILURE); },
    getConversation: async () => { throw new TypeError(WEBKIT_FAILURE); },
  });
  cold.api.keptConversations = () => [cold.dm];
  cold.store.messagesController.route(42);
  await cold.flush();
  assert.equal(cold.state().active?.title, 'ana');

  // A 404 is an answer: no conversation to name.
  const gone = storeHarness(t);
  gone.api.getConversation = async () => { throw new gone.MessagesApiError(404, 'Conversation not found'); };
  await gone.store.loadConversations(true);
  gone.store.messagesController.route(42);
  await gone.flush();
  assert.equal(gone.state().active, null);
  assert.equal(gone.state().threadGone, 'missing');
});

test('a conversation with no answer draws what this device kept of it, and nothing more', async (t) => {
  const reads = [];
  const h = storeHarness(t, {
    getConversation: async (id, options) => { reads.push(options); throw new TypeError(WEBKIT_FAILURE); },
  });
  const rows = [3, 1, 2].map((id) => ({
    id, conversationId: 42, sender: { id: 9, username: 'ana' }, content: `m${id}`, createdAt: '2026-11-02T12:00:00Z',
    reactions: [], attachments: [], objects: [],
  }));
  h.api.keptConversation = (id) => (id === 42 ? { detail: h.dm, page: { messages: rows, nextBefore: 1 } } : null);
  let marked = 0;
  h.api.markRead = async () => { marked += 1; };
  h.store.messagesController.route(42);
  await h.flush();
  const snap = h.state();
  assert.equal(reads.length, 1, 'one read: the worker holds no copy to read again for');
  assert.deepEqual(snap.messages.map((item) => item.content), ['m1', 'm2', 'm3']);
  assert.equal(snap.threadError, null);
  assert.equal(snap.nextBefore, 1, 'older messages are there to read once online');
  assert.equal(snap.unreadMark, null, 'no "New" line from a copy');
  assert.equal(marked, 0, 'and nothing marked read from it');
});

test('every failure a person reads is in words: an exception\'s message never reaches the screen', () => {
  const src = read(STORE);
  const helper = src.slice(src.indexOf('function errorMessage('), src.indexOf('function unreachable('));
  assert.ok(!/error\.message : fallback/.test(helper), 'a non-answer is the fallback sentence, not the exception');
  for (const id of ['messages:store.error.unreachableList', 'messages:store.error.unreachableThread', 'messages:ai.work.unreachable', 'messages:ai.work.failed']) {
    assert.ok(message(id) && !/TypeError|Error:/.test(message(id)), id);
  }
});

// ── 4. The Homeroom bot tab ──────────────────────────────────────────────

test('the bot tab says why Needs you is empty, with Try again, instead of an empty card', () => {
  const props = (extra) => ({
    hero: null, main: { lit: false, unread: 0, open() {} }, lit: null, ready: false, rows: [], owed: 0,
    progress: [], waiting: [], live: [], openRow() {}, openThread() {}, onRetry() {}, ...extra,
  });
  const offline = renderComponent(LISTS, 'AiLists', props({ failed: 'unreachable' }));
  assert.match(offline, /data-ai-failed="unreachable"/);
  assert.ok(offline.includes(message('messages:ai.work.unreachable')), 'the offline words');
  assert.match(offline, /data-ai-retry="">Try again<\/button>/);
  const failed = renderComponent(LISTS, 'AiLists', props({ failed: 'failed' }));
  assert.ok(failed.includes(message('messages:ai.work.failed')));
  const nothing = renderComponent(LISTS, 'AiLists', props({ ready: true, failed: null }));
  assert.ok(nothing.includes(message('messages:ai.work.empty')), 'read, and empty: nothing needs you');
  assert.doesNotMatch(nothing, /data-ai-failed/);
  // Still said over rows that did arrive (the other list's).
  const some = renderComponent(LISTS, 'AiLists', props({
    failed: 'unreachable',
    rows: [{ key: 'private:1', title: 'An idea', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 1 }],
  }));
  assert.ok(some.indexOf('data-ai-failed') < some.indexOf('An idea'));
});

test('the bot tab keeps its lists for an offline showing, and opens Main on the chat it knows', () => {
  const src = read(AI);
  assert.match(src, /keepCopy\('ai:work', read\.data\);/);
  assert.match(src, /const kept = keptCopy<AiWork>\('ai:work'\);/);
  assert.match(src, /keepCopy\('ai:needs', items\);/);
  assert.match(src, /const kept = keptCopy<NeedItem\[\]>\('ai:needs'\);/);
  assert.match(src, /setFailed\(!missing\.length \? null : missing\.some\(\(read\) => !read\.reached\) \? 'unreachable' : 'failed'\);/);
  assert.match(src, /failed=\{failed\}\s+onRetry=\{\(\) => setMoved\(\(n\) => n \+ 1\)\}/);
  // The bot's chat: its POST has no answer offline, so the id comes from
  // what Messages knows, or kept.
  assert.match(src, /\.catch\(\(\) => \{[\s\S]{0,300}knownBotConversation\(\)\s+\|\| keptConversations\(\)\?\.find\(\(item\) => item\.homeroomBot && item\.kind !== 'channel'\)\?\.id/);
});

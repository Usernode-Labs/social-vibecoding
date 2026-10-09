'use strict';

// Two reports from the Homeroom bot's DM, filed together by the platform
// admin and fixed together because they were one fault:
//
//   #3705 — a DM from the bot arrives while Messages is already open, and it
//           does not show until the page is reloaded.
//   #3706 — a message sent to the bot shows, then disappears; a reload shows
//           it and the bot's reply.
//
// Realtime carries ids only, so every event re-reads the open conversation
// through the API (frontend/src/features/messages/store.ts handleEvent). That
// read was an ordinary GET /api/*, which the service worker answers from its
// offline copy once the network has taken a second (public/sw.js,
// API_TIMEOUT_MS). The bot's DM is the slowest page to read — every card on
// it was hydrated with its own GitHub request, one after another — so its
// re-read lost that race, and the copy it got back was the transcript from
// before the change: no new message, and the store, taking it as the server's
// word, dropped the sender's own confirmed row. Nothing on the Messages screen
// listened for the worker's late correction, and a reconnect re-read only the
// inbox, never the open conversation. Separately, a pending send was matched
// to the OLDEST message with the same words, and the bot's suggested answers
// repeat the same words every time.
//
// The fixes, each pinned below: a re-read after a change asks the server
// (`cache: 'no-store'`, which the worker leaves alone); a page older than a
// confirmed send keeps it; a pending send matches only a message newer than
// itself; a reconnect and the worker's correction re-read the conversation on
// screen; and a page hydrates each distinct card once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const github = require('../src/services/github');
const sharedObjects = require('../src/services/shared-objects');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ORIGIN = 'https://social-vibecoding.example';

// ── The store, run against a stubbed API ─────────────────────────────────

const ME = { id: 7, username: 'evan', avatarUrl: null };
const BOT = { id: 99, username: 'homeroom-bot', avatarUrl: null, bot: true };
const DM = {
  id: 42, kind: 'direct', title: 'homeroom-bot', membershipStatus: 'member', canSend: true,
  members: [ME, BOT], unreadCount: 0, lastActivityAt: new Date(Date.UTC(2026, 9, 2)).toISOString(),
};

function serverMessage(id, sender, content) {
  return {
    id, conversationId: 42, sender, content, createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, id)).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [],
  };
}

function harness(initial) {
  const server = {
    messages: initial.map((item) => ({ ...item })),
    nextId: initial.reduce((top, item) => Math.max(top, item.id), 0) + 1,
    // A page from before the change: what the worker's offline copy was, or
    // what a read already in flight when the change landed brings back.
    stale: null,
    reads: [],
  };
  const deferred = [];
  const api = {
    MessagesApiError: class extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async (options) => { server.reads.push(['list', options]); return [DM]; },
    getConversation: async (id, options) => { server.reads.push(['conversation', options]); return DM; },
    listMessages: async (id, before, options) => {
      server.reads.push(['messages', options]);
      return { messages: (server.stale || server.messages).map((item) => ({ ...item })), nextBefore: null };
    },
    markRead: async () => {},
    sendMessage: (id, payload) => new Promise((resolve) => {
      deferred.push(() => {
        // Idempotent, as services/conversations.js is: the same key is one row.
        const existing = server.messages.find((item) => item.key === payload.idempotencyKey);
        if (existing) { resolve({ ...existing }); return; }
        const message = { ...serverMessage(server.nextId++, ME, payload.content), key: payload.idempotencyKey };
        server.messages.push(message);
        resolve({ ...message });
      });
    }),
  };
  let snapshot = null;
  const react = { useSyncExternalStore: (subscribe, get) => { snapshot = get; return get(); } };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  // The app-discussions read is a plain fetch beside the stubbed API.
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react } });
  store.useMessagesSnapshot();
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const settle = async () => { while (deferred.length) deferred.shift()(); await flush(); };
  const state = () => snapshot();
  const contents = () => state().messages.map((item) => item.content);
  const event = async (messageId) => {
    store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId });
    await flush();
  };
  return { store, server, api, state, contents, flush, settle, event };
}

async function openDm(h) {
  h.store.messagesController.route(42);
  await h.flush();
  assert.ok(h.state().messages.length, 'the DM loaded');
}

function assertKeysUnique(rows) {
  const keys = rows.map((item) => String(item.clientKey || item.id));
  assert.equal(new Set(keys).size, keys.length, `every row has its own React key: ${keys.join(', ')}`);
}

test('#3705: a re-read after a realtime event asks the server, never the worker\'s offline copy', async () => {
  const h = harness([serverMessage(1, BOT, 'I build things for you on Homeroom.')]);
  await openDm(h);
  const opening = h.server.reads.splice(0);
  assert.ok(opening.some(([what]) => what === 'messages'), 'the open read the transcript');
  for (const [what, options] of opening.filter(([w]) => w !== 'list')) {
    assert.equal(options?.fresh, true, `an open while online reads the server, not the last visit's offline copy (${what}, #4243)`);
  }

  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Your request is up for a vote.'));
  await h.event(2);
  const after = h.server.reads.splice(0);
  for (const what of ['conversation', 'messages', 'list']) {
    assert.ok(after.some(([w, options]) => w === what && options?.fresh === true), `the ${what} read is fresh`);
  }
  assert.deepEqual(h.contents(), ['I build things for you on Homeroom.', 'Your request is up for a vote.']);
});

test('#4243: an open reads the offline copy only when offline, or once the fresh read failed', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  const offline = harness([serverMessage(1, BOT, 'Hello.')]);
  await openDm(offline);
  for (const [what, options] of offline.server.reads.filter(([w]) => w !== 'list')) {
    assert.ok(!options?.fresh, `offline, the open takes the worker's copy (${what})`);
  }

  globalThis.navigator.onLine = true;
  const failing = harness([serverMessage(1, BOT, 'Hello.')]);
  const getConversation = failing.api.getConversation;
  let failures = 1;
  failing.api.getConversation = async (id, options) => {
    if (options?.fresh && failures-- > 0) { failing.server.reads.push(['conversation', options]); throw new TypeError('Failed to fetch'); }
    return getConversation(id, options);
  };
  await openDm(failing);
  const reads = failing.server.reads.filter(([w]) => w === 'conversation').map(([, options]) => !!options?.fresh);
  assert.deepEqual(reads, [true, false], 'the fresh read failed, so the open read again and took the copy');
  assert.equal(failing.state().threadError, null, 'and drew it, with no error');
});

test('#4220: the bot stays "typing" until the message it sent is drawn, and no longer than the cap', async (t) => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  const timers = [];
  Object.assign(globalThis.window, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  const dm = {
    ...DM,
    members: [{ ...ME, status: 'member' }, { ...BOT, status: 'member' }],
    peer: { id: BOT.id, bot: true, displayName: 'Homeroom bot' },
  };
  h.api.getConversation = async () => dm;
  await openDm(h);
  const typing = (on) => h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: on });

  typing(true);
  assert.deepEqual(h.state().typing[42].map((typist) => typist.name), ['Homeroom bot']);
  // The answer's re-read is slow: hold it until the test lets it go.
  const listMessages = h.api.listMessages;
  let release;
  h.api.listMessages = (...args) => new Promise((resolve) => { release = () => resolve(listMessages(...args)); });
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Done: it is up for a vote.'));
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: 2 });
  await h.flush();
  typing(false);
  assert.deepEqual(h.state().typing[42].map((typist) => typist.name), ['Homeroom bot'], 'the stop waits for the message it typed');
  release();
  await h.flush();
  assert.ok(h.contents().includes('Done: it is up for a vote.'), 'the message is drawn');
  assert.deepEqual(h.state().typing[42], [], 'and the line goes with it');

  // A read that never comes back lets the line go at the cap.
  typing(true);
  h.api.listMessages = () => new Promise(() => {});
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: 3 });
  await h.flush();
  typing(false);
  assert.deepEqual(h.state().typing[42].map((typist) => typist.name), ['Homeroom bot']);
  const cap = timers.filter((timer) => timer.live && timer.ms === 5000);
  assert.equal(cap.length, 1, 'one cap of about five seconds');
  cap[0].fn();
  assert.deepEqual(h.state().typing[42], [], 'the cap clears it');
});

test('#4220: a stop with no new message on its way clears the line at once', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  Object.assign(globalThis.window, { setTimeout: () => 1, clearTimeout: () => {} });
  const dm = { ...DM, members: [{ ...ME, status: 'member' }, { ...BOT, status: 'member' }] };
  h.api.getConversation = async () => dm;
  await openDm(h);
  h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: true });
  assert.equal(h.state().typing[42].length, 1);
  h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: false });
  assert.deepEqual(h.state().typing[42], []);
});

test('a typist is kept by user id, and "no username" comes and goes with that person alone', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  const timers = [];
  Object.assign(globalThis.window, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  // A member whose username did not come with the row (the normalizer's
  // stand-in and flag), and an account really called "unknown".
  const NAMELESS = { id: 11, username: 'unknown', unnamed: true, avatarUrl: null, status: 'member' };
  const REAL = { id: 12, username: 'unknown', avatarUrl: null, status: 'member' };
  const ADA = { id: 13, username: 'ada', avatarUrl: null, status: 'member' };
  const group = { ...DM, kind: 'group', title: 'Crew', members: [{ ...ME, status: 'member' }, NAMELESS, REAL, ADA] };
  h.api.getConversation = async () => group;
  await openDm(h);
  const typing = (userId, on) => h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId, typing: on });
  const line = () => h.state().typing[42].map((typist) => [typist.userId, typist.name, typist.unnamed]);

  // Two people shown by the same word are two typists, each with its own flag.
  typing(NAMELESS.id, true);
  typing(REAL.id, true);
  assert.deepEqual(line(), [[11, 'unknown', true], [12, 'unknown', false]]);
  // A renewal keeps the place and the flag.
  typing(NAMELESS.id, true);
  assert.deepEqual(line(), [[11, 'unknown', true], [12, 'unknown', false]]);
  // The nameless member stops: the flag goes with them.
  typing(NAMELESS.id, false);
  assert.deepEqual(line(), [[12, 'unknown', false]]);
  typing(REAL.id, false);
  assert.deepEqual(line(), []);
  // Later the real account types alone: named, though a nameless member typed before.
  typing(REAL.id, true);
  assert.deepEqual(line(), [[12, 'unknown', false]]);
  typing(REAL.id, false);
  // Expiry removes the person it was set for, flag and all.
  typing(NAMELESS.id, true);
  typing(ADA.id, true);
  const expiry = timers.filter((timer) => timer.live && timer.ms === 6000);
  assert.equal(expiry.length, 2);
  expiry[0].fn();
  assert.deepEqual(line(), [[13, 'ada', false]]);
  typing(REAL.id, true);
  assert.deepEqual(line(), [[13, 'ada', false], [12, 'unknown', false]]);
  // The line reads the flag carried with each typist, never the word.
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /if \(typing\.length === 1\) return first\.unnamed \? t\('messages:thread\.typingOneUnknown'\) : t\('messages:thread\.typingOne', \{ name: first\.name \}\);/);
  assert.doesNotMatch(read('frontend/src/features/messages/store.ts'), /unnamedTypists/);
});

test('#3706: a page read before the send landed does not take the sender\'s message away', async () => {
  const h = harness([serverMessage(1, BOT, 'What should the button say?')]);
  await openDm(h);
  const before = h.server.messages.map((item) => ({ ...item }));
  const sending = h.store.send({ content: 'Save draft' });
  await h.settle();
  await sending;
  assert.deepEqual(h.contents(), ['What should the button say?', 'Save draft'], 'confirmed');
  const key = h.state().messages[1].clientKey;

  // The echo's re-read comes back with the transcript from before the send.
  h.server.stale = before;
  await h.event(2);
  assert.deepEqual(h.contents(), ['What should the button say?', 'Save draft'],
    'the confirmed message stays on screen');
  assert.equal(h.state().messages[1].clientKey, key, 'in place, under the key it was drawn with');

  // The bot answers; the next page holds both, and each is drawn once.
  h.server.stale = null;
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Thanks. I posted your answer.'));
  await h.event(3);
  assert.deepEqual(h.contents(), ['What should the button say?', 'Save draft', 'Thanks. I posted your answer.']);
  assert.equal(h.state().messages[1].clientKey, key);
  assertKeysUnique(h.state().messages);
});

test('#3706: a confirmed message is let go once a newer page has moved past it', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello')]);
  await openDm(h);
  const sending = h.store.send({ content: 'hi' });
  await h.settle();
  await sending;
  // A page that reaches past the row and does not hold it (it was removed by
  // the server) is the server's word: the row is not kept forever.
  h.server.messages = [serverMessage(1, BOT, 'Hello'), serverMessage(5, BOT, 'Later news')];
  await h.event(5);
  assert.deepEqual(h.contents(), ['Hello', 'Later news']);
});

test('#3706: a repeated answer takes its own server copy, not the oldest message with the same words', async () => {
  const h = harness([
    serverMessage(1, BOT, 'Should the button be blue?'),
    serverMessage(2, ME, 'Yes'),
    serverMessage(3, BOT, 'Should it be round?'),
  ]);
  await openDm(h);
  const sending = h.store.send({ content: 'Yes' });
  const key = h.state().messages.at(-1).clientKey;
  assert.ok(key);

  // The server stored it and its echo re-reads the DM before the POST returns.
  h.server.messages.push({ ...serverMessage(h.server.nextId++, ME, 'Yes'), key });
  await h.event(4);
  let rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.id), [1, 2, 3, 4]);
  assert.equal(rows[3].clientKey, key, 'the new answer takes the row\'s key');
  assert.equal(rows[1].clientKey, undefined, 'the earlier "Yes" keeps its own');

  await h.settle();
  await sending;
  rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.id), [1, 2, 3, 4], 'neither answer leaves the screen');
  assertKeysUnique(rows);

  await h.event(4);
  rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.content), ['Should the button be blue?', 'Yes', 'Should it be round?', 'Yes']);
  assertKeysUnique(rows);
});

test('#3705: a reconnect re-reads the conversation on screen, and only the inbox otherwise', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello')]);
  await openDm(h);
  assert.equal(h.store.messagesController.showing(), true);

  // The bot wrote while the events socket was down: no event ever arrives.
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Your proposal was merged.'));
  h.server.reads.length = 0;
  await h.store.messagesController.resync();
  await h.flush();
  assert.deepEqual(h.contents(), ['Hello', 'Your proposal was merged.']);
  assert.ok(h.server.reads.some(([what, options]) => what === 'messages' && options?.fresh), 'read from the server');

  h.store.messagesController.close();
  assert.equal(h.store.messagesController.showing(), false);
  h.server.reads.length = 0;
  await h.store.messagesController.resync();
  assert.deepEqual(h.server.reads.map(([what]) => what), ['list'], 'the badge, and nothing it is not drawing');
});

test('#8 (WP3): the resync of the conversation on screen also reads the bot\'s tray and cards again', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello')]);
  await openDm(h);
  const dispatched = [];
  globalThis.window.dispatchEvent = (event) => { dispatched.push(event.type); return true; };
  await h.store.messagesController.resync();
  assert.deepEqual(dispatched, ['homeroom-bot-work-changed'], 'the window event the tray and the cards re-read on, fresh');
  h.store.messagesController.close();
  dispatched.length = 0;
  await h.store.messagesController.resync();
  assert.deepEqual(dispatched, [], 'nothing of the bot\'s is drawn: nothing to read');
});

// ── The wire: what a fresh read asks the browser for ────────────────────

test('a fresh read is `cache: no-store`; an ordinary one is not', async (t) => {
  const seen = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    seen.push({ url, cache: init.cache });
    return { ok: true, json: async () => ({ messages: [], conversations: [], conversation: { id: 42 } }) };
  };
  const api = loadTsx('frontend/src/features/messages/api.ts');
  await api.listMessages(42);
  await api.listMessages(42, null, { fresh: true });
  await api.getConversation(42, { fresh: true });
  await api.listConversations({ fresh: true });
  await api.listThread(42, 9, null, { fresh: true });
  await api.listMessagesAround(42, 5, { fresh: true });
  assert.equal(seen[0].cache, undefined, 'an ordinary read (an open offline, or after a failed fresh one) is left to the worker');
  for (const call of seen.slice(1)) assert.equal(call.cache, 'no-store', call.url);
});

test('the service worker leaves a no-store Messages read to the network', () => {
  // What the fresh reads rely on. An ordinary read of the transcript races the
  // worker's offline copy; a no-store one is never intercepted at all.
  const handlers = {};
  vm.runInNewContext(read('public/sw.js'), {
    self: { location: { origin: ORIGIN }, addEventListener(name, fn) { handlers[name] = fn; } },
    URL, Headers, Response, Map, Set, Promise,
    caches: { open() { throw new Error('no cache in this test'); } },
    fetch() { throw new Error('no network in this test'); },
    setTimeout() {}, clearTimeout() {},
  });
  const intercepted = (cache) => {
    let responded = false;
    handlers.fetch({
      request: {
        method: 'GET', url: `${ORIGIN}/api/conversations/42/messages?limit=50`, cache, mode: 'cors',
        headers: new Headers({ accept: 'application/json' }),
      },
      respondWith(answer) { responded = true; Promise.resolve(answer).catch(() => {}); },
      waitUntil() {},
    });
    return responded;
  };
  assert.equal(intercepted('default'), true, 'an ordinary read is the worker\'s to answer');
  assert.equal(intercepted('no-store'), false, 'a fresh read goes to the server');
});

// ── The screen's two other re-reads ──────────────────────────────────────

test('a reconnect and the worker\'s late correction both re-read the open conversation', () => {
  const app = read('public/js/app.js');
  const resyncStart = app.indexOf('  resyncCurrentView() {');
  const resync = app.slice(resyncStart, app.indexOf('// #1038:', resyncStart));
  assert.match(resync, /window\.UsernodeReact\?\.messages\?\.resync\?\.\(\);/, 'on reconnect');
  assert.doesNotMatch(resync, /messages\?\.refresh\?\.\(\)/, 'not the inbox alone');

  const loader = app.slice(app.indexOf('  refreshActiveScreen() {'), app.indexOf('_refreshLeaderboard() {'));
  const messagesAt = loader.search(/if \(messages\?\.showing\?\.\(\)\) messages\.resync\?\.\(\);/);
  assert.ok(messagesAt > 0, 'the correction re-reads Messages when it is on screen');
  assert.ok(messagesAt < loader.indexOf('return;', loader.indexOf('const visible')),
    'before any branch that returns, so an app left open behind Messages cannot swallow it');
});

// ── The page the bot's DM reads ──────────────────────────────────────────

test('a page hydrates each distinct card once, however many messages carry it', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  const asked = [];
  github.fetchPublicIssue = async (owner, repo, number) => {
    asked.push(number);
    return { issue: { number, title: `Request ${number}`, state: 'closed', author: 'evan' } };
  };
  const card = (id, messageId, issueNumber) => ({
    id, message_id: messageId, position: 0, object_type: 'github_issue', app_id: 7, object_ref: issueNumber, object_version: null,
  });
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM conversation_message_objects')) {
        return { rows: [card(1, 10, 3705), card(2, 11, 3705), card(3, 12, 3706), card(4, 13, 3705)] };
      }
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (sql.includes('FROM apps WHERE id = $1')) {
        return { rows: [{
          id: 7, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/example/demo.git',
          view_visibility: 'public', collab_visibility: 'public',
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const cards = await sharedObjects.hydrateForMessages(pool, { id: 3, isAdmin: false }, [10, 11, 12, 13]);
  assert.deepEqual(asked.sort(), [3705, 3706], 'one GitHub read per distinct request, not per message');
  for (const [messageId, issueNumber] of [[10, 3705], [11, 3705], [12, 3706], [13, 3705]]) {
    const [hydrated] = cards.get(messageId);
    assert.equal(hydrated.issueNumber, issueNumber);
    assert.equal(hydrated.title, `Request ${issueNumber}`);
    assert.equal(hydrated.available, true);
  }
  assert.notEqual(cards.get(10)[0], cards.get(11)[0], 'each message carries its own copy');
});

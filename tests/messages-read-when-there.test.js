'use strict';

// A message is read when somebody is there to read it (5 October, Page
// Turners run-through).
//
// Alex approved his project's first version from his chat with Homeroom bot
// at 11:51 and left the phone on that chat. At 11:55 "Page Turners is live"
// landed in it and was read on the spot: a conversation open on screen was
// read up to its newest message whenever one arrived, whoever was looking.
// Reading a conversation clears its bell rows and its Messages badge
// (services/conversations.js markRead), so when he came back at 12:12 the
// bell's Unread tab and the Messages tab said nothing about it.
//
// The store (frontend/src/features/messages/store.ts) now reads only with
// somebody there: the page visible and used in the last two minutes. A read
// that arrives otherwise waits for the next touch, key, scroll or return to
// the page, and is dropped if the conversation is no longer on screen.
// Opening a conversation is using the page, so it still reads at once.
//
// Run with: node --test tests/messages-read-when-there.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const ME = { id: 7, username: 'alex_t1005', avatarUrl: null };
const BOT = { id: 99, username: 'homeroom_bot', avatarUrl: null, bot: true };
const DM = {
  id: 42, kind: 'direct', title: 'Homeroom bot', membershipStatus: 'member', canSend: true,
  members: [ME, BOT], unreadCount: 0, lastActivityAt: new Date(Date.UTC(2026, 9, 5, 11, 48)).toISOString(),
};
const message = (id, content) => ({
  id, conversationId: 42, sender: BOT, content, createdAt: new Date(Date.UTC(2026, 9, 5, 11, 48, id)).toISOString(),
  reply: null, reactions: [], attachments: [], objects: [],
});

function harness(t) {
  const saved = ['window', 'document', 'fetch', 'localStorage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const realNow = Date.now;
  let stop = () => {};
  t.after(() => {
    stop();
    Date.now = realNow;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let clock = realNow();
  Date.now = () => clock;
  const server = { messages: [message(1, 'Page Turners is ready to try')] };
  const reads = [];
  const api = {
    MessagesApiError: class extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [DM],
    getConversation: async () => DM,
    listMessages: async () => ({ messages: server.messages.map((item) => ({ ...item })), nextBefore: null }),
    markRead: async (conversationId, messageId) => { reads.push([conversationId, messageId]); },
  };
  const listeners = new Map();
  const on = (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]); };
  const off = (type, fn) => { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener: on, removeEventListener: off, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: on, removeEventListener: off };
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const react = { useSyncExternalStore: (subscribe, get) => get() };
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react } });
  stop = store.initializeMessagesStore();
  const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const fire = (type) => { for (const fn of listeners.get(type) || []) fn({ type }); };
  const arrives = async (id, content) => {
    server.messages.push(message(id, content));
    store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: id });
    await flush();
  };
  const wait = (ms) => { clock += ms; };
  return { store, reads, flush, fire, arrives, wait };
}

test('opening the chat reads it at once; a message that lands while somebody is there is read too', async (t) => {
  const h = harness(t);
  await h.flush();
  h.store.messagesController.route(42);
  await h.flush();
  assert.deepEqual(h.reads, [[42, 1]], 'an open is somebody using the page');
  h.fire('pointerdown');
  h.wait(30 * 1000);
  await h.arrives(2, 'Page Turners is live');
  assert.deepEqual(h.reads.at(-1), [42, 2], 'used half a minute ago: they are there');
});

test('a message that lands on an unattended chat waits for them, and is read when they are back', async (t) => {
  const h = harness(t);
  await h.flush();
  h.store.messagesController.route(42);
  await h.flush();
  h.fire('pointerdown'); // 11:51, Approve.
  h.wait(4 * 60 * 1000); // Nobody touches the phone.
  await h.arrives(2, 'Page Turners, its first version. It\'s live now.');
  assert.deepEqual(h.reads, [[42, 1]], 'not read: its bell row and the Messages badge stay');
  h.fire('touchstart');
  await h.flush();
  assert.deepEqual(h.reads, [[42, 1], [42, 2]], 'read the moment they touch the screen it is on');
});

test('a hidden page reads nothing until it is shown again', async (t) => {
  const h = harness(t);
  await h.flush();
  h.store.messagesController.route(42);
  await h.flush();
  globalThis.document.visibilityState = 'hidden';
  await h.arrives(2, 'Page Turners is live');
  h.fire('pointermove');
  await h.flush();
  assert.deepEqual(h.reads, [[42, 1]], 'a background tab is nobody, even a moment after the last touch');
  globalThis.document.visibilityState = 'visible';
  h.fire('visibilitychange');
  await h.flush();
  assert.deepEqual(h.reads.at(-1), [42, 2], 'back on the page, with the chat in front of them');
});

test('a chat left before they came back stays unread', async (t) => {
  const h = harness(t);
  await h.flush();
  h.store.messagesController.route(42);
  await h.flush();
  h.wait(5 * 60 * 1000);
  await h.arrives(2, 'Page Turners is live');
  h.store.messagesController.close();
  h.fire('keydown');
  await h.flush();
  assert.deepEqual(h.reads, [[42, 1]], 'nobody saw it: it is still news in the bell and on the Messages tab');
});

'use strict';

// #2794: the Messages tab's badge (#platform-tabs-badge) counts conversations
// with something unread. It rendered from navStore.messages from the day the
// tab bar shipped (#2740), but nothing ever wrote that field, so the badge
// never appeared. The Messages store owns the per-conversation unreadCount,
// so it derives the badge from every write to its conversation list.
//
// This EXECUTES the store against a stubbed API and the real nav store, and
// walks the three moments the issue names: the list loading, a conversation
// being read, and a message arriving over the socket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const at = (n) => new Date(Date.UTC(2026, 8, 1, 12, n)).toISOString();
const row = (id, unreadCount, minute) => ({ id, unreadCount, lastActivityAt: at(minute) });

test('the Messages tab badge follows the unread conversations', async () => {
  let list = [row(1, 3, 3), row(2, 0, 2), row(3, 1, 1)];
  const readCalls = [];
  const api = {
    MessagesApiError: class MessagesApiError extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => list.map((item) => ({ ...item })),
    getConversation: async (id) => ({ ...list.find((item) => item.id === id), membershipStatus: 'member', members: [] }),
    listMessages: async (id) => ({ messages: [{ id: 10 * id, conversationId: id }], nextBefore: null }),
    markRead: async (id, messageId) => { readCalls.push([id, messageId]); },
  };
  const { navStore } = loadTsx('frontend/src/features/nav/nav-store.js');
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: { './api': api, '../nav/nav-store.js': { navStore } },
  });

  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { location: { search: '', hash: '' }, App: { user: { id: 7 } } };
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(navStore.get().messages, 0, 'no badge before anything has loaded (the prerender)');

    await store.loadConversations();
    assert.equal(navStore.get().messages, 2,
      'two of three conversations are unread — it counts conversations, not messages');

    // Opening conversation 1 reads it to the end: markRead zeroes its row
    // locally, and the badge falls with it rather than at the next refresh.
    store.messagesController.route(1);
    await settle(); await settle();
    assert.deepEqual(readCalls, [[1, 10]], 'the thread was read');
    assert.equal(navStore.get().messages, 1, 'reading a conversation takes it off the badge');

    // A message arrives in conversation 2 over the socket; the store reloads
    // the list, and the badge rises without the screen being involved.
    list = [row(2, 1, 5), row(1, 0, 3), row(3, 1, 1)];
    store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 2 });
    await settle();
    assert.equal(navStore.get().messages, 2, 'a new message raises the badge live');

    // Read on another device: the conversation_read event reloads the list.
    list = [row(2, 0, 5), row(1, 0, 3), row(3, 0, 1)];
    store.messagesController.handleEvent({ type: 'conversation_read', conversationId: 3, userId: 7 });
    await settle();
    assert.equal(navStore.get().messages, 0, 'nothing unread, no badge');
  } finally {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});

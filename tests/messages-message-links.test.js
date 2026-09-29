'use strict';

// A message link (#2387, `#messages/<id>/m/<messageId>`) opens its
// conversation on a window around that message. What is pinned here is what
// happens AFTER: the link anchors the first read only. A realtime refresh —
// somebody reacts, somebody posts — re-reads the window the reader is on
// now, and once they have gone to the present it reads the present. The
// first version anchored every refresh on the link, which snapped a reader
// who had paged on straight back to it and dropped their own new message
// outside the window.
//
// The REAL store runs here against a stubbed fetch.
//
// Run with: node --test tests/messages-message-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const CONVERSATION = 7;
const ALL = Array.from({ length: 30 }, (_, index) => index + 1);
const row = (id) => ({
  id, conversation_id: CONVERSATION, content: `m${id}`,
  sender: { id: 2, username: 'bea' }, created_at: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
});

function around(id) {
  const at = ALL.indexOf(id);
  const ids = ALL.slice(Math.max(0, at - 2), at + 3);
  return {
    messages: ids.map(row),
    next_before: ids[0] > 1 ? ids[0] : null,
    next_after: ids.at(-1) < ALL.at(-1) ? ids.at(-1) : null,
    focus: { message_id: id, thread_root_id: null },
  };
}

function install() {
  const reads = [];
  global.window = {
    location: { hash: '', search: '' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280,
    App: { user: { id: 1, username: 'me' } },
    Notifications: { markConversationRead() {}, markConversationThreadRead() {} },
  };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.fetch = async (url, init = {}) => {
    const path = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (init.method === 'POST') return json({});
    if (path === `/api/conversations/${CONVERSATION}`) {
      return json({ conversation: { id: CONVERSATION, kind: 'group', title: 'Launch crew', membershipStatus: 'member', members: [] } });
    }
    if (path.startsWith(`/api/conversations/${CONVERSATION}/messages?`)) {
      const params = new URLSearchParams(path.split('?')[1]);
      reads.push(params.get('around') ? `around=${params.get('around')}` : 'latest');
      if (params.get('around')) return json(around(Number(params.get('around'))));
      return json({ messages: ALL.slice(-5).map(row), next_before: 26 });
    }
    if (path.startsWith('/api/conversations')) return json({ conversations: [] });
    return json({ discussions: [] });
  };
  return reads;
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

test('a message link anchors the first read; later refreshes keep the reader\'s window, then the present', async () => {
  const reads = install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    let snap = null;
    const read = () => {
      const Probe = () => { snap = store.useMessagesSnapshot(); return null; };
      renderToHtml(createElement(Probe));
      return snap;
    };
    const reaction = { type: 'conversation_reaction_updated', conversationId: CONVERSATION, messageId: 4 };

    store.route(CONVERSATION, null, null, { focusMessageId: 5 });
    await settle();
    assert.deepEqual(reads, ['around=5'], 'the link opens on its message');
    assert.deepEqual(read().messages.map((m) => m.id), [3, 4, 5, 6, 7]);
    assert.equal(read().nextAfter, 7, 'part-way back, with newer messages to load');

    reads.length = 0;
    store.handleEvent(reaction);
    await settle();
    assert.deepEqual(reads, ['around=3'],
      'a reaction re-reads the window on screen (its first message), not the link again');

    reads.length = 0;
    store.jumpToPresent();
    await settle();
    assert.deepEqual(reads, ['latest']);
    assert.equal(read().nextAfter, null);

    reads.length = 0;
    store.handleEvent(reaction);
    await settle();
    assert.deepEqual(reads, ['latest'], 'at the present, a refresh stays at the present');

    // Leaving and following the same link again reads it afresh.
    store.close();
    reads.length = 0;
    store.route(CONVERSATION, null, null, { focusMessageId: 5 });
    await settle();
    assert.deepEqual(reads, ['around=5']);
  } finally {
    delete global.window;
    delete global.localStorage;
    delete global.fetch;
  }
});

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

test('canonical conversation redirects preserve thread and message destinations', async () => {
  for (const [extras, suffix] of [
    [{ threadRootId: 9100404 }, '/thread/9100404'],
    [{ focusMessageId: 9100202 }, '/m/9100202'],
  ]) {
    install();
    try {
      const fetch = global.fetch;
      global.fetch = (url, init) => String(url) === '/api/conversations/910004'
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({ conversation: {
          id: CONVERSATION, kind: 'group', title: 'Stored room', membershipStatus: 'member', members: [],
        } }) }) : fetch(url, init);
      const store = loadTsx('frontend/src/features/messages/store.ts');
      store.route(910004, null, null, extras);
      await settle();
      assert.equal(window.location.hash, `#messages/${CONVERSATION}${suffix}`);
      store.close();
    } finally {
      delete global.window; delete global.localStorage; delete global.fetch;
    }
  }
});

test('legacy message and thread ids redirect to the stored rows returned by the API', async () => {
  install();
  try {
    const fetch = global.fetch;
    global.fetch = (url, init) => {
      const path = String(url);
      const json = body => Promise.resolve({ ok: true, status: 200, json: async () => body });
      if (path.includes('/threads/9100404') || path.includes('/threads/10')) {
        return json({ root: row(10), messages: [{ ...row(11), thread_root_id: 10 }], next_before: null });
      }
      if (path.includes('around=9100202')) return json(around(5));
      return fetch(url, init);
    };
    const store = loadTsx('frontend/src/features/messages/store.ts');
    let snap;
    const read = () => {
      renderToHtml(createElement(() => { snap = store.useMessagesSnapshot(); return null; }));
      return snap;
    };
    store.route(CONVERSATION, null, null, { threadRootId: 9100404 });
    await settle();
    assert.equal(window.location.hash, `#messages/${CONVERSATION}/thread/10`);
    // The shell router follows the canonical address.
    store.route(CONVERSATION, null, null, { threadRootId: 10 });
    await settle();
    assert.equal(read().thread.rootId, 10);
    assert.equal(read().thread.root.id, 10);
    assert.equal(read().thread.messages[0].threadRootId, 10);
    store.close();
    store.route(CONVERSATION, null, null, { focusMessageId: 9100202 });
    await settle();
    assert.equal(window.location.hash, `#messages/${CONVERSATION}/m/5`);
    store.close();
  } finally {
    delete global.window; delete global.localStorage; delete global.fetch;
  }
});

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

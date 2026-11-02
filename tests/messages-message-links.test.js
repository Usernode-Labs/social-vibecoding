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

// #6148: the foot of a linked window reads its newer pages as the reader
// scrolls down to it (index.tsx maybeLoadNewer), and the top of a thread's
// replies its earlier ones (maybeLoadEarlierReplies). What the store promises
// the scroll loaders: one page per call while one is on its way, `false`
// only for a failed request (the button comes back as the retry), and
// nothing read once there is nothing left to read.
function pages(reads, fail) {
  const base = global.fetch;
  global.fetch = async (url, init = {}) => {
    const path = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    const params = new URLSearchParams(path.split('?')[1] || '');
    if (path.startsWith(`/api/conversations/${CONVERSATION}/messages?`) && params.get('after')) {
      const after = Number(params.get('after'));
      reads.push(`after=${after}`);
      if (fail.now) return { ok: false, status: 503, json: async () => ({ error: 'Try later' }) };
      const ids = ALL.filter((id) => id > after).slice(0, 10);
      return json({ messages: ids.map(row), next_after: ids.at(-1) < ALL.at(-1) ? ids.at(-1) : null });
    }
    if (path.startsWith(`/api/conversations/${CONVERSATION}/threads/10?`)) {
      const before = Number(params.get('before')) || null;
      reads.push(before ? `replies before=${before}` : 'replies');
      if (before && fail.now) return { ok: false, status: 503, json: async () => ({ error: 'Try later' }) };
      // Twenty replies to message 10: 11 to 30, the newest ten first.
      const ids = before ? ALL.filter((id) => id > 10 && id < before).slice(-10) : ALL.slice(-10);
      return json({
        root: row(10),
        messages: ids.map((id) => ({ ...row(id), thread_root_id: 10 })),
        next_before: ids[0] > 11 ? ids[0] : null,
      });
    }
    return base(url, init);
  };
}

test('#6148: a linked window reads one newer page per scroll to its foot, says when one failed, and stops at the present', async () => {
  const reads = install();
  const fail = { now: false };
  pages(reads, fail);
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    let snap = null;
    const read = () => {
      renderToHtml(createElement(() => { snap = store.useMessagesSnapshot(); return null; }));
      return snap;
    };
    store.route(CONVERSATION, null, null, { focusMessageId: 5 });
    await settle();
    assert.equal(read().nextAfter, 7);

    reads.length = 0;
    const first = store.loadNewer();
    assert.equal(read().loadingOlder, true, 'the foot says "Loading…" while it reads');
    const second = store.loadNewer(); // a second scroll while the page loads
    assert.equal(await first, true);
    assert.equal(await second, true, 'nothing failed: it read nothing');
    assert.deepEqual(reads, ['after=7'], 'one page');
    assert.deepEqual(read().messages.map((m) => m.id), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.equal(read().nextAfter, 17);
    assert.equal(read().loadingOlder, false);

    fail.now = true;
    reads.length = 0;
    assert.equal(await store.loadNewer(), false, 'a failed page says so: the retry button comes back');
    assert.deepEqual(reads, ['after=17']);
    assert.equal(read().nextAfter, 17, 'the window is as it was');
    assert.equal(read().messages.length, 15);
    assert.equal(read().loadingOlder, false);

    fail.now = false;
    reads.length = 0;
    assert.equal(await store.loadNewer(), true, 'the retry reads the same page');
    assert.equal(await store.loadNewer(), true);
    assert.deepEqual(reads, ['after=17', 'after=27']);
    assert.equal(read().nextAfter, null, 'the window has reached the present');
    assert.equal(read().messages.at(-1).id, 30);

    reads.length = 0;
    assert.equal(await store.loadNewer(), true);
    assert.deepEqual(reads, [], 'at the present nothing more is read');
  } finally {
    delete global.window;
    delete global.localStorage;
    delete global.fetch;
  }
});

test('#6148: a thread reads one earlier page per scroll to its top, and a failed page leaves its replies drawn', async () => {
  const reads = install();
  const fail = { now: false };
  pages(reads, fail);
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    let snap = null;
    const read = () => {
      renderToHtml(createElement(() => { snap = store.useMessagesSnapshot(); return null; }));
      return snap;
    };
    store.route(CONVERSATION, null, null, { threadRootId: 10 });
    await settle();
    assert.deepEqual(read().thread.messages.map((m) => m.id), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    assert.equal(read().thread.nextBefore, 21);

    fail.now = true;
    reads.length = 0;
    assert.equal(await store.loadOlderReplies(), false, 'a failed page says so: the retry button comes back');
    assert.deepEqual(reads, ['replies before=21']);
    assert.equal(read().thread.error, null, 'no error stands in place of the replies already drawn');
    assert.equal(read().thread.loading, false);
    assert.equal(read().thread.messages.length, 10);
    assert.equal(read().thread.nextBefore, 21);

    fail.now = false;
    reads.length = 0;
    const first = store.loadOlderReplies();
    assert.equal(read().thread.loading, true, 'the row says "Loading…" while it reads');
    const second = store.loadOlderReplies(); // a second scroll while the page loads
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(reads, ['replies before=21'], 'one page');
    assert.deepEqual(read().thread.messages.map((m) => m.id), ALL.filter((id) => id > 10));
    assert.equal(read().thread.nextBefore, null, 'the first reply is drawn');

    reads.length = 0;
    assert.equal(await store.loadOlderReplies(), true);
    assert.deepEqual(reads, [], 'nothing earlier is left to read');
  } finally {
    delete global.window;
    delete global.localStorage;
    delete global.fetch;
  }
});

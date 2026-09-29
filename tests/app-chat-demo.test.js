'use strict';

// #2387 / #2967 staging `?demo=1` fixtures for app channels.
//
// A declared check renders against a fresh staging database, where every app
// chat is empty and the tester has read nothing — so without fixtures none
// of this change is on screen. These pin what a preview shows:
//
//   * the general mock transcript opens on a deleted message's placeholder
//     and carries one reply thread (3 replies) under this morning's row,
//     while a topic's mock is exactly what it was;
//   * `thread_type=message&thread_ref=<that root>` answers the mock replies
//     without touching the database, and a real root is never padded;
//   * a permalink (`around`) or catch-up (`after`) on a mock id, and a read
//     or unread on one, answer from the mock;
//   * the Messages list previews a silent channel with the mock transcript,
//     gives it unread messages, and adds "more" rows for seeded apps.
//
// Strictly staging, and nothing is persisted.
//
// Run with: node --test tests/app-chat-demo.test.js

process.env.USERNODE_ENV = 'staging';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const queries = [];
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [] };
  },
});

const appAccessId = require.resolve('../src/services/app-access');
require.cache[appAccessId] = {
  id: appAccessId, filename: appAccessId, loaded: true, paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, slug) => (slug === 'demo' ? { id: 7, slug: 'demo' } : null),
    checkAppAccess: async () => true,
  },
};
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true, paths: [],
  exports: { getReactionsForMessages: async () => ({}) },
};

const chat = require('../src/routes/chat');
const overview = require('../src/routes/messages-overview');

const {
  stagingMockGroupChat, stagingDemoTranscript, stagingMockReplyThread,
  stagingMockStreamPage, stagingMockUnreadCount, DEMO_THREAD_ROOT_ID,
} = chat;

test('the general mock opens on a deleted placeholder and carries a reply thread', () => {
  const rows = stagingMockGroupChat(7, null);
  const [first] = rows;
  assert.equal(first.id, 9902000);
  assert.equal(first.deleted, true);
  assert.equal(first.content, '');
  assert.equal(first.username, 'staging-tester', 'a placeholder keeps its sender');
  assert.ok(Date.parse(first.created_at) < Date.parse(rows[1].created_at), 'oldest, as its id says');
  const ids = rows.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'id order is time order');

  const root = rows.find((m) => m.id === DEMO_THREAD_ROOT_ID);
  assert.equal(root.thread.reply_count, 3);
  assert.deepEqual(root.thread.participants.map((p) => p.username), ['staging-tester', 'staging-demo-user']);
  assert.equal(new Set(root.thread.participants.map((p) => p.id)).size, 2, 'faces are distinct by id');
  for (const m of rows) {
    assert.ok('deleted' in m && 'thread' in m, `row ${m.id} has the fields a real row has`);
    if (m.id !== DEMO_THREAD_ROOT_ID) assert.equal(m.thread, null);
  }
  const human = rows.filter((m) => m.msg_type === 'message');
  assert.equal(human[human.length - 1].posted_via, 'agent',
    'the agent row is still the newest human row (the feed preview reads it)');
});

test('a topic\'s mock transcript is unchanged', () => {
  const rows = stagingMockGroupChat(7, { type: 'issue', ref: 900008 });
  assert.equal(rows[0].id, 9902011, 'no placeholder on a topic');
  assert.ok(rows.every((m) => m.deleted === false && m.thread === null));
});

test('the mock reply thread, and only it, answers a thread read', () => {
  const thread = stagingMockReplyThread(7, DEMO_THREAD_ROOT_ID);
  assert.deepEqual(thread.messages.map((m) => [m.thread_type, m.thread_ref]),
    [['message', DEMO_THREAD_ROOT_ID], ['message', DEMO_THREAD_ROOT_ID], ['message', DEMO_THREAD_ROOT_ID]]);
  assert.equal(thread.root.id, DEMO_THREAD_ROOT_ID);
  assert.equal(thread.has_more_before, false);
  assert.equal(stagingMockReplyThread(7, 12345), null);
  assert.equal(stagingDemoTranscript(7, { type: 'message', ref: 12345 }, []), null,
    'a real message\'s empty thread is never padded with fixture replies');
});

test('permalinks, catch-up and the read cursor answer mock ids from the mock', () => {
  const around = stagingMockStreamPage(7, { around: 9902002 });
  assert.deepEqual(around.focus, { message_id: 9902002, thread_ref: null });
  const toReply = stagingMockStreamPage(7, { around: 9902022 });
  assert.deepEqual(toReply.focus, { message_id: 9902022, thread_ref: DEMO_THREAD_ROOT_ID });
  const after = stagingMockStreamPage(7, { after: 9902005 });
  assert.ok(after.messages.every((m) => m.id > 9902005));
  assert.equal(after.has_more_after, false);
  assert.equal(stagingMockStreamPage(7, { around: 42 }), null, 'a real id runs the real read');

  assert.equal(stagingMockUnreadCount(7, 9902004, 'read'), 0);
  // From this morning's row on: it, the next human row, and the agent's —
  // the conflict notices have no author and are never unread.
  assert.equal(stagingMockUnreadCount(7, DEMO_THREAD_ROOT_ID, 'unread'), 3);
  assert.equal(stagingMockUnreadCount(7, 42, 'unread'), null);
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 42, username: 'tester' }; next(); });
  app.use(chat.chatRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/apps/demo/messages`);
  } finally {
    server.close();
  }
}

test('GET and POST serve the mock ids without reading the database', async () => {
  await withServer(async (base) => {
    queries.length = 0;
    const thread = await (await fetch(`${base}?thread_type=message&thread_ref=${DEMO_THREAD_ROOT_ID}&demo=1`)).json();
    assert.equal(thread.messages.length, 3);
    assert.equal(thread.root.id, DEMO_THREAD_ROOT_ID);
    const permalink = await (await fetch(`${base}?around=9902022&demo=1`)).json();
    assert.deepEqual(permalink.focus, { message_id: 9902022, thread_ref: DEMO_THREAD_ROOT_ID });
    assert.equal(queries.length, 0, 'no query for a fixture');

    const read = await fetch(`${base}/read?demo=1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 9902008 }),
    });
    assert.deepEqual(await read.json(), { unread_count: 0 });

    // The first page of an empty general stream is the mock, flags included.
    const first = await (await fetch(`${base}?demo=1`)).json();
    assert.equal(first.messages[0].deleted, true);
    assert.equal(first.has_more_before, false);
    assert.equal(first.has_more_after, false);

    // Without the flag, a mock thread id is just a missing root.
    const real = await fetch(`${base}?thread_type=message&thread_ref=${DEMO_THREAD_ROOT_ID}`);
    assert.equal(real.status, 404);
  });
});

test('the Messages list demo previews silent channels and adds "more" rows', async () => {
  const real = overview.toDiscussion({
    slug: 'busy', name: 'Busy', section: 'yours', unread_count: 1,
    last_message: 'real words', last_at: '2020-01-01T00:00:00Z', last_by: 'ada',
  });
  const silent = overview.toDiscussion({ slug: 'staging-demo-app', name: 'Staging demo app', section: 'yours' });
  const seeded = {
    async query(sql, params) {
      assert.match(sql, /view_visibility = 'public' AND NOT self_hosted/, 'only apps anybody may open');
      return {
        rows: params[0].filter((slug) => slug !== 'staging-demo-pixel-racer')
          .map((slug) => ({ slug, name: 'Staging demo Word Garden', icon_emoji: '🌱', icon_image_id: null })),
      };
    },
  };
  const list = await overview.withDemoDiscussions(seeded, [real, silent]);
  const bySlug = Object.fromEntries(list.map((d) => [d.slug, d]));
  assert.deepEqual(bySlug.busy, real, 'real activity always wins');
  assert.equal(bySlug['staging-demo-app'].unreadCount, overview.DEMO_UNREAD);
  assert.match(bySlug['staging-demo-app'].lastMessage, /^\[Mock\] /);
  assert.equal(bySlug['staging-demo-word-garden'].section, 'more');
  assert.equal(bySlug['staging-demo-word-garden'].unreadCount, 3);
  assert.equal(bySlug['staging-demo-pixel-racer'], undefined, 'an app the database lacks is not invented');
  assert.deepEqual(list.map((d) => d.section), ['yours', 'yours', 'more']);
  assert.equal(list[0].slug, 'staging-demo-app', 'the previewed channel is the newest');
});

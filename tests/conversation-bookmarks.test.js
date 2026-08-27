'use strict';

// Saving a message in the MESSAGES area — the conversation half of the
// bookmark app group chat has carried since #1280.
//
// The app half is tests/message-bookmarks-route.test.js and this file
// deliberately mirrors its shape, because the two surfaces are meant to
// behave identically. What it pins is the part that is NOT identical:
//
//   * a second table, because `message_bookmarks.message_id` is a foreign key
//     into `chat_messages` and a DM is a `conversation_messages` row;
//   * a membership gate on save, so a readable message id from one
//     conversation cannot be used to pin a message out of another;
//   * NO gate on unsave, so someone who has since left a conversation can
//     still clear what they saved from it;
//   * the read-time access re-check, so leaving, being removed or blocking
//     stops the drawer showing what was said.
//
// Run with: node --test tests/conversation-bookmarks.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [], rowCount: 0 });
const pool = { query: (...args) => poolQueryHandler(...args) };
poolMod.getPool = () => pool;

// The conversation service is exercised for real elsewhere; here it is the
// gate, so it is stubbed to make each verdict explicit.
const conversationsId = require.resolve('../src/services/conversations');
const realConversations = require('../src/services/conversations');
let membership = { kind: 'direct', status: 'member' };
let canInteract = true;
let messageInConversation = true;
require.cache[conversationsId].exports = {
  ...realConversations,
  strictId: realConversations.strictId,
  loadMembership: async () => membership,
  canDirectInteract: async () => canInteract,
  getMessage: async () => (messageInConversation ? { id: 31 } : null),
};

const bookmarks = require('../src/services/message-bookmarks');
const { conversationRoutes } = require('../src/routes/conversations');

let queries = [];

function reset() {
  membership = { kind: 'direct', status: 'member' };
  canInteract = true;
  messageInConversation = true;
  queries = [];
  poolQueryHandler = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 5, username: 'alice' }; next(); });
  app.use(conversationRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

// ── the toggle endpoints ────────────────────────────────────────────────

test('PUT saves and DELETE unsaves a conversation message', async () => {
  reset();
  const server = await startServer();
  try {
    const saved = await fetch(
      urlFor(server, '/api/conversations/9/messages/31/bookmark'), { method: 'PUT' },
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { saved: true });
    const insert = queries.find((q) => /INSERT INTO conversation_message_bookmarks/.test(q.sql));
    assert.ok(insert, 'the save writes to the conversation table, not message_bookmarks');
    assert.match(insert.sql, /ON CONFLICT \(user_id, message_id\) DO NOTHING/,
      're-saving must not reorder the section');
    assert.deepEqual(insert.params, [5, 31]);

    queries = [];
    const unsaved = await fetch(
      urlFor(server, '/api/conversations/9/messages/31/bookmark'), { method: 'DELETE' },
    );
    assert.equal(unsaved.status, 200);
    assert.deepEqual(await unsaved.json(), { saved: false });
    const del = queries.find((q) => /DELETE FROM conversation_message_bookmarks/.test(q.sql));
    assert.ok(del, 'the unsave deletes the row');
    assert.deepEqual(del.params, [5, 31]);
  } finally {
    server.close();
  }
});

test('a non-member cannot save, and neither can a blocked direct peer', async () => {
  reset();
  membership = null;
  let server = await startServer();
  try {
    const res = await fetch(
      urlFor(server, '/api/conversations/9/messages/31/bookmark'), { method: 'PUT' },
    );
    assert.equal(res.status, 404);
    assert.ok(!queries.some((q) => /INSERT INTO conversation_message_bookmarks/.test(q.sql)),
      'a non-member never reaches the write');
  } finally {
    server.close();
  }

  reset();
  canInteract = false;
  server = await startServer();
  try {
    const res = await fetch(
      urlFor(server, '/api/conversations/9/messages/31/bookmark'), { method: 'PUT' },
    );
    assert.equal(res.status, 404,
      'a blocked direct peer is refused by the same gate that hides the history');
    assert.ok(!queries.some((q) => /INSERT INTO conversation_message_bookmarks/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('a message from another conversation is a 404, not a save', async () => {
  reset();
  // Membership is genuine; the message id simply is not in conversation 9.
  // This is the check that stops one readable conversation from unlocking
  // every message id on the platform.
  messageInConversation = false;
  const server = await startServer();
  try {
    const res = await fetch(
      urlFor(server, '/api/conversations/9/messages/31/bookmark'), { method: 'PUT' },
    );
    assert.equal(res.status, 404);
    assert.ok(!queries.some((q) => /INSERT INTO conversation_message_bookmarks/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('unsave is NOT membership-gated — you can always clear your own row', async () => {
  reset();
  // Left the conversation, or removed from it. The saved row is still this
  // user's own, and the drawer must be able to clear it.
  membership = null;
  const server = await startServer();
  try {
    const res = await fetch(
      urlFor(server, '/api/conversations/9/messages/31/bookmark'), { method: 'DELETE' },
    );
    assert.equal(res.status, 200);
    const del = queries.find((q) => /DELETE FROM conversation_message_bookmarks/.test(q.sql));
    assert.ok(del, 'the delete still runs');
    assert.deepEqual(del.params, [5, 31],
      'and it is scoped to this user, so it can only ever clear their own save');
  } finally {
    server.close();
  }
});

// ── the service ─────────────────────────────────────────────────────────

test('the read path re-checks membership every time', async () => {
  reset();
  let listSql = '';
  poolQueryHandler = async (sql, params) => {
    listSql = sql;
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  await bookmarks.listConversationsForUser(pool, 5);
  assert.match(listSql, /FROM conversation_message_bookmarks/);
  assert.match(listSql, /EXISTS \(\s*SELECT 1 FROM conversation_members/,
    'a save survives only while the saver is still a member');
  assert.match(listSql, /cm\.status = 'member'/,
    "an invited-but-not-joined or removed row must not pass");
  assert.doesNotMatch(listSql, /is_?admin|\$2::boolean/i,
    'there is no admin override on a private conversation, unlike an app');
  assert.match(listSql, /ORDER BY b\.created_at DESC/, 'newest save first');
});

test('a direct conversation is named by its peer, a group by its title', async () => {
  const direct = bookmarks.serializeConversation({
    message_id: 31, conversation_id: 9, conversation_kind: 'direct',
    conversation_title: null, peer_username: 'bob', author: 'bob',
    content: 'the runbook is in docs/', saved_at: 'S', message_created_at: 'M',
  });
  assert.equal(direct.conversationTitle, '@bob',
    'a direct conversation has no stored title — it is named by who is in it');
  assert.equal(direct.conversationId, 9,
    'the conversation id is the discriminator the drawer routes and unsaves on');

  const group = bookmarks.serializeConversation({
    message_id: 32, conversation_id: 10, conversation_kind: 'group',
    conversation_title: 'Launch crew', peer_username: null, author: 'carol',
    content: 'ship friday', saved_at: 'S', message_created_at: 'M',
  });
  assert.equal(group.conversationTitle, 'Launch crew');

  // A direct conversation whose peer has deleted their account still has to
  // render something rather than an empty label.
  const orphan = bookmarks.serializeConversation({
    message_id: 33, conversation_id: 11, conversation_kind: 'direct',
    conversation_title: null, peer_username: null, author: null,
    content: '', saved_at: 'S', message_created_at: 'M',
  });
  assert.equal(orphan.conversationTitle, 'Conversation');
});

test('an app save and a conversation save are told apart by which id they carry', () => {
  const app = bookmarks.serialize({
    message_id: 1, app_id: 7, app_slug: 'demo', app_name: 'Demo',
    author: 'bob', content: 'hi', thread_type: null, thread_ref: null,
    saved_at: 'S', message_created_at: 'M',
  });
  const conversation = bookmarks.serializeConversation({
    message_id: 2, conversation_id: 9, conversation_kind: 'direct',
    conversation_title: null, peer_username: 'bob', author: 'bob',
    content: 'hi', saved_at: 'S', message_created_at: 'M',
  });
  // The drawer branches on exactly this, so it is worth pinning that the two
  // shapes never both answer — a row carrying both would route ambiguously.
  assert.ok(app.appSlug && app.conversationId === undefined);
  assert.ok(conversation.conversationId && conversation.appSlug === undefined);
  // …and that the fields the one shared row renders are present on both.
  for (const row of [app, conversation]) {
    for (const field of ['messageId', 'author', 'content', 'savedAt']) {
      assert.ok(field in row, `${field} is common to both kinds`);
    }
  }
});

test('the hydrate returns a Set, and never queries for an empty page', async () => {
  reset();
  let called = 0;
  poolQueryHandler = async () => { called += 1; return { rows: [{ message_id: 31 }] }; };
  assert.deepEqual(await bookmarks.savedConversationMessageIdsFor(pool, 5, []), new Set());
  assert.deepEqual(await bookmarks.savedConversationMessageIdsFor(pool, null, [31]), new Set());
  assert.equal(called, 0, 'no round-trip for an anonymous viewer or an empty page');
  assert.deepEqual(await bookmarks.savedConversationMessageIdsFor(pool, 5, [31]), new Set([31]));
  assert.equal(called, 1);
});

'use strict';

// #2387: app-chat reply threads and the 'thread_reply' notification, the
// parts that need no database. tests/app-chat-postgres.test.js runs the
// same features end to end against the full schema.
//
//   * the per-app "Replies to you" switch (notification-preferences.js
//     `thread_replies`) governs the new kind as well as the quote reply;
//   * posting in the app clears a thread reply like the other chat kinds,
//     and it lights the message's unread dot;
//   * a notification row names the Messages address it opens;
//   * both thread validations accept 'message' — the read route's
//     THREAD_TYPES and the write side's validateThread, which checks the
//     root in SQL — and the topic types keep working unchanged;
//   * #4417: and 'category', a topic's channel: only a topic of this app,
//     a live one takes posts while an archived or merged one is read-only,
//     a reply thread may start from a topic message (and closes with its
//     topic), and the read cursor is the channel's own.
//
// Run with: node --test tests/app-chat-threads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const prefs = require('../src/services/notification-preferences');
const pushPrefs = require('../src/services/mobile-push-preferences');
const notifications = require('../src/services/notifications');
const appChat = require('../src/services/app-chat');

test('"Replies to you" gates a thread reply the way it gates a quote reply', () => {
  assert.equal(prefs.categoryForKind('thread_reply'), 'thread_replies');
  assert.equal(prefs.categoryForKind('reply'), 'thread_replies');
  // #4535: a request discussion's reply rides the same switch.
  assert.equal(prefs.categoryForKind('issue_thread_reply'), 'thread_replies');
  assert.equal(prefs.isKindEnabled('thread_reply', {}), true, 'on by default');
  assert.equal(prefs.isKindEnabled('thread_reply', { appOverrides: { thread_replies: false } }), false);
  assert.equal(prefs.isKindEnabled('thread_reply', { accountOverrides: { thread_replies: false } }), false);
  assert.equal(prefs.isKindEnabled('issue_thread_reply', {}), true, 'on by default');
  assert.equal(prefs.isKindEnabled('issue_thread_reply', { appOverrides: { thread_replies: false } }), false);
  // A gated kind must be push-eligible, or the switch could be on for a
  // notification that never reaches the phone.
  assert.equal(pushPrefs.KIND_TO_CATEGORY.get('thread_reply'), 'direct_interactions');
  assert.equal(pushPrefs.KIND_TO_CATEGORY.get('issue_thread_reply'), 'direct_interactions');
});

test('posting in the app clears a thread reply and it lights the unread dot', () => {
  assert.ok(notifications.ACTION_COMPLETIONS.message_sent.kinds.includes('thread_reply'));
  // #4535: a request discussion's reply clears the same way.
  assert.ok(notifications.ACTION_COMPLETIONS.message_sent.kinds.includes('issue_thread_reply'));
  for (const kind of ['mention', 'reply', 'reaction']) {
    assert.ok(notifications.ACTION_COMPLETIONS.message_sent.kinds.includes(kind), kind);
  }
});

test('an app-chat notification names the Messages address it opens', () => {
  const row = (extra) => ({
    id: 1, kind: 'thread_reply', read_at: null, created_at: 'now',
    app_id: 5, app_slug: 'recipe box', app_name: 'Recipe Box',
    chat_message_id: 88, message_content: 'Blue.',
    thread_type: 'message', thread_ref: 70,
    session_id: null, source_username: 'bob', detail: null, ...extra,
  });
  assert.equal(notifications.serialize(row()).href, '#messages/app/recipe%20box/thread/70',
    'a thread reply opens its thread');
  assert.equal(notifications.serialize(row({ kind: 'mention' })).href, '#messages/app/recipe%20box/thread/70',
    'so does a mention made inside one');
  assert.equal(notifications.serialize(row({ kind: 'reply', thread_type: null, thread_ref: null })).href,
    '#messages/app/recipe%20box/m/88', 'a general-stream message opens on the message');
  assert.equal(notifications.serialize(row({ kind: 'mention', thread_type: 'issue', thread_ref: 12 })).href,
    null, 'a topic thread keeps the client\'s own routing');
  assert.equal(notifications.serialize(row({ kind: 'kudos', chat_message_id: null })).href, null);
  assert.equal(notifications.serialize({
    ...row({ kind: 'conversation_reply' }), conversation_id: 3,
  }).href, null, 'a conversation row never carries an app address');
});

test('the read route accepts a reply thread and a topic\'s channel beside the topic threads', () => {
  const { THREAD_TYPES } = require('../src/routes/chat');
  assert.deepEqual([...THREAD_TYPES].sort(), ['category', 'governance', 'issue', 'message', 'session']);
});

test('validateThread checks a reply thread\'s root in SQL, and leaves the topic types alone', async () => {
  const { validateThread } = require('../src/services/ws');
  const seen = [];
  const poolWith = (rows) => ({
    async query(sql, params) { seen.push({ sql, params }); return { rows }; },
  });
  const root = { id: 70, user_id: 2, msg_type: 'message', thread_type: null };

  assert.deepEqual(await validateThread(poolWith([root]), 7, { type: 'message', ref: 70 }, 5),
    { type: 'message', ref: 70 });
  const q = seen.at(-1);
  assert.match(q.sql, /FROM chat_messages root/);
  assert.match(q.sql, /\(root\.thread_type IS NULL OR root\.thread_type = 'category'\)/,
    'a root is a general-stream row or (#4417) a topic channel\'s: never a reply, so no nesting');
  assert.match(q.sql, /root\.msg_type IN \('message', 'spec_share'\)/, 'written by a person');
  assert.match(q.sql, /blocked\.blocker_id = \$3/, 'and not by somebody the poster blocked');
  assert.deepEqual(q.params, [70, 7, 5]);

  assert.equal(await validateThread(poolWith([]), 7, { type: 'message', ref: 71 }, 5), null,
    'no such root in this app');
  seen.length = 0;
  assert.equal(await validateThread(poolWith([root]), 7, { type: 'message', ref: 2147483648 }, 5), null);
  assert.equal(await validateThread(poolWith([root]), 7, { type: 'message', ref: 0 }, 5), null);
  assert.equal(await validateThread(poolWith([root]), 7, { type: 'reply', ref: 70 }, 5), null);
  assert.equal(seen.length, 0, 'malformed refs are refused before any query');

  // A deleted root starts no new thread; one with replies stays open.
  const deletedRoot = { ...root, deleted_at: '2026-01-02' };
  const poolSeq = (...answers) => ({ async query() { return { rows: answers.shift() || [] }; } });
  assert.equal(await validateThread(poolSeq([deletedRoot], []), 7, { type: 'message', ref: 70 }, 5), null,
    'a deleted message with no replies takes none');
  assert.deepEqual(await validateThread(poolSeq([deletedRoot], [{ '?column?': 1 }]), 7, { type: 'message', ref: 70 }, 5),
    { type: 'message', ref: 70 }, 'a thread already under it goes on');

  // #194's issue refs still need no lookup; session/governance still do.
  assert.deepEqual(await validateThread(poolWith([]), 7, { type: 'issue', ref: 42 }), { type: 'issue', ref: 42 });
  assert.deepEqual(await validateThread(poolWith([{}]), 7, { type: 'session', ref: 9 }), { type: 'session', ref: 9 });
  assert.equal(await validateThread(poolWith([]), 7, { type: 'governance', ref: 9 }), null);
});

// ── #4417: a topic's channel ────────────────────────────────────────────

test('#4417 validateThread: a topic channel is a live topic of THIS app; a retired one comes back closed', async () => {
  const { validateThread } = require('../src/services/ws');
  const seen = [];
  const poolWith = (rows) => ({
    async query(sql, params) { seen.push({ sql, params }); return { rows }; },
  });
  assert.deepEqual(await validateThread(poolWith([{ topic_state: 'live' }]), 7, { type: 'category', ref: 12 }),
    { type: 'category', ref: 12 });
  const q = seen.at(-1);
  assert.match(q.sql, /FROM app_category_registry/);
  assert.match(q.sql, /origin = 'topic'/, 'only a topic row is a channel');
  assert.deepEqual(q.params, [12, 7], 'of this app');
  assert.equal(await validateThread(poolWith([]), 7, { type: 'category', ref: 13 }), null, 'no such topic here');
  for (const state of ['archived', 'merged']) {
    assert.deepEqual(await validateThread(poolWith([{ topic_state: state }]), 7, { type: 'category', ref: 12 }),
      { type: 'category', ref: 12, closed: true }, `a ${state} topic is read-only`);
  }
  // A reply thread whose root is a topic message closes with the topic.
  const poolSeq = (...answers) => ({ async query() { return { rows: answers.shift() || [] }; } });
  const topicRoot = { id: 80, user_id: 2, msg_type: 'message', thread_type: 'category', thread_ref: 12 };
  assert.deepEqual(await validateThread(poolSeq([topicRoot], [{ topic_state: 'live' }]), 7, { type: 'message', ref: 80 }, 5),
    { type: 'message', ref: 80 }, 'a reply thread can start from a topic message');
  assert.deepEqual(await validateThread(poolSeq([topicRoot], [{ topic_state: 'archived' }]), 7, { type: 'message', ref: 80 }, 5),
    { type: 'message', ref: 80, closed: true });
});

test('#4417 a retired topic refuses a post with an answer, not a silent drop', async () => {
  const ws = require('../src/services/ws');
  const sent = [];
  const pool = {
    async query(sql) {
      if (/FROM apps WHERE id = \$1/.test(sql) || /SELECT id, collab_visibility/.test(sql)) {
        return { rows: [{ id: 7, collab_visibility: 'public', view_visibility: 'public', self_hosted: false, moderation_suspended_at: null }] };
      }
      if (/FROM app_category_registry/.test(sql)) return { rows: [{ topic_state: 'archived' }] };
      return { rows: [] };
    },
  };
  const client = {
    user: { id: 5, username: 'eve', isAdmin: true }, appId: 7, appSlug: 'x',
    ws: { readyState: 1, send: (frame) => sent.push(JSON.parse(frame)) },
  };
  const out = await ws.handleMessage(pool, client, { type: 'chat', content: 'hello', thread: { type: 'category', ref: 12 } });
  assert.deepEqual(out, { ok: false, code: 'topic_closed' });
  assert.deepEqual(sent.at(-1), { type: 'error', code: 'topic_closed', message: ws.TOPIC_CLOSED_MESSAGE });
});

test('#4417 the topic channel\'s read cursor is its own table, under the general stream\'s definition of unread', async () => {
  const seen = [];
  const pool = { async query(sql, params) { seen.push({ sql, params }); return { rows: [] }; } };
  await appChat.categoryUnreadCounts(pool, 7, 5, [12, 13]);
  const count = seen.at(-1).sql;
  assert.match(count, /FROM app_category_chat_reads rc/);
  assert.match(count, /m\.thread_type = 'category' AND m\.thread_ref = rc\.category_id/);
  assert.match(count, /m\.id > rc\.last_read_id/);
  assert.match(count, /m\.deleted_at IS NULL/);
  assert.match(count, /m\.user_id IS NOT NULL AND m\.user_id <> \$2/, 'written by another person');
  assert.match(count, /blocked\.blocker_id = \$2/, 'not by somebody the reader blocked');
  await appChat.ensureCategoryReadCursors(pool, 7, 5, [12]);
  assert.match(seen.at(-1).sql, /ON CONFLICT \(app_id, category_id, user_id\) DO NOTHING/, 'a cursor is created once, at the newest message');
  assert.equal((await appChat.moveCategoryCursor(pool, { appId: 7, categoryId: 12, userId: 5, messageId: 0 })).ok, false);
  await appChat.moveCategoryCursor(pool, { appId: 7, categoryId: 12, userId: 5, messageId: 40 });
  assert.match(seen.find((q) => /GREATEST/.test(q.sql)).sql, /target\.thread_type = 'category' AND target\.thread_ref = \$2/,
    'read moves forward only, and only on a message of that channel');
  await appChat.moveCategoryCursor(pool, { appId: 7, categoryId: 12, userId: 5, messageId: 40, unread: true });
  assert.ok(seen.some((q) => /LEAST\(app_category_chat_reads\.last_read_id/.test(q.sql)), 'unread moves back only');
});

test('#4417 a mention in a topic channel opens the channel, on the message', () => {
  const href = notifications.serialize({
    id: 1, kind: 'mention', read_at: null, created_at: 'now', app_id: 5, app_slug: 'recipe box', app_name: 'Recipe Box',
    chat_message_id: 88, message_content: 'x', thread_type: 'category', thread_ref: 12,
    session_id: null, source_username: 'bob', detail: null,
  }).href;
  assert.equal(href, '#messages/app/recipe%20box/c/12/m/88');
});

test('a deleted row reads as a placeholder that keeps its sender', () => {
  const shaped = appChat.shapeRow({
    id: 4, user_id: 2, username: 'bob', content: 'secret', msg_type: 'message',
    metadata: { attachments: [{ id: 'a' }], quote: { refMsgId: 1 }, keep: true },
    thread_type: null, thread_ref: null, edited_at: '2026-01-01', deleted_at: '2026-01-02',
  });
  assert.equal(shaped.deleted, true);
  assert.equal(shaped.content, '');
  assert.deepEqual(shaped.metadata, { keep: true });
  assert.equal(shaped.edited_at, null);
  assert.equal(shaped.username, 'bob');
  assert.equal('deleted_at' in shaped, false, 'the flag, not the timestamp, goes on the wire');
  const live = appChat.shapeRow({ id: 5, user_id: null, username: null, msg_type: 'message', content: 'x', deleted_at: null });
  assert.equal(live.deleted, false);
  assert.equal(live.username, 'Deleted user', 'an erased account still reads as somebody');
});

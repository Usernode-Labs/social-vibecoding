'use strict';

// #2387 — the parts of platform-conversation threads, soft delete, permalinks
// and mark-unread that need no database:
//
//   1. the staging `?demo=1` fixtures, which a preview and the lead's client
//      render instead of real rows (`conversation_messages` is
//      staging:private, so a clone has none) — they must wear the same shape
//      the real routes answer with, and must not disturb the transcript the
//      declared checks select on;
//   2. the new `conversation_thread_reply` kind's push copy and bell row,
//      and where each conversation bell row now opens.
//
// The SQL and the real routes are exercised against PostgreSQL in
// tests/conversation-threads-postgres.test.js.

// The demo branches exist only in staging; the flag is read at require time.
process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const poolMod = require('../src/db/pool');
const untouched = { query: async () => { throw new Error('a demo branch reached the database'); } };
poolMod.getPool = () => untouched;

const routes = require('../src/routes/conversations');
const { buildMessage } = require('../src/services/mobile-push-policy');
const { KIND_TO_CATEGORY } = require('../src/services/mobile-push-preferences');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const VIEWER = { id: 5, username: 'viewer' };

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...VIEWER }; next(); });
  app.use(routes.conversationRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

// ── 1. demo fixtures ────────────────────────────────────────────────────

test('every demo message wears the #2387 shape, and the channel transcript is unchanged', () => {
  for (const id of [910001, 910002, 910004]) {
    for (const message of routes.demoMessages(VIEWER, id)) {
      assert.equal(typeof message.deleted, 'boolean', `${message.id}.deleted`);
      assert.equal(message.threadRootId, null, `${message.id} is main stream`);
      assert.ok('thread' in message, `${message.id}.thread`);
    }
  }
  // The declared checks select on #general's adjacency (9100401 + 9100402,
  // 9100405 + 9100406 + the card run). The thread's replies must not enter
  // the main stream between them.
  assert.deepEqual(routes.demoMessages(VIEWER, 910004).map((m) => m.id), [
    9100401, 9100402, 9100403, 9100404, 9100405, 9100406, 9100407, 9100408, 9100409,
  ]);
  const root = routes.demoMessages(VIEWER, 910004).find((m) => m.id === 9100404);
  assert.equal(root.thread.replyCount, 3);
  assert.deepEqual(root.thread.participants.map((p) => p.username), ['ada', 'viewer']);
  const replies = routes.demoThreadReplies(VIEWER, 910004);
  assert.equal(replies.length, 3);
  assert.ok(replies.every((r) => r.threadRootId === 9100404));
  assert.equal(root.thread.lastReplyAt, replies[replies.length - 1].createdAt);
  // #2387 follow-up: the card under the root shows the newest reply, and
  // each reply names its root for its line in the main stream. The replies
  // land after the card run, so ids and times agree and the checks'
  // adjacency above is untouched.
  assert.equal(root.thread.lastReply.id, replies[replies.length - 1].id);
  assert.ok(replies.every((r) => r.threadRoot && r.threadRoot.id === 9100404));
  assert.ok(replies.every((r) => r.createdAt > routes.demoMessages(VIEWER, 910004).at(-1).createdAt));

  const group = routes.demoMessages(VIEWER, 910002);
  assert.equal(group[0].attachments.length, 2, 'the screenshot row the checks use is intact');
  const placeholder = group.find((m) => m.deleted);
  assert.deepEqual(
    { content: placeholder.content, attachments: placeholder.attachments, objects: placeholder.objects,
      reactions: placeholder.reactions, editedAt: placeholder.editedAt, saved: placeholder.saved },
    { content: '', attachments: [], objects: [], reactions: [], editedAt: null, saved: false }
  );
  const list = routes.demoConversations(VIEWER).find((c) => c.id === 910002);
  assert.equal(list.latestSummary, group[0].content, 'a deleted message is never the latest');
});

test('demo routes answer the new endpoints without touching the database', async () => {
  await withServer(async (call) => {
    const channel = await call('GET', '/api/conversations/910004/messages?demo=1');
    assert.equal(channel.status, 200);
    assert.equal(channel.body.demo, true);
    assert.equal(channel.body.nextBefore, null);
    // #2387 follow-up: the main stream carries the thread's replies too,
    // where they landed — after the run of cards.
    assert.deepEqual(channel.body.messages.filter((m) => m.threadRootId).map((m) => m.id),
      [9100411, 9100412, 9100413]);
    assert.deepEqual(channel.body.messages.slice(-4).map((m) => m.id), [9100409, 9100411, 9100412, 9100413]);

    const thread = await call('GET', '/api/conversations/910004/threads/9100404?demo=1');
    assert.equal(thread.status, 200);
    assert.equal(thread.body.root.id, 9100404);
    assert.deepEqual(thread.body.messages.map((m) => m.id), [9100411, 9100412, 9100413]);
    assert.equal(thread.body.nextBefore, null);
    const paged = await call('GET', '/api/conversations/910004/threads/9100404?demo=1&limit=2');
    assert.deepEqual(paged.body.messages.map((m) => m.id), [9100412, 9100413]);
    assert.equal(paged.body.nextBefore, 9100412);
    const direct = await call('GET', '/api/conversations/910001/threads/9100101?demo=1');
    assert.equal(direct.status, 400);
    assert.deepEqual(direct.body, { error: 'threads_not_supported' });
    assert.equal((await call('GET', '/api/conversations/910004/threads/9100411?demo=1')).status, 404);

    const around = await call('GET', '/api/conversations/910004/messages?demo=1&around=9100412&limit=3');
    assert.deepEqual(around.body.focus, { messageId: 9100412, threadRootId: 9100404 });
    assert.deepEqual(around.body.messages.map((m) => m.id), [9100403, 9100404, 9100405]);
    assert.equal(around.body.nextBefore, 9100403);
    assert.equal(around.body.nextAfter, 9100405);
    const aroundMain = await call('GET', '/api/conversations/910004/messages?demo=1&around=9100401');
    assert.deepEqual(aroundMain.body.focus, { messageId: 9100401, threadRootId: null });
    assert.equal(aroundMain.body.nextBefore, null);
    assert.equal((await call('GET', '/api/conversations/910004/messages?demo=1&around=1')).status, 404);

    const after = await call('GET', '/api/conversations/910004/messages?demo=1&after=9100406');
    assert.deepEqual(after.body.messages.map((m) => m.id), [9100407, 9100408, 9100409, 9100411, 9100412, 9100413]);
    assert.equal(after.body.nextAfter, null);
    const before = await call('GET', '/api/conversations/910004/messages?demo=1&before=9100404&limit=2');
    assert.deepEqual(before.body.messages.map((m) => m.id), [9100402, 9100403]);
    assert.equal(before.body.nextBefore, 9100402);

    const unread = await call('POST', '/api/conversations/910004/unread?demo=1', { message_id: 9100404 });
    assert.equal(unread.status, 200);
    // 9100404 (lin) and the four cards (lin); 9100405 is the viewer's own.
    assert.deepEqual(unread.body, { unreadCount: 5, demo: true });
    assert.equal((await call('POST', '/api/conversations/910003/unread?demo=1', { message_id: 1 })).status, 404);

    const mine = await call('DELETE', '/api/conversations/910004/messages/9100405?demo=1');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.message.deleted, true);
    assert.equal(mine.body.message.content, '');
    const myReply = await call('DELETE', '/api/conversations/910004/messages/9100412?demo=1');
    assert.equal(myReply.body.message.threadRootId, 9100404);
    assert.equal((await call('DELETE', '/api/conversations/910004/messages/9100401?demo=1')).status, 404,
      'only your own');

    const posted = await call('POST', '/api/conversations/910004/messages?demo=1', {
      content: 'in the thread', thread_root_id: 9100404,
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.message.threadRootId, 9100404);
    assert.equal(posted.body.message.content, 'in the thread');
    const directPost = await call('POST', '/api/conversations/910001/messages?demo=1', {
      content: 'x', thread_root_id: 9100101,
    });
    assert.equal(directPost.status, 400);
    assert.deepEqual(directPost.body, { error: 'threads_not_supported' });
    const plain = await call('POST', '/api/conversations/910001/messages?demo=1', { content: 'x' });
    assert.equal(plain.status, 201, 'the existing demo send is unchanged');
  });
});

// ── 2. the new notification kind ────────────────────────────────────────

test('conversation_thread_reply is a Messages push with its own copy', () => {
  assert.equal(KIND_TO_CATEGORY.get('conversation_thread_reply'), 'messages');
  const message = buildMessage({
    token: 'token', notificationId: 42, kind: 'conversation_thread_reply', environment: 'test',
    installationId: '00000000-0000-4000-8000-000000000000', userId: 7,
    expiresAt: new Date(Date.now() + 60_000),
    context: { conversationTitle: 'Design crew', sourceUsername: 'alice', messageContent: 'on it' },
  });
  assert.deepEqual(message.notification, {
    title: '@alice replied in a thread · Design crew',
    body: 'on it',
  });
  assert.equal(message.data.notification_id, '42', 'the payload itself stays opaque');
});

let Notifications = null;
function loadBell() {
  if (Notifications) return Notifications;
  if (!globalThis.window) globalThis.window = globalThis;
  loadTsx('frontend/src/features/notifications/notifications.js');
  Notifications = globalThis.window.Notifications;
  return Notifications;
}

test('the bell names a thread reply and opens each conversation row at its address', () => {
  const bell = loadBell();
  const view = bell._rowView({
    id: 1, kind: 'conversation_thread_reply', createdAt: new Date().toISOString(), readAt: null,
    appName: null, sourceUsername: 'ada', conversationId: 7, conversationTitle: 'Design chat',
    conversationMessageId: 31, conversationThreadRootId: 30,
  });
  assert.equal(view.label, 'Replied in thread');
  assert.equal(view.icon, '🧵');
  assert.equal(view.conversation, true);

  // Every row opens through the controller's openAddress, which re-runs the
  // router when the address is the one already in the bar — a hash
  // assignment there fires nothing, and the old open(id) fallback closed the
  // thread the row was about. The hash is only the fallback for a shell
  // still starting.
  const opened = [];
  globalThis.location = { hash: '' };
  globalThis.UsernodeReact = { messages: { openAddress: (href) => opened.push(href) } };
  bell._markOneRead = () => {};
  bell._dismissSheetForNav = () => {};
  const open = (item) => {
    globalThis.location.hash = '';
    opened.length = 0;
    bell.items = [{ id: 9, conversationId: 7, conversationMessageId: 31, ...item }];
    bell._onItemClick(9);
    assert.equal(globalThis.location.hash, '', 'never assigned while the controller is up');
    return opened.join(',');
  };
  assert.equal(open({ kind: 'conversation_thread_reply', conversationThreadRootId: 30 }),
    '#messages/7/thread/30');
  assert.equal(open({ kind: 'conversation_mention', conversationThreadRootId: 30 }),
    '#messages/7/m/31', 'a mention opens the message, inside its thread if it has one');
  assert.equal(open({ kind: 'conversation_reply' }), '#messages/7/m/31');
  assert.equal(open({ kind: 'conversation_reaction' }), '#messages/7/m/31');
  assert.equal(open({ kind: 'conversation_message' }), '#messages/7', 'a plain message opens the room');
  assert.equal(open({ kind: 'conversation_invite', conversationMessageId: null }), '#messages/7');
  assert.equal(open({ kind: 'conversation_thread_reply', conversationThreadRootId: null }), '#messages/7',
    'a thread alert whose message is gone falls back to the room');
});

test('realtime envelopes stay identifier-only and name their thread', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/routes/conversations.js'), 'utf8');
  const created = source.slice(source.indexOf("type: 'conversation_message_created'"));
  assert.match(created.slice(0, 400), /threadRootId: result\.message\.threadRootId/);
  const del = source.slice(source.indexOf("router.delete('/api/conversations/:id/messages/:messageId'"));
  assert.match(del.slice(0, 1500),
    /type: 'conversation_message_updated', conversationId: id, messageId,\s+threadRootId: result\.threadRootId/);
  assert.doesNotMatch(del.slice(0, 1500), /message: result\.message,/,
    'the placeholder is answered to its author, never broadcast');
});

'use strict';

// #2387: conversation threads use the same stored, access-checked messages in
// staging as elsewhere. The demo query may resolve an old conversation link;
// it must never manufacture messages, successful writes or attachments.
// PostgreSQL coverage lives in conversation-threads-postgres.test.js and
// staging-data-reconciliation.test.js. This file also pins push and bell copy.

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const poolMod = require('../src/db/pool');
const untouched = { query: async () => { throw new Error('unexpected query outside the mocked service'); } };
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
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  try { await fn(call); } finally { server.close(); }
}

test('the demo query preserves stored-message and membership checks on every thread action', async t => {
  const conversations = require('../src/services/conversations');
  const staging = require('../src/services/staging-messages');
  const communities = require('../src/services/communities');
  const calls = [];
  t.mock.method(staging, 'resolveLegacyLink', async (_pool, user, id) => {
    assert.equal(user.id, VIEWER.id);
    assert.ok([910001, 910004].includes(id));
    return id === 910004 ? 77 : 78;
  });
  t.mock.method(staging, 'resolveLegacyMessageLink', async (_pool, _user, _conversationId, id) => id);
  t.mock.method(communities, 'generalNeedsJoin', async () => null);
  for (const name of ['listMessages', 'listThread', 'sendMessage', 'deleteMessage', 'markUnread', 'loadMembership']) {
    t.mock.method(conversations, name, async (pool, ...args) => {
      assert.equal(pool, untouched);
      calls.push({ name, args });
      return null; // The stored record is unavailable to this viewer.
    });
  }
  await withServer(async call => {
    const cases = [
      ['GET', '/api/conversations/910004/messages?demo=1&around=9100412', undefined, 'listMessages', 77],
      ['GET', '/api/conversations/910004/threads/9100404?demo=1', undefined, 'listThread', 77],
      ['POST', '/api/conversations/910004/messages?demo=1', { content: 'reply', thread_root_id: 9100404 }, 'sendMessage', 77],
      ['POST', '/api/conversations/910001/messages?demo=1', { content: 'message' }, 'sendMessage', 78],
      ['DELETE', '/api/conversations/910004/messages/9100405?demo=1', undefined, 'deleteMessage', 910004],
      ['POST', '/api/conversations/910004/unread?demo=1', { message_id: 9100404 }, 'markUnread', 910004],
      ['GET', '/api/conversations/910002/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?demo=1', undefined, 'loadMembership', 910002],
    ];
    for (const [method, url, body, service, id] of cases) {
      calls.length = 0;
      const response = await call(method, url, body);
      assert.equal(response.status, 404, `${method} ${url} cannot invent an accessible record`);
      assert.equal(response.body.demo, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, service);
      assert.equal(calls[0].args[service === 'loadMembership' ? 0 : 1], id);
    }
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

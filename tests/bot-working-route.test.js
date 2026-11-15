'use strict';

// #6674: the read a page makes when it comes back to the app.
//
// The bot's working card is drawn from ephemeral typing events, renewed every
// four seconds, and a page in the background expired it. A returning page now
// asks `GET /api/conversations/:id/bot-working`, and this pins what that
// answers: what the bot is doing in the exact place asked about, from this
// process or from another instance's short-lived copy, and only to somebody
// who may read the conversation.
//
// Run with: node --test tests/bot-working-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const mirror = require('../src/services/bot-typing-mirror');
const ws = require('../src/services/ws');
const { conversationRoutes } = require('../src/routes/conversations');

const BOT = 2;
const ME = 5;
const CONV = 41;
const THREAD = 13006;

const BOT_DM = {
  id: CONV,
  kind: 'direct',
  title: 'Homeroom bot',
  membershipStatus: 'member',
  peer: { id: BOT, bot: true, displayName: 'Homeroom bot' },
  members: [],
  unreadCount: 0,
  lastActivityAt: null,
};

/** The audience gate a typing event goes through, without a database. */
function stubAudience(t) {
  const real = conversations.withLockedAudience;
  conversations.withLockedAudience = async (_pool, _actor, _conversationId, callback) => {
    await callback([BOT, ME]);
    return [BOT, ME];
  };
  t.after(() => { conversations.withLockedAudience = real; });
}

/** The membership read the route makes; null is "not yours to read". */
function stubConversation(t, conversation) {
  const real = conversations.getConversation;
  conversations.getConversation = async () => conversation;
  t.after(() => { conversations.getConversation = real; });
}

function startServer() {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: ME, username: 'alan' }; next(); });
  app.use(conversationRoutes({}, { pool: {} }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function getWorking(server, query = '') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/${CONV}/bot-working${query}`);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body, cache: response.headers.get('cache-control') };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a person gets what the bot is doing where it types, and false once it stops', async (t) => {
  mirror._reset();
  t.after(() => mirror._reset());
  stubAudience(t);
  stubConversation(t, BOT_DM);
  const server = await startServer();
  t.after(() => server.close());

  let finish;
  let handed;
  const answering = dm.whileTyping({}, { botId: BOT, conversationId: CONV, threadRootId: THREAD, ws: { pushConversationEvent() {} } }, (typing) => {
    handed = typing;
    return new Promise((resolve) => { finish = resolve; });
  });
  await settle();
  await handed.doing({ kind: 'code', project: 'RecipeBot' });

  const working = await getWorking(server, `?thread_root_id=${THREAD}`);
  assert.equal(working.status, 200);
  assert.equal(working.cache, 'no-store', 'never a stale copy from the worker');
  assert.deepEqual(working.body, {
    typing: true, doing: { kind: 'code', project: 'RecipeBot' }, botId: BOT,
  });

  const main = await getWorking(server);
  assert.deepEqual(main.body, { typing: false, botId: BOT }, 'the main stream is not where it types');

  finish('done');
  await answering;
  await settle();
  assert.deepEqual((await getWorking(server, `?thread_root_id=${THREAD}`)).body, { typing: false, botId: BOT },
    'and false once the answer is sent');
});

test('a conversation with no bot, a non-member, and bad ids are answered safely', async (t) => {
  mirror._reset();
  t.after(() => mirror._reset());
  stubAudience(t);
  const server = await startServer();
  t.after(() => server.close());

  stubConversation(t, { ...BOT_DM, peer: { id: 9, username: 'ada' } });
  assert.deepEqual((await getWorking(server)).body, { typing: false, botId: null }, 'no bot peer: nobody is working');

  stubConversation(t, null);
  assert.equal((await getWorking(server)).status, 404, 'a non-member cannot ask');

  stubConversation(t, BOT_DM);
  const badId = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/abc/bot-working`);
  assert.equal(badId.status, 404, 'a bad conversation id');
  const badThread = await getWorking(server, '?thread_root_id=abc');
  assert.equal(badThread.status, 404, 'a bad thread id');
});

test('another instance\'s copy answers when this process holds nothing, and is gone after three renewals', async (t) => {
  mirror._reset();
  t.after(() => mirror._reset());
  stubAudience(t);
  stubConversation(t, BOT_DM);
  const server = await startServer();
  t.after(() => server.close());

  // What the pod running the bot published, as this pod's bus listener keeps it.
  ws._onBusMessage({
    kind: 'bot_typing',
    data: { conversationId: CONV, threadRootId: null, typing: true, doing: { kind: 'request', number: 12 }, answering: 88 },
  });
  assert.deepEqual((await getWorking(server)).body, {
    typing: true, doing: { kind: 'request', number: 12 }, answering: 88, botId: BOT,
  });

  // A stop another instance heard forgets the place.
  ws._onBusMessage({ kind: 'bot_typing', data: { conversationId: CONV, threadRootId: null, typing: false } });
  assert.deepEqual((await getWorking(server)).body, { typing: false, botId: BOT });

  // An entry nobody renewed is not live state any more.
  mirror.note({ conversationId: CONV, threadRootId: null, typing: true, doing: { kind: 'writing' } });
  const realNow = Date.now;
  const start = realNow();
  Date.now = () => start + mirror.MIRROR_TTL_MS + 1;
  try {
    assert.equal(mirror.get(CONV, null), null, 'older than three renewals');
  } finally {
    Date.now = realNow;
  }
});

// How fast one person may write over the chat socket (src/services/ws.js
// admitSocketFrame). The REST twins of chat and delete were limited to 60 a
// minute; the socket ran every frame through the live-account query and
// handleMessage with no limit at all. attach() now checks each parsed frame
// first:
//
//   - chat, edit and delete share 60 a minute per person;
//   - react has its own 120 (conversationReactionLimiter's size);
//   - typing has its own 120 and is dropped silently over it;
//   - over the budget the sender alone hears `rate_limited` (chat, edit,
//     react) or `delete_error` with code `rate_limited` (delete), and the
//     frame never reaches handleMessage.
//
// handleMessage itself stays unlimited: the REST twins call it behind their
// own limiter and the Homeroom bot relays through it.
//
// ws.js requires 'ws' + 'jsonwebtoken' at module load; intercept them via
// Module._load like the other ws suites do. Each loadWs() is a fresh module,
// so each test starts with empty budgets.
//
// Run with: node --test tests/ws-rate-limit.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadWs(warns = []) {
  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: class {} };
    if (request === 'jsonwebtoken') return { verify: () => ({}), sign: () => '' };
    return _origLoad.call(this, request, ...rest);
  };
  const ids = {
    pool: require.resolve('../src/db/pool'),
    logger: require.resolve('../src/services/logger'),
    notifications: require.resolve('../src/services/notifications'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    wsBus: require.resolve('../src/services/ws-bus'),
    subject: require.resolve('../src/services/ws'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.logger, { info() {}, warn(...args) { warns.push(args); }, error() {}, debug() {} });
  stub(ids.notifications, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, { checkAppAccess: async () => true });
  stub(ids.wsBus, { publish() {}, start() {}, stop() {} });
  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');
  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

function socketClient(userId = 5) {
  const sent = [];
  return {
    sent,
    client: { user: { id: userId, username: `u${userId}` }, appId: 7, ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } },
  };
}

const T0 = 1_000_000;

test('the budgets are the REST twins\' sizes', () => {
  const { SOCKET_RATE_BUDGETS, SOCKET_RATE_WINDOW_MS } = loadWs();
  assert.equal(SOCKET_RATE_WINDOW_MS, 60 * 1000);
  for (const type of ['chat', 'edit', 'delete']) {
    assert.deepEqual({ ...SOCKET_RATE_BUDGETS[type] }, { bucket: 'write', max: 60 }, `${type} shares the write budget`);
  }
  assert.deepEqual({ ...SOCKET_RATE_BUDGETS.react }, { bucket: 'react', max: 120 });
  assert.deepEqual({ ...SOCKET_RATE_BUDGETS.typing }, { bucket: 'typing', max: 120, silent: true });
  // The REST limiters they mirror.
  const limits = fs.readFileSync(path.join(__dirname, '..', 'src/middleware/rate-limits.js'), 'utf8');
  assert.match(limits, /const groupChatWriteLimiter = makeLimiter\(\{\s*windowMs: 60 \* 1000,\s*max: 60,/);
  assert.match(limits, /const conversationReactionLimiter = makeLimiter\(\{\s*windowMs: 60 \* 1000,\s*max: 120,/);
});

test('chat, edit and delete share 60 a minute; the 61st chat is answered rate_limited', () => {
  const { admitSocketFrame } = loadWs();
  const { sent, client } = socketClient();
  for (let i = 0; i < 20; i++) {
    assert.equal(admitSocketFrame(client, { type: 'chat', content: `m${i}` }, T0 + i), true);
    assert.equal(admitSocketFrame(client, { type: 'edit', messageId: 1, content: 'x' }, T0 + i), true);
    assert.equal(admitSocketFrame(client, { type: 'delete', id: 100 + i }, T0 + i), true);
  }
  assert.deepEqual(sent, [], 'nothing is said while within the budget');
  const refused = { type: 'chat', content: 'one too many', thread: { type: 'session', ref: 3 } };
  assert.equal(admitSocketFrame(client, refused, T0 + 30_000), false);
  assert.deepEqual(sent, [{
    type: 'rate_limited',
    retryAfterSeconds: 30,
    error: "You're sending messages too fast. Try again in 30 seconds.",
    retry: refused,
  }]);
  // Edits are refused the same way once the shared budget is spent.
  assert.equal(admitSocketFrame(client, { type: 'edit', messageId: 1, content: 'y' }, T0 + 59_500), false);
  assert.equal(sent[1].type, 'rate_limited');
  assert.equal(sent[1].retryAfterSeconds, 1);
  assert.equal(sent[1].error, "You're sending messages too fast. Try again in 1 second.");
});

test('a delete over the budget is answered as delete_error with code rate_limited', () => {
  const { admitSocketFrame } = loadWs();
  const { sent, client } = socketClient();
  for (let i = 0; i < 60; i++) admitSocketFrame(client, { type: 'chat', content: 'x' }, T0);
  assert.equal(admitSocketFrame(client, { type: 'delete', id: 42 }, T0 + 10_000), false);
  assert.deepEqual(sent, [{ type: 'delete_error', id: 42, code: 'rate_limited', retryAfterSeconds: 50 }]);
});

test('reactions have their own 120 a minute, apart from the write budget', () => {
  const { admitSocketFrame } = loadWs();
  const { sent, client } = socketClient();
  for (let i = 0; i < 60; i++) admitSocketFrame(client, { type: 'chat', content: 'x' }, T0);
  for (let i = 0; i < 120; i++) {
    assert.equal(admitSocketFrame(client, { type: 'react', messageId: 9, emoji: '👍' }, T0 + 1), true, `reaction ${i + 1}`);
  }
  assert.deepEqual(sent, []);
  const refused = { type: 'react', messageId: 9, emoji: '🎉' };
  assert.equal(admitSocketFrame(client, refused, T0 + 1), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'rate_limited');
  assert.deepEqual(sent[0].retry, refused);
});

test('typing over its budget is dropped without a word, and costs no other budget', () => {
  const { admitSocketFrame } = loadWs();
  const { sent, client } = socketClient();
  for (let i = 0; i < 120; i++) assert.equal(admitSocketFrame(client, { type: 'typing' }, T0), true);
  assert.equal(admitSocketFrame(client, { type: 'typing' }, T0), false);
  assert.equal(admitSocketFrame(client, { type: 'typing', thread: { type: 'issue', ref: 2 } }, T0), false);
  assert.deepEqual(sent, [], 'no frame for a typing dot');
  assert.equal(admitSocketFrame(client, { type: 'chat', content: 'still fine' }, T0), true);
  assert.equal(admitSocketFrame(client, { type: 'react', messageId: 1, emoji: '👍' }, T0), true);
});

test('the budget is per person: one sender spending theirs leaves others alone', () => {
  const { admitSocketFrame } = loadWs();
  const a = socketClient(5);
  const b = socketClient(6);
  // A second socket of the same person draws on the same budget.
  const a2 = socketClient(5);
  for (let i = 0; i < 30; i++) admitSocketFrame(a.client, { type: 'chat', content: 'x' }, T0);
  for (let i = 0; i < 30; i++) admitSocketFrame(a2.client, { type: 'chat', content: 'x' }, T0);
  assert.equal(admitSocketFrame(a.client, { type: 'chat', content: 'x' }, T0), false);
  assert.equal(admitSocketFrame(a2.client, { type: 'chat', content: 'x' }, T0), false);
  assert.equal(admitSocketFrame(b.client, { type: 'chat', content: 'x' }, T0), true);
  assert.deepEqual(b.sent, []);
});

test('the window resets a minute after its first frame', () => {
  const { admitSocketFrame } = loadWs();
  const { client } = socketClient();
  for (let i = 0; i < 60; i++) admitSocketFrame(client, { type: 'chat', content: 'x' }, T0 + i * 100);
  assert.equal(admitSocketFrame(client, { type: 'chat', content: 'x' }, T0 + 59_999), false);
  assert.equal(admitSocketFrame(client, { type: 'chat', content: 'x' }, T0 + 60_000), true);
});

test('frames with no budget pass, and a malformed frame does not throw', () => {
  const { admitSocketFrame } = loadWs();
  const { sent, client } = socketClient();
  for (let i = 0; i < 500; i++) {
    assert.equal(admitSocketFrame(client, { type: 'ping' }, T0), true);
    assert.equal(admitSocketFrame(client, { type: 'constructor' }, T0), true);
  }
  assert.equal(admitSocketFrame(client, null, T0), true);
  assert.equal(admitSocketFrame(client, 'chat', T0), true);
  assert.equal(admitSocketFrame(client, [], T0), true);
  assert.deepEqual(sent, []);
});

test('a closed socket is not written to, and a flood logs once per window', () => {
  const warns = [];
  const { admitSocketFrame } = loadWs(warns);
  const sent = [];
  const client = { user: { id: 5 }, appId: 7, ws: { readyState: 3, send: (raw) => sent.push(raw) } };
  for (let i = 0; i < 60; i++) admitSocketFrame(client, { type: 'chat', content: 'x' }, T0);
  for (let i = 0; i < 25; i++) assert.equal(admitSocketFrame(client, { type: 'chat', content: 'x' }, T0 + 1), false);
  assert.deepEqual(sent, []);
  const throttled = warns.filter(([, msg]) => msg === 'Throttled');
  assert.equal(throttled.length, 1, 'one line, not one per refused frame');
  assert.deepEqual(throttled[0][2], { name: 'ws-write', userId: 5, appId: 7, type: 'chat' });
});

test('attach() checks the frame after parsing it and before the account query and handleMessage', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/ws.js'), 'utf8');
  const handler = src.match(/ws\.on\('message', async \(raw\) => \{([\s\S]*?)\n {4}\}\);/);
  assert.ok(handler, 'found the chat socket message handler');
  const body = handler[1];
  const parse = body.indexOf('JSON.parse(raw)');
  const check = body.indexOf('if (!admitSocketFrame(client, msg)) return;');
  const live = body.indexOf('anonymised_at IS NULL');
  const handle = body.indexOf('await handleMessage(pool, client, msg)');
  assert.ok(parse >= 0 && check > parse, 'checked after parsing');
  assert.ok(live > check, 'before the live-account query');
  assert.ok(handle > live, 'and before handleMessage');
  // handleMessage, which the REST twins and the bot also call, does not
  // count frames itself.
  const handleMessageBody = src.slice(src.indexOf('async function handleMessage('), src.indexOf('async function getMessageReactions('));
  assert.doesNotMatch(handleMessageBody, /admitSocketFrame|takeSocketRate/);
});

test('handleMessage is not limited: the REST twins and the bot call it past any budget', async () => {
  const { handleMessage } = loadWs();
  let updates = 0;
  const pool = {
    async query(sql, params) {
      if (/FROM apps WHERE id/.test(sql)) return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
      if (/SELECT user_id, msg_type/.test(sql)) return { rows: [{ user_id: 5, msg_type: 'message', thread_type: null, thread_ref: null }] };
      if (/UPDATE chat_messages SET content/.test(sql)) { updates += 1; return { rows: [{ edited_at: '2026-10-04T00:00:00.000Z' }] }; }
      return { rows: [] };
    },
  };
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  for (let i = 0; i < 65; i++) await handleMessage(pool, client, { type: 'edit', messageId: 42, content: `v${i}` });
  assert.equal(updates, 65);
});

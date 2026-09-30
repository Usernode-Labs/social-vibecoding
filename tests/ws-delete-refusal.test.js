// A chat delete the server refuses over the socket is ANSWERED to the
// requesting socket alone. handleMessage's 'delete' case used to log the
// refusal and send nothing, so the sender's client kept its optimistic
// "Message deleted" placeholder until a reload. Now the sender gets
// `{ type: 'delete_error', id, code }` (public/js/group-chat.js puts the
// message back); nothing is broadcast to the room, and the REST twin, which
// has no socket, still just reads the returned result.
//
// ws.js requires 'ws' + 'jsonwebtoken' at module load; intercept them via
// Module._load like the other ws suites do, and stub the bus to record any
// broadcast.
//
// Run with: node --test tests/ws-delete-refusal.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadWs(published) {
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
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.notifications, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, { checkAppAccess: async () => true });
  stub(ids.wsBus, {
    publish: (kind, routing, data) => { published.push({ kind, routing, data }); },
    start() {}, stop() {},
  });
  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');
  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

// deleteOwnMessage's transaction: the row it locks is `row` (or none).
function makePool(row) {
  const cx = {
    async query(sql) {
      if (/FROM chat_messages/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { query: async () => ({ rows: [] }), connect: async () => cx };
}

function socketClient() {
  const sent = [];
  return {
    sent,
    client: { user: { id: 5, username: 'alice' }, appId: 7, ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } },
  };
}

test('deleting someone else\'s message answers the sender alone with delete_error', async () => {
  const published = [];
  const { handleMessage } = loadWs(published);
  const { sent, client } = socketClient();
  const pool = makePool({ id: 42, user_id: 99, msg_type: 'message', thread_type: null, thread_ref: null, deleted_at: null });
  const result = await handleMessage(pool, client, { type: 'delete', id: 42 });
  assert.deepEqual(result, { ok: false, code: 'not_author' });
  assert.deepEqual(sent, [{ type: 'delete_error', id: 42, code: 'not_author' }]);
  assert.deepEqual(published, [], 'nothing is broadcast');
});

test('deleting a message that is not there answers not_found to the sender', async () => {
  const published = [];
  const { handleMessage } = loadWs(published);
  const { sent, client } = socketClient();
  await handleMessage(makePool(null), client, { type: 'delete', id: 43 });
  assert.deepEqual(sent, [{ type: 'delete_error', id: 43, code: 'not_found' }]);
  assert.deepEqual(published, []);
});

test('a system line is nobody\'s to delete, and the sender is told', async () => {
  const { handleMessage } = loadWs([]);
  const { sent, client } = socketClient();
  await handleMessage(makePool({ id: 44, user_id: 5, msg_type: 'system', deleted_at: null }), client, { type: 'delete', id: 44 });
  assert.deepEqual(sent, [{ type: 'delete_error', id: 44, code: 'not_author' }]);
});

test('the REST twin has no socket and still gets the refusal as its result', async () => {
  const { handleMessage } = loadWs([]);
  const pool = makePool({ id: 42, user_id: 99, msg_type: 'message', deleted_at: null });
  const result = await handleMessage(pool, { user: { id: 5 }, appId: 7, appSlug: 'demo' }, { type: 'delete', id: 42 });
  assert.deepEqual(result, { ok: false, code: 'not_author' });
});

test('a closed socket is not written to', async () => {
  const { handleMessage } = loadWs([]);
  const sent = [];
  const client = { user: { id: 5 }, appId: 7, ws: { readyState: 3, send: (raw) => sent.push(raw) } };
  await handleMessage(makePool(null), client, { type: 'delete', id: 45 });
  assert.deepEqual(sent, []);
});

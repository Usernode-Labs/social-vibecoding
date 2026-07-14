// WS 'edit' handler tests (multi-line + editing spec).
//
// handleMessage's 'edit' case is the server-side authority for message
// editing: only the original author may edit, only ordinary 'message' rows
// are editable, empty edits are rejected, and content is trimmed + capped at
// MAX_CHAT_LEN (8000, #328) before the UPDATE. We drive handleMessage
// directly with a recording
// pool and assert on the SQL it issues (the UPDATE running — or not — and its
// params), since broadcast() is a no-op with no connected room here.
//
// ws.js requires 'ws' + 'jsonwebtoken' at module load (not installed in this
// hermetic env), so we intercept them via Module._load like the other ws
// suites do.
//
// Run with: node --test tests/ws-edit-handler.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadWs() {
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
    subject: require.resolve('../src/services/ws'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.notifications, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  // #621: handleMessage's write gate consults checkAppAccess before every
  // mutating message — pass everyone so these suites keep testing the edit
  // semantics themselves (the gate has its own tests in
  // readonly-dev-access.test.js).
  stub(ids.appAccess, { checkAppAccess: async () => true });

  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

// A pool that records every query and answers the edit handler's two
// statements: the authorization SELECT (returns `selectRows`) and the
// UPDATE (returns a fixed edited_at).
function makeEditPool(selectRows) {
  const seen = [];
  return {
    seen,
    update() { return seen.find((q) => /UPDATE chat_messages SET content/.test(q.sql)); },
    select() { return seen.find((q) => /SELECT user_id, msg_type/.test(q.sql)); },
    async query(sql, params) {
      seen.push({ sql, params });
      // #621: the write gate resolves the app before any edit statement
      // runs — answer with a collab-public app so the gate passes.
      if (/FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
      }
      if (/SELECT user_id, msg_type/.test(sql)) return { rows: selectRows };
      if (/UPDATE chat_messages SET content/.test(sql)) {
        return { rows: [{ edited_at: '2026-06-16T18:41:00.000Z' }] };
      }
      return { rows: [] };
    },
  };
}

const ownMessageRow = [{ user_id: 5, msg_type: 'message', thread_type: null, thread_ref: null }];

test('author edit succeeds, trims content, and sets edited_at', async () => {
  const { handleMessage } = loadWs();
  const pool = makeEditPool(ownMessageRow);
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  await handleMessage(pool, client, { type: 'edit', messageId: 42, content: '  new body  ' });

  const upd = pool.update();
  assert.ok(upd, 'UPDATE ran for the author');
  assert.equal(upd.params[0], 'new body', 'content is trimmed');
  assert.equal(upd.params[1], 42, 'keyed on the message id');
  assert.match(upd.sql, /edited_at = NOW\(\)/, 'edited_at is set to NOW()');

  const sel = pool.select();
  assert.deepEqual(sel.params, [42, 7], 'authorization scoped to message id + app id');
});

test('non-author edit is rejected and leaves the row unchanged', async () => {
  const { handleMessage } = loadWs();
  const pool = makeEditPool([{ user_id: 99, msg_type: 'message', thread_type: null, thread_ref: null }]);
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  await handleMessage(pool, client, { type: 'edit', messageId: 42, content: 'sneaky' });

  assert.ok(pool.select(), 'authorization SELECT ran');
  assert.ok(!pool.update(), 'no UPDATE for a non-author');
});

for (const msgType of ['system', 'vote', 'conflict', 'spec_share']) {
  test(`editing a ${msgType} row is rejected`, async () => {
    const { handleMessage } = loadWs();
    const pool = makeEditPool([{ user_id: 5, msg_type: msgType, thread_type: null, thread_ref: null }]);
    const client = { user: { id: 5, username: 'alice' }, appId: 7 };
    await handleMessage(pool, client, { type: 'edit', messageId: 42, content: 'should not apply' });
    assert.ok(!pool.update(), `no UPDATE for a ${msgType} row`);
  });
}

// #621: the collab write gate resolves the app before the edit case runs,
// so "no edit statements" now means no SELECT/UPDATE beyond the gate's
// app/membership lookups rather than a fully empty query log.
test('empty / whitespace-only content is rejected before any edit statement', async () => {
  const { handleMessage } = loadWs();
  const pool = makeEditPool(ownMessageRow);
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  await handleMessage(pool, client, { type: 'edit', messageId: 42, content: '   \n  ' });
  assert.equal(pool.select(), undefined, 'no authorization SELECT for an empty edit');
  assert.equal(pool.update(), undefined, 'no UPDATE for an empty edit');
});

test('invalid messageId is rejected before any edit statement', async () => {
  const { handleMessage } = loadWs();
  const pool = makeEditPool(ownMessageRow);
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  await handleMessage(pool, client, { type: 'edit', messageId: 'nope', content: 'x' });
  assert.equal(pool.select(), undefined, 'non-integer messageId short-circuits');
  assert.equal(pool.update(), undefined, 'no UPDATE for a bad messageId');
});

test('content is capped at MAX_CHAT_LEN (8000) characters', async () => {
  const ws = loadWs();
  const { handleMessage } = ws;
  const pool = makeEditPool(ownMessageRow);
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  await handleMessage(pool, client, { type: 'edit', messageId: 42, content: '   ' + 'x'.repeat(9000) });
  const upd = pool.update();
  assert.ok(upd, 'UPDATE ran');
  assert.equal(ws.MAX_CHAT_LEN, 8000, 'cap raised from 2000 to 8000 (#328)');
  assert.equal(upd.params[0].length, 8000, 'content trimmed then capped at 8000');
});

test('thread scope is echoed on the broadcast for a thread-scoped edit', async () => {
  // Smoke test: a thread-scoped row must not throw and must run the UPDATE.
  // (Broadcast payload routing is exercised in the client.)
  const { handleMessage } = loadWs();
  const pool = makeEditPool([{ user_id: 5, msg_type: 'message', thread_type: 'session', thread_ref: 55 }]);
  const client = { user: { id: 5, username: 'alice' }, appId: 7 };
  await handleMessage(pool, client, { type: 'edit', messageId: 42, content: 'threaded edit' });
  assert.ok(pool.update(), 'UPDATE ran for a thread-scoped message');
});

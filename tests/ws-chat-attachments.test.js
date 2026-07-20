// WS 'chat' handler tests for group-chat file attachments (#694).
//
// The 'chat' case accepts an optional attachmentIds array: ids are
// sanitized (sanitizeAttachmentIds — 32-hex, deduped, max 4), ownership
// is verified against chat_message_attachments (this app + this user +
// unlinked), the message INSERT carries a metadata.attachments summary,
// and the link UPDATE runs in the same transaction as the INSERT.
// Attachments-only sends are allowed (content stored as ''); any
// sanitization or ownership miss drops the whole send. Same harness as
// tests/ws-edit-handler.test.js: drive handleMessage directly with a
// recording pool and assert on the SQL it issues.
//
// Run with: node --test tests/ws-chat-attachments.test.js

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

const ATT_A = 'a'.repeat(32);
const ATT_B = 'b'.repeat(32);

// A pool that records every query — both direct pool.query calls and
// queries on transaction clients handed out by connect(). `ownedRows`
// answers the attachment ownership SELECT; `quoteRows` answers the
// quote-reference SELECT (#15 path).
function makeChatPool({ ownedRows = [], quoteRows = [] } = {}) {
  const seen = [];
  const answer = async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM apps WHERE id/.test(sql)) {
      return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
    }
    if (/FROM chat_message_attachments/.test(sql)) return { rows: ownedRows };
    if (/SELECT m\.id, m\.user_id, m\.content/.test(sql)) return { rows: quoteRows };
    if (/INSERT INTO chat_messages/.test(sql)) {
      return { rows: [{ id: 321, created_at: '2026-07-20T12:00:00.000Z' }] };
    }
    return { rows: [] };
  };
  return {
    seen,
    insert() { return seen.find((q) => /INSERT INTO chat_messages/.test(q.sql)); },
    link() { return seen.find((q) => /UPDATE chat_message_attachments SET message_id/.test(q.sql)); },
    ownershipSelect() { return seen.find((q) => /FROM chat_message_attachments\b(?!.*SET)/s.test(q.sql) && /SELECT/.test(q.sql)); },
    query: answer,
    connected: [],
    async connect() {
      const cx = { released: false, tx: [], query: async (sql, params) => { cx.tx.push(sql); return answer(sql, params); }, release() { cx.released = true; } };
      this.connected.push(cx);
      return cx;
    },
  };
}

const client = { user: { id: 5, username: 'alice' }, appId: 7 };

test('attachment ids link on send: summary in metadata, UPDATE in the same transaction', async () => {
  const { handleMessage } = loadWs();
  const pool = makeChatPool({
    ownedRows: [
      { id: ATT_A, kind: 'image', filename: 'shot.png', size_bytes: 123, meta: null },
      { id: ATT_B, kind: 'markdown', filename: 'notes.md', size_bytes: 45, meta: null },
    ],
  });
  await handleMessage(pool, client, {
    type: 'chat', content: 'look at these', attachmentIds: [ATT_A, ATT_B],
  });

  const own = pool.ownershipSelect();
  assert.ok(own, 'ownership SELECT ran');
  assert.deepEqual(own.params, [[ATT_A, ATT_B], 7, 5], 'scoped to ids + app + user');
  assert.match(own.sql, /message_id IS NULL/, 'only unlinked rows are linkable');

  const ins = pool.insert();
  assert.ok(ins, 'INSERT ran');
  assert.equal(ins.params[2], 'look at these');
  const metadata = JSON.parse(ins.params[3]);
  assert.deepEqual(metadata.attachments, [
    { id: ATT_A, kind: 'image', filename: 'shot.png', sizeBytes: 123 },
    { id: ATT_B, kind: 'markdown', filename: 'notes.md', sizeBytes: 45 },
  ]);

  const link = pool.link();
  assert.ok(link, 'link UPDATE ran');
  assert.deepEqual(link.params, [321, [ATT_A, ATT_B]]);

  // Both statements ran inside the one transaction client.
  assert.equal(pool.connected.length, 1, 'one transaction client');
  const tx = pool.connected[0].tx;
  assert.ok(tx.some((s) => /^BEGIN$/.test(s)) && tx.some((s) => /^COMMIT$/.test(s)), 'BEGIN + COMMIT');
  assert.ok(tx.some((s) => /INSERT INTO chat_messages/.test(s)), 'INSERT inside the tx');
  assert.ok(tx.some((s) => /UPDATE chat_message_attachments/.test(s)), 'UPDATE inside the tx');
  assert.equal(pool.connected[0].released, true, 'client released');
});

test('ownership mismatch drops the whole send', async () => {
  const { handleMessage } = loadWs();
  // Client references two ids but only one row is owned/unlinked.
  const pool = makeChatPool({
    ownedRows: [{ id: ATT_A, kind: 'image', filename: 'shot.png', size_bytes: 123, meta: null }],
  });
  await handleMessage(pool, client, {
    type: 'chat', content: 'sneaky', attachmentIds: [ATT_A, ATT_B],
  });
  assert.ok(pool.ownershipSelect(), 'ownership SELECT ran');
  assert.equal(pool.insert(), undefined, 'no INSERT after an ownership miss');
  assert.equal(pool.link(), undefined, 'no link UPDATE either');
});

test('empty content with attachments is accepted and stored as \'\'', async () => {
  const { handleMessage } = loadWs();
  const pool = makeChatPool({
    ownedRows: [{ id: ATT_A, kind: 'text', filename: 'a.txt', size_bytes: 9, meta: null }],
  });
  await handleMessage(pool, client, { type: 'chat', content: '', attachmentIds: [ATT_A] });
  const ins = pool.insert();
  assert.ok(ins, 'INSERT ran for an attachments-only send');
  assert.equal(ins.params[2], '', 'content stored as the empty string');
  const metadata = JSON.parse(ins.params[3]);
  assert.equal(metadata.attachments.length, 1);
});

test('empty content without attachments is still rejected', async () => {
  const { handleMessage } = loadWs();
  const pool = makeChatPool();
  await handleMessage(pool, client, { type: 'chat', content: '   \n ' });
  assert.equal(pool.insert(), undefined, 'no INSERT for an empty send');
});

test('malformed attachment ids drop the message before any chat statement', async () => {
  const { handleMessage } = loadWs();
  for (const bad of [
    ['not-hex'],
    'a'.repeat(32), // not an array
    [ATT_A, ATT_A.toUpperCase()],
    Array.from({ length: 5 }, (_, i) => String(i).repeat(32)), // over the per-message cap
  ]) {
    const pool = makeChatPool();
    await handleMessage(pool, client, { type: 'chat', content: 'hi', attachmentIds: bad });
    assert.equal(pool.insert(), undefined, `no INSERT for attachmentIds=${JSON.stringify(bad)}`);
  }
});

test('a message without attachments takes the plain single-INSERT path (no transaction)', async () => {
  const { handleMessage } = loadWs();
  const pool = makeChatPool();
  await handleMessage(pool, client, { type: 'chat', content: 'plain message' });
  assert.ok(pool.insert(), 'INSERT ran');
  assert.equal(pool.connected.length, 0, 'no transaction client used');
  assert.equal(pool.link(), undefined, 'no link UPDATE');
});

test('quoting an attachments-only message falls back to the 📎-filename snippet', async () => {
  const { handleMessage } = loadWs();
  const pool = makeChatPool({
    quoteRows: [{
      id: 42, user_id: 9, content: '', msg_type: 'message', username: 'bob',
      metadata: { attachments: [{ id: ATT_A, kind: 'markdown', filename: 'notes.md', sizeBytes: 45 }] },
    }],
  });
  await handleMessage(pool, client, {
    type: 'chat', content: 'replying', quote: { source: 'message', refMsgId: 42 },
  });
  const ins = pool.insert();
  assert.ok(ins, 'INSERT ran');
  const metadata = JSON.parse(ins.params[3]);
  assert.equal(metadata.quote.snippet, '\u{1F4CE} notes.md');
  assert.equal(metadata.quote.author, 'bob');
});

// Pre-promotion shared-session chat delivery: a comment posted into a dev
// session's public discussion thread (thread_type='session') notifies the
// SESSION OWNER via kind='session_comment'. Two layers are covered here:
//
//   1. The WS 'chat' handler's fan-out — it calls
//      createSessionCommentNotification for session-thread posts only, and
//      passes the recipients the same message already pinged (quote-reply /
//      @mention rows) as excludeUserIds so the owner is never double-pinged.
//   2. The creator itself — resolves the owner from chat_sessions, skips
//      self-comments and already-pinged owners, and inserts a row carrying
//      BOTH session_id and chat_message_id (title + snippet + deep link).
//
// ws.js requires 'ws' + 'jsonwebtoken' at module load (not installed in this
// hermetic env), so we intercept them via Module._load like the other ws
// suites do.
//
// Run with: node --test tests/ws-session-comment-notification.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const notificationsReal = require('../src/services/notifications');
const { ALLOWED_KINDS } = require('../src/services/mobile-push-preferences');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load ws.js with a RECORDING notifications stub so the handler's fan-out
// calls (and their arguments) are observable without real SQL.
function loadWs(notifStub) {
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
  stub(ids.notifications, notifStub);
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

function makeNotifStub({ replyRows = [], mentionRows = [] } = {}) {
  const calls = { reply: [], mention: [], sessionComment: [], hydrated: [] };
  return {
    calls,
    createReplyNotification: async (pool, args) => { calls.reply.push(args); return replyRows; },
    createMentionNotifications: async (pool, args) => { calls.mention.push(args); return mentionRows; },
    createSessionCommentNotification: async (pool, args) => {
      calls.sessionComment.push(args);
      return [{ id: 777, user_id: 1, kind: 'session_comment' }];
    },
    hydrateAndPush: async (pool, row) => { calls.hydrated.push(row); },
    markReadForAction: async () => 0,
    serialize: (r) => r,
  };
}

// A pool answering the 'chat' path's queries: the write gate's app lookup,
// validateThread's session reachability check (always reachable here — the
// predicate has its own suite), the message INSERT, and the quote lookup
// when a test sends one.
function makeChatPool({ quotedRow = null } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (/FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: params[0], collab_visibility: 'public', view_visibility: 'public' }] };
      }
      if (/FROM chat_sessions/.test(sql) && /shared_at IS NOT NULL/.test(sql)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/SELECT m\.id, m\.user_id, m\.content/.test(sql)) {
        return { rows: quotedRow ? [quotedRow] : [] };
      }
      if (/INSERT INTO chat_messages/.test(sql)) {
        return { rows: [{ id: 4242, created_at: '2026-08-21T12:00:00.000Z' }] };
      }
      return { rows: [] };
    },
  };
}

const client = { user: { id: 9, username: 'zura' }, appId: 7 };

test('a session-thread post notifies the session owner (session_comment)', async () => {
  const notif = makeNotifStub();
  const { handleMessage } = loadWs(notif);
  const pool = makeChatPool();

  const result = await handleMessage(pool, client, {
    type: 'chat', content: 'can I help with this?', thread: { type: 'session', ref: 55 },
  });
  assert.equal(result.ok, true, 'message accepted');

  assert.equal(notif.calls.sessionComment.length, 1, 'exactly one session_comment fan-out');
  const args = notif.calls.sessionComment[0];
  assert.equal(args.appId, 7);
  assert.equal(args.sessionId, 55);
  assert.equal(args.chatMessageId, 4242, 'carries the freshly inserted comment id');
  assert.equal(args.senderId, 9);
  assert.deepEqual(args.excludeUserIds, [], 'nothing else pinged → nothing excluded');
  assert.equal(notif.calls.hydrated.length, 1, 'the created row is hydrated + pushed');
});

test('a quote-reply to the owner suppresses the duplicate session_comment', async () => {
  // The quoted row's author (user 1) gets a 'reply' notification; the
  // session_comment fan-out must list them in excludeUserIds so the
  // creator can skip an owner who was already pinged.
  const notif = makeNotifStub({ replyRows: [{ id: 501, user_id: 1 }] });
  const { handleMessage } = loadWs(notif);
  const pool = makeChatPool({
    quotedRow: { id: 300, user_id: 1, content: 'original', msg_type: 'message', metadata: {}, username: 'owner' },
  });

  await handleMessage(pool, client, {
    type: 'chat', content: 'replying to you', thread: { type: 'session', ref: 55 },
    quote: { source: 'message', refMsgId: 300 },
  });

  assert.equal(notif.calls.sessionComment.length, 1);
  assert.deepEqual(notif.calls.sessionComment[0].excludeUserIds, [1],
    'the reply recipient rides in excludeUserIds');
});

test('no session_comment fan-out for general or issue-thread messages', async () => {
  const notif = makeNotifStub();
  const { handleMessage } = loadWs(notif);

  await handleMessage(makeChatPool(), client, { type: 'chat', content: 'general chat' });
  await handleMessage(makeChatPool(), client, {
    type: 'chat', content: 'issue talk', thread: { type: 'issue', ref: 12 },
  });

  assert.equal(notif.calls.sessionComment.length, 0, 'session threads only');
});

// ── The creator itself (real module, recording pool) ────────────────────

function makeCreatorPool({ ownerId }) {
  const seen = [];
  return {
    seen,
    inserts() { return seen.filter((q) => /INSERT INTO notifications/.test(q.sql)); },
    async query(sql, params) {
      seen.push({ sql, params });
      if (/SELECT user_id FROM chat_sessions/.test(sql)) {
        return { rows: ownerId ? [{ user_id: ownerId }] : [] };
      }
      if (/INSERT INTO notifications/.test(sql)) {
        return {
          rows: [{
            id: 88, user_id: params[0], app_id: params[1], session_id: params[2],
            chat_message_id: params[3], source_user_id: params[4],
            kind: 'session_comment', created_at: '2026-08-21T12:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  };
}

test('creator inserts one row addressed to the owner', async () => {
  const pool = makeCreatorPool({ ownerId: 4 });
  const rows = await notificationsReal.createSessionCommentNotification(pool, {
    appId: 7, sessionId: 55, chatMessageId: 4242, senderId: 9,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 4, 'addressed to the session owner');
  assert.equal(rows[0].kind, 'session_comment');
  const ins = pool.inserts()[0];
  assert.deepEqual(ins.params, [4, 7, 55, 4242, 9],
    'owner, app, session, comment, sender — in that order');
});

test('creator skips self-comments, pinged owners, and missing sessions', async () => {
  // Owner commenting on their own session → no row.
  let pool = makeCreatorPool({ ownerId: 9 });
  assert.deepEqual(await notificationsReal.createSessionCommentNotification(pool, {
    appId: 7, sessionId: 55, chatMessageId: 4242, senderId: 9,
  }), []);
  assert.equal(pool.inserts().length, 0, 'no insert for a self-comment');

  // Owner already pinged by a reply/mention on the same message → no row.
  pool = makeCreatorPool({ ownerId: 4 });
  assert.deepEqual(await notificationsReal.createSessionCommentNotification(pool, {
    appId: 7, sessionId: 55, chatMessageId: 4242, senderId: 9, excludeUserIds: [4],
  }), []);
  assert.equal(pool.inserts().length, 0, 'no insert when the owner is excluded');

  // Session not found for this app → no row.
  pool = makeCreatorPool({ ownerId: null });
  assert.deepEqual(await notificationsReal.createSessionCommentNotification(pool, {
    appId: 7, sessionId: 999, chatMessageId: 4242, senderId: 9,
  }), []);
  assert.equal(pool.inserts().length, 0, 'no insert for a missing session');
});

test('session_comment is a reviewed push kind and clears on message_sent', () => {
  assert.ok(ALLOWED_KINDS.has('session_comment'),
    'kind registered in the closed mobile-push policy');
  assert.ok(
    notificationsReal.ACTION_COMPLETIONS.message_sent.kinds.includes('session_comment'),
    'replying in the app clears unread session comments'
  );
});

// #194 follow-up, revised by the pre-promotion shared-session chat spec:
// posting a comment to a session thread is gated by validateThread()'s
// 'session' branch, whose predicate is now REACHABILITY rather than bare
// existence — the poster owns the session, OR the owner made it visible
// (shared_at), OR it was ever proposed to the group (promoted_at, or a
// promoted-or-later status). Two contracts are pinned here:
//
//   1. A MERGED proposal's thread stays postable (merging settles the
//      vote, not the conversation — the original #194 follow-up).
//   2. A private (never-shared, never-promoted) session's thread rejects
//      posts from anyone but its owner, so no client can write comments
//      into a thread no surface will ever render.
//
// ws.js requires the `ws` package at module load (not installed in this
// hermetic test env), so we intercept it via Module._load like the votes
// suites do.
//
// Run with: node --test tests/ws-validate-thread-merged.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadWs() {
  // ws.js's top-level requires must all resolve. The `ws` and
  // `jsonwebtoken` packages aren't installed in this hermetic env, so
  // intercept them; the local services are stubbed via require.cache.
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
  stub(ids.appAccess, {});

  delete require.cache[ids.subject];
  const ws = require('../src/services/ws');

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return ws;
}

// A pool whose session query evaluates the reachability predicate against
// one in-memory row, so the tests exercise the actual WHERE arms instead of
// echoing a canned answer. Any other query returns no rows.
function makeSessionPool(session) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (!/FROM chat_sessions/.test(sql)) return { rows: [] };
      const [id, appId, userId] = params;
      const match = session
        && session.id === id
        && session.app_id === appId
        && (session.user_id === userId
          || session.shared_at != null
          || session.promoted_at != null
          || ['promoted', 'merging', 'merged'].includes(session.status));
      return { rows: match ? [{ '?column?': 1 }] : [] };
    },
  };
}

test('validateThread accepts a session thread whose session is MERGED', async () => {
  const { validateThread } = loadWs();
  const pool = makeSessionPool({
    id: 55, app_id: 7, user_id: 1, shared_at: null, promoted_at: null, status: 'merged',
  });
  // Poster 99 is not the owner — the merged status alone must admit them.
  const result = await validateThread(pool, 7, { type: 'session', ref: 55 }, 99);
  assert.deepEqual(result, { type: 'session', ref: 55 }, 'merged session validates');

  const sessionQuery = pool.seen.find((q) => /FROM chat_sessions/.test(q.sql));
  assert.ok(sessionQuery, 'a chat_sessions reachability query ran');
  assert.match(sessionQuery.sql, /shared_at IS NOT NULL/, 'visibility arm present');
  assert.match(sessionQuery.sql, /promoted_at IS NOT NULL/, 'promotion-stamp arm present');
  assert.match(sessionQuery.sql, /'promoted', 'merging', 'merged'/, 'status arm keeps merged postable');
  assert.deepEqual(sessionQuery.params, [55, 7, 99], 'keyed on session id + app id + poster');
});

test('validateThread accepts a SHARED (visible, unpromoted) session for a non-owner', async () => {
  const { validateThread } = loadWs();
  const pool = makeSessionPool({
    id: 56, app_id: 7, user_id: 1,
    shared_at: '2026-08-21T09:29:51Z', promoted_at: null, status: 'active',
  });
  const result = await validateThread(pool, 7, { type: 'session', ref: 56 }, 99);
  assert.deepEqual(result, { type: 'session', ref: 56 },
    'a visible session is commentable BEFORE promotion');
});

test('validateThread accepts the OWNER on their own private session', async () => {
  const { validateThread } = loadWs();
  const pool = makeSessionPool({
    id: 57, app_id: 7, user_id: 5, shared_at: null, promoted_at: null, status: 'active',
  });
  const result = await validateThread(pool, 7, { type: 'session', ref: 57 }, 5);
  assert.deepEqual(result, { type: 'session', ref: 57 }, 'owner may post on a private session');
});

test('validateThread REJECTS a non-owner on a private, unpromoted session', async () => {
  const { validateThread } = loadWs();
  const pool = makeSessionPool({
    id: 57, app_id: 7, user_id: 5, shared_at: null, promoted_at: null, status: 'active',
  });
  const result = await validateThread(pool, 7, { type: 'session', ref: 57 }, 99);
  assert.equal(result, null,
    'a thread nobody can see accepts no posts — no black-hole comments');
});

test('validateThread accepts an ARCHIVED session that was once promoted', async () => {
  const { validateThread } = loadWs();
  // Archive after promotion clears neither promoted_at nor the discussion.
  const pool = makeSessionPool({
    id: 58, app_id: 7, user_id: 1,
    shared_at: null, promoted_at: '2026-08-20T01:48:54Z', status: 'archived',
  });
  const result = await validateThread(pool, 7, { type: 'session', ref: 58 }, 99);
  assert.deepEqual(result, { type: 'session', ref: 58 },
    'promoted_at keeps a since-archived proposal discussion postable');
});

test('validateThread rejects a session ref that does not exist for the app', async () => {
  const { validateThread } = loadWs();
  const pool = makeSessionPool(null); // no row → session not found for this app
  const result = await validateThread(pool, 7, { type: 'session', ref: 999 }, 5);
  assert.equal(result, null, 'nonexistent session is rejected');
});

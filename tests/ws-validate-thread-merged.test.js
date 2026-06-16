// #194 follow-up: posting a comment to a MERGED proposal's session thread
// must not be blocked. The only gate on a thread post is validateThread(),
// whose 'session' branch checks existence only — `SELECT 1 FROM
// chat_sessions WHERE id=$1 AND app_id=$2`, with NO status predicate. So a
// merged session validates exactly like an active one, and the WS handler
// inserts the comment.
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

// A pool that records the SQL it sees and returns `rows` for any query.
function makePool(rows) {
  const seen = [];
  return {
    seen,
    async query(sql, params) { seen.push({ sql, params }); return { rows }; },
  };
}

test('validateThread accepts a session thread whose session is MERGED', async () => {
  const { validateThread } = loadWs();
  // The existence check returns a row regardless of status — that's the
  // point: there is no status column in the predicate.
  const pool = makePool([{ '?column?': 1 }]);
  const result = await validateThread(pool, 7, { type: 'session', ref: 55 });
  assert.deepEqual(result, { type: 'session', ref: 55 }, 'merged session validates');

  const sessionQuery = pool.seen.find((q) => /FROM chat_sessions/.test(q.sql));
  assert.ok(sessionQuery, 'a chat_sessions existence query ran');
  assert.doesNotMatch(sessionQuery.sql, /status/, 'no status gate on the session check');
  assert.deepEqual(sessionQuery.params, [55, 7], 'keyed on session id + app id only');
});

test('validateThread rejects a session ref that does not exist for the app', async () => {
  const { validateThread } = loadWs();
  const pool = makePool([]); // no row → session not found for this app
  const result = await validateThread(pool, 7, { type: 'session', ref: 999 });
  assert.equal(result, null, 'nonexistent session is rejected');
});

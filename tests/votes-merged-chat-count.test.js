// #194 follow-up: GET /api/apps/:slug/merged must surface a per-proposal
// `chat_count` so the Completed list can render the 💬 badge. This suite
// drives the real route handler with a recording express Router and a
// stubbed pool, then asserts both that the SELECT asks for chat_count
// (scoped to thread_type='session' human messages) and that the response
// rows carry the field through.
//
// Same hermetic Module._load stubbing as votes-merge-failed-broadcast.
//
// Run with: node --test tests/votes-merged-chat-count.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// A recording Router: captures (method, path, handler) so the suite can
// invoke a single route in isolation.
function makeRecordingRouter(routes) {
  const record = (method) => (path, ...handlers) => {
    routes.push({ method, path, handler: handlers[handlers.length - 1] });
  };
  return { get: record('get'), post: record('post'), put: record('put'), delete: record('delete'), use() {} };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadVotes({ mergedRows }) {
  const routes = [];
  const ids = {
    express: 'express',
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    visuals: require.resolve('../src/services/visuals'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    orig[k] = require.cache[id];
  }

  const captured = { sql: [] };

  // express is a package — intercept via Module._load.
  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'express') return { Router: () => makeRecordingRouter(routes) };
    return _origLoad.call(this, request, ...rest);
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, {
    getPool: () => ({
      async query(sql) {
        captured.sql.push(sql);
        // The Completed stream now also queries applied close-issue
        // proposals (and their count) — answer those with nothing so the
        // suite keeps exercising the PR rows in isolation.
        if (/close_issue/.test(sql)) return { rows: [] };
        return { rows: mergedRows };
      },
    }),
  });
  stub(ids.github, { isEnabled: () => false });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, { broadcast() {}, getReactionsForMessages: async () => ({}) });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
    isUserActive: async () => true,
    listActiveUserIds: async () => [],
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, {
    getAppForUser: async () => ({ id: 1, slug: 'demo' }),
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.visuals, { shapeAgg: () => null });

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

  // restore
  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }

  return { routes, captured };
}

function findRoute(routes, method, path) {
  return routes.find((r) => r.method === method && r.path === path);
}

test('/merged SELECT asks for a session-scoped chat_count', () => {
  const { routes, captured } = loadVotes({ mergedRows: [] });
  const route = findRoute(routes, 'get', '/api/apps/:slug/merged');
  assert.ok(route, 'merged route registered');
  return route.handler(
    { params: { slug: 'demo' }, user: { id: 1 }, query: {} },
    { json() {}, status() { return { json() {} }; } }
  ).then(() => {
    const sql = captured.sql.join('\n');
    assert.match(sql, /as chat_count/, 'chat_count column selected');
    assert.match(sql, /thread_type = 'session'/, 'count scoped to the session thread');
    assert.match(sql, /msg_type = 'message'/, 'count limited to human messages');
  });
});

test('/merged response forwards chat_count on each row', async () => {
  const rows = [
    { id: 55, pr_number: 700, chat_count: 4, status: 'merged' },
    { id: 56, pr_number: 701, chat_count: 0, status: 'merged' },
  ];
  const { routes } = loadVotes({ mergedRows: rows });
  const route = findRoute(routes, 'get', '/api/apps/:slug/merged');
  let payload = null;
  await route.handler(
    { params: { slug: 'demo' }, user: { id: 1 }, query: {} },
    { json(p) { payload = p; }, status() { return { json() {} }; } }
  );
  assert.ok(payload && Array.isArray(payload.merged), 'merged array returned');
  assert.equal(payload.merged[0].chat_count, 4);
  assert.equal(payload.merged[1].chat_count, 0);
});

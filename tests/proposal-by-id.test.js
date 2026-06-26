// GET /api/apps/:slug/proposals/:id — the single-proposal fetch-on-demand
// recovery path. The Completed list is keyset-paginated, so a merged
// proposal beyond the first cached page can't be resolved from client
// state; the FE (_fetchProposalById) calls this endpoint to load just that
// one row in the SAME merged-shaped form the list returns, instead of
// bouncing back to the dev forum. This suite drives the real route handler
// with a recording express Router and a stubbed pool, asserting:
//   • a found proposal is returned under { proposal } with its row fields;
//   • the query is collab-gated, filters by app_id + id, and accepts
//     promoted/merging/merged;
//   • an unknown id 404s;
//   • a non-collaborator (gate returns null) 404s;
//   • under IS_STAGING + ?demo=1 a mock id resolves from the generators,
//     and a non-demo unknown id still 404s.
//
// Same hermetic Module._load stubbing as merged-pagination.
//
// Run with: node --test tests/proposal-by-id.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function makeRecordingRouter(routes) {
  const record = (method) => (path, ...handlers) => {
    routes.push({ method, path, handler: handlers[handlers.length - 1] });
  };
  return { get: record('get'), post: record('post'), put: record('put'), delete: record('delete'), use() {} };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// loadVotes wires the real votes route module against stubs. `row` is the
// merged-shaped row the by-id SELECT should return (null → not found in DB).
// `gateApp` is what appAccess.getAppForUser resolves to (null → no access).
// `staging` flips USERNODE_ENV to 'staging' before the module is required,
// so its module-load-time IS_STAGING const is true for the demo path.
function loadVotes({ row = null, gateApp = { id: 1, slug: 'demo' }, staging = false } = {}) {
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
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    visuals: require.resolve('../src/services/visuals'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    orig[k] = require.cache[id];
  }

  const captured = { calls: [] };

  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'express') return { Router: () => makeRecordingRouter(routes) };
    return _origLoad.call(this, request, ...rest);
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, {
    getPool: () => ({
      async query(sql, params) {
        captured.calls.push({ sql, params });
        // The by-id merged SELECT — return the configured row (or none).
        if (/cs\.id = \$3/.test(sql) && /cs\.status IN/.test(sql)) {
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
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
    getAppForUser: async () => gateApp,
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.topicAttrs, {
    summarizeForTargets: async () => new Map(),
    emptySummary: () => ({ priority: null, assignee: null }),
  });
  stub(ids.visuals, { shapeAgg: () => null });

  const prevEnv = process.env.USERNODE_ENV;
  if (staging) process.env.USERNODE_ENV = 'staging';
  else delete process.env.USERNODE_ENV;

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

  if (prevEnv === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;

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

async function callById(routes, { slug = 'demo', id, query = {} }) {
  const route = findRoute(routes, 'get', '/api/apps/:slug/proposals/:id');
  assert.ok(route, 'proposals/:id route registered');
  let payload = null;
  let statusCode = 200;
  await route.handler(
    { params: { slug, id: String(id) }, user: { id: 1 }, query },
    { json(p) { payload = p; }, status(c) { statusCode = c; return { json(p) { payload = p; } }; } }
  );
  return { payload, statusCode };
}

test('returns the merged-shaped row under { proposal }', async () => {
  const row = { id: 4242, pr_number: 88, pr_title: 'A merged proposal', status: 'merged', chat_count: 3, kudos_count: 1 };
  const { routes, captured } = loadVotes({ row });
  const { payload, statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 200);
  assert.ok(payload.proposal, 'proposal present');
  assert.equal(payload.proposal.id, 4242);
  assert.equal(payload.proposal.pr_number, 88);
  assert.equal(payload.proposal.chat_count, 3);
  // priority/assignee chips attached (empty summary from the stub).
  assert.ok('priority' in payload.proposal && 'assignee' in payload.proposal, 'attrs attached');

  const q = captured.calls.find((c) => /cs\.id = \$3/.test(c.sql));
  assert.ok(q, 'by-id query issued');
  assert.match(q.sql, /cs\.app_id = \$1 AND cs\.id = \$3/, 'filters by app + id');
  assert.match(q.sql, /cs\.status IN \('promoted', 'merging', 'merged'\)/, 'accepts active + merged');
  assert.deepEqual(q.params, [1, 1, 4242], 'app_id, userId, id bound');
});

test('unknown id 404s', async () => {
  const { routes } = loadVotes({ row: null });
  const { payload, statusCode } = await callById(routes, { id: 999999 });
  assert.equal(statusCode, 404);
  assert.match(payload.error, /not found/i);
});

test('non-collaborator (gate returns null) 404s without querying', async () => {
  const { routes, captured } = loadVotes({ gateApp: null });
  const { statusCode } = await callById(routes, { id: 4242 });
  assert.equal(statusCode, 404);
  assert.ok(!captured.calls.some((c) => /cs\.id = \$3/.test(c.sql)), 'no row query past the gate');
});

test('non-numeric id 404s', async () => {
  const { routes } = loadVotes({ row: null });
  const { statusCode } = await callById(routes, { id: 'abc' });
  assert.equal(statusCode, 404);
});

test('IS_STAGING + ?demo=1 resolves a mock merged id not in the DB', async () => {
  // 9100024 is a mock Completed row that never reaches the first page —
  // exactly the bug case. With demo=1 the by-id endpoint resolves it from
  // stagingMockMerged() so the discussion view can open on demand.
  const { routes } = loadVotes({ row: null, staging: true });
  const { payload, statusCode } = await callById(routes, { id: 9100024, query: { demo: '1' } });
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.id, 9100024);
  assert.equal(payload.proposal.status, 'merged');
});

test('IS_STAGING + ?demo=1 resolves a mock promoted id too', async () => {
  const { routes } = loadVotes({ row: null, staging: true });
  const { payload, statusCode } = await callById(routes, { id: 9000001, query: { demo: '1' } });
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.id, 9000001);
});

test('demo mock id without ?demo=1 still 404s', async () => {
  const { routes } = loadVotes({ row: null, staging: true });
  const { statusCode } = await callById(routes, { id: 9100024, query: {} });
  assert.equal(statusCode, 404);
});

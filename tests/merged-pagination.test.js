// #429: GET /api/apps/:slug/merged must paginate via a keyset cursor so the
// Completed list can reach every merged PR, not just the most recent 20.
// This suite drives the real route handler with a recording express Router
// and a stubbed pool, asserting:
//   • limit+1 is fetched and the look-ahead row is trimmed (hasMore=true);
//   • a clean last page reports hasMore=false;
//   • a `before`/`before_id` cursor adds the keyset predicate + binds it;
//   • a malformed cursor is ignored (newest page, no predicate);
//   • per-row fields survive paging.
//
// Same hermetic Module._load stubbing as votes-merged-chat-count.
//
// Run with: node --test tests/merged-pagination.test.js

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

// `makeRows(n)` produces n merged rows newest-first with distinct
// created_at + id so keyset paging is deterministic.
function makeRows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 1000 - i,
      pr_number: 500 - i,
      pr_title: `PR ${i}`,
      status: 'merged',
      chat_count: i % 2,
      kudos_count: 0,
      yes_count: 2,
      no_count: 0,
      created_at: new Date(Date.UTC(2026, 0, 100 - i)).toISOString(),
    });
  }
  return out;
}

function loadVotes({ mergedRows, total }) {
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
        // #433: the column-total COUNT (no `cs.` alias) — answer it before
        // the per-row merged SELECT so the two don't collide.
        if (/COUNT\(\*\)::int AS total/.test(sql)) {
          return { rows: [{ total: typeof total === 'number' ? total : mergedRows.length }] };
        }
        // Only the merged SELECT returns rows; the topic-attrs query (and
        // anything else) returns empty.
        if (/cs\.status = 'merged'/.test(sql)) return { rows: mergedRows.slice() };
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
    getAppForUser: async () => ({ id: 1, slug: 'demo' }),
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.topicAttrs, {
    summarizeForTargets: async () => new Map(),
    emptySummary: () => ({ priority: null, assignee: null }),
  });
  stub(ids.visuals, { shapeAgg: () => null });

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

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

async function callMerged(routes, captured, query) {
  const route = findRoute(routes, 'get', '/api/apps/:slug/merged');
  assert.ok(route, 'merged route registered');
  let payload = null;
  let statusCode = 200;
  await route.handler(
    { params: { slug: 'demo' }, user: { id: 1 }, query },
    { json(p) { payload = p; }, status(c) { statusCode = c; return { json(p) { payload = p; } }; } }
  );
  return { payload, statusCode };
}

test('default page fetches limit+1, trims look-ahead row, reports hasMore', async () => {
  // 21 rows available, default limit 20 → 20 returned + hasMore true.
  const { routes, captured } = loadVotes({ mergedRows: makeRows(21) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged.length, 20, 'page trimmed to limit');
  assert.equal(payload.hasMore, true, 'more pages flagged');
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  assert.match(mergedCall.sql, /ORDER BY cs\.created_at DESC, cs\.id DESC/, 'tiebreak ordering');
  // limit+1 (=21) bound as the LIMIT param on the no-cursor path ($3).
  assert.equal(mergedCall.params[mergedCall.params.length - 1], 21, 'limit+1 bound');
  assert.ok(!/cs\.created_at, cs\.id\) </.test(mergedCall.sql), 'no cursor predicate on first page');
});

test('last page reports hasMore=false', async () => {
  // Exactly 20 rows available, limit 20 → no look-ahead row.
  const { routes, captured } = loadVotes({ mergedRows: makeRows(20) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged.length, 20);
  assert.equal(payload.hasMore, false, 'no more pages');
});

test('limit is honored and clamped to 50', async () => {
  let { routes, captured } = loadVotes({ mergedRows: makeRows(10) });
  let { payload } = await callMerged(routes, captured, { limit: '5' });
  assert.equal(payload.merged.length, 5, 'custom limit applied');
  assert.equal(payload.hasMore, true);

  ({ routes, captured } = loadVotes({ mergedRows: makeRows(60) }));
  await callMerged(routes, captured, { limit: '999' });
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  // clamp(999) -> 50, fetched as 51.
  assert.equal(mergedCall.params[mergedCall.params.length - 1], 51, 'limit clamped to 50 (+1)');
});

test('before/before_id cursor adds keyset predicate and binds it', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(5) });
  const cursor = '2026-01-50T00:00:00.000Z';
  await callMerged(routes, captured, { before: '2026-01-30T00:00:00.000Z', before_id: '900' });
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  assert.match(mergedCall.sql, /\(cs\.created_at, cs\.id\) < \(\$3, \$4\)/, 'keyset predicate present');
  assert.match(mergedCall.sql, /LIMIT \$5/, 'limit bound after cursor params');
  assert.equal(mergedCall.params[2], new Date('2026-01-30T00:00:00.000Z').toISOString(), 'before bound');
  assert.equal(mergedCall.params[3], 900, 'before_id bound');
  // cursor variable only referenced to keep lints quiet about intent
  assert.ok(cursor);
});

test('malformed cursor is ignored — newest page, no predicate', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(3) });
  const { payload } = await callMerged(routes, captured, { before: 'not-a-date', before_id: 'x' });
  assert.equal(payload.merged.length, 3);
  const mergedCall = captured.calls.find((c) => /cs\.status = 'merged'/.test(c.sql));
  assert.ok(!/\(cs\.created_at, cs\.id\) </.test(mergedCall.sql), 'no cursor predicate for bad cursor');
});

test('#433: returns a numeric `total` independent of limit and cursor', async () => {
  // 47 merged sessions exist; the first page returns 20 rows but total=47
  // so the Kanban Done badge can show the real count, not the page size.
  let { routes, captured } = loadVotes({ mergedRows: makeRows(21), total: 47 });
  let { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged.length, 20, 'first page still trimmed to limit');
  assert.equal(payload.total, 47, 'total reflects the whole column, not the page');
  const countCall = captured.calls.find((c) => /COUNT\(\*\)::int AS total/.test(c.sql));
  assert.ok(countCall, 'a COUNT query was issued for the total');
  assert.ok(!/\(cs\.created_at, cs\.id\) </.test(countCall.sql), 'total COUNT carries no cursor predicate');
  assert.ok(!/LEFT JOIN/.test(countCall.sql), 'total COUNT omits the revert LEFT JOIN');

  // A second page (cursor set, smaller limit) reports the SAME total.
  ({ routes, captured } = loadVotes({ mergedRows: makeRows(5), total: 47 }));
  ({ payload } = await callMerged(routes, captured, { before: '2026-01-30T00:00:00.000Z', before_id: '900', limit: '5' }));
  assert.equal(payload.total, 47, 'total is stable across pages');
});

test('per-row fields survive paging', async () => {
  const { routes, captured } = loadVotes({ mergedRows: makeRows(2) });
  const { payload } = await callMerged(routes, captured, {});
  assert.equal(payload.merged[0].pr_number, 500);
  assert.equal(payload.merged[0].chat_count, 0);
  assert.equal(payload.merged[1].chat_count, 1);
});

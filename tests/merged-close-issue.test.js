// Applied close-issue proposals join GET /api/apps/:slug/merged as a second
// row type (row_type='close_issue') interleaved with merged PRs. This suite
// drives the real route handler with a recording express Router and a
// stubbed pool (same hermetic Module._load harness as
// merged-pagination.test.js), asserting:
//   • the close-issue query targets ONLY applied proposals
//     (kind='close_issue' AND status='closed' AND payload ? 'appliedAt' —
//     withdrawn/superseded rows never carry appliedAt, so they stay out);
//   • rows come back tagged row_type 'pr' / 'close_issue' and interleave by
//     created_at DESC, with PR ranking first on a timestamp tie;
//   • close-row fields (payload snapshot, author, tallies, chat_count)
//     survive to the response;
//   • `total` = merged-PR count + applied-close count;
//   • the three-part cursor: no before_type defaults to 'pr' (PR keeps the
//     historical tuple predicate, close pages <=), and
//     before_type=close_issue flips the shapes (PR pages <, close tuple);
//   • hasMore reflects the combined stream.
//
// Run with: node --test tests/merged-close-issue.test.js

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

// n merged PR rows, newest-first, distinct created_at + id.
function makePrRows(n, { startDay = 100 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 1000 - i,
      pr_number: 500 - i,
      pr_title: `PR ${i}`,
      status: 'merged',
      chat_count: 0,
      created_at: new Date(Date.UTC(2026, 0, startDay - i)).toISOString(),
    });
  }
  return out;
}

// One applied close-issue row (issues-table shape the route selects).
function makeCloseRow(over) {
  return {
    id: 77,
    kind: 'close_issue',
    status: 'closed',
    title: 'Close issue #12: "Broken thing"',
    description: 'Obsolete since the rework.',
    payload: {
      issueNumber: 12,
      issueTitle: 'Broken thing',
      reason: 'Obsolete since the rework.',
      appliedAt: '2026-01-15T00:00:00.000Z',
      appliedBy: 'group-vote',
      upCount: 2,
      required: 2,
    },
    github_issue_number: null,
    created_by: 3,
    created_by_username: 'casey',
    created_at: new Date(Date.UTC(2026, 0, 98, 12)).toISOString(),
    up_count: 2,
    down_count: 0,
    chat_count: 4,
    last_message_at: null,
    ...over,
  };
}

function loadVotes({ prRows, closeRows, prTotal, closeTotal }) {
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
        // Order matters: the close-count SQL also mentions close_issue.
        if (/AS close_total/.test(sql)) {
          return { rows: [{ close_total: typeof closeTotal === 'number' ? closeTotal : (closeRows || []).length }] };
        }
        if (/COUNT\(\*\)::int AS total/.test(sql)) {
          return { rows: [{ total: typeof prTotal === 'number' ? prTotal : (prRows || []).length }] };
        }
        if (/cs\.status = 'merged'/.test(sql)) return { rows: (prRows || []).slice() };
        if (/i\.kind = 'close_issue'/.test(sql)) return { rows: (closeRows || []).slice() };
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
    summarizeForProposals: async () => new Map(),
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

async function callMerged(routes, query) {
  const route = routes.find((r) => r.method === 'get' && r.path === '/api/apps/:slug/merged');
  assert.ok(route, 'merged route registered');
  let payload = null;
  await route.handler(
    { params: { slug: 'demo' }, user: { id: 1 }, query },
    { json(p) { payload = p; }, status() { return { json(p) { payload = p; } }; } }
  );
  return payload;
}

function findCall(captured, re) {
  return captured.calls.find((c) => re.test(c.sql));
}

test('close-issue query selects ONLY applied proposals (appliedAt marker)', async () => {
  const { routes, captured } = loadVotes({ prRows: [], closeRows: [] });
  await callMerged(routes, {});
  const closeCall = findCall(captured, /i\.kind = 'close_issue'/);
  assert.ok(closeCall, 'close-issue rows query issued');
  assert.match(closeCall.sql, /i\.status = 'closed'/, 'closed rows only');
  assert.match(closeCall.sql, /i\.payload \? 'appliedAt'/, 'applied marker required — withdrawn/superseded rows excluded');
  assert.match(closeCall.sql, /ORDER BY i\.created_at DESC, i\.id DESC/, 'same tiebreak ordering as PRs');
});

test('rows interleave by created_at DESC with row_type discriminators', async () => {
  // PRs on Jan 100/99/98(midnight); close row at Jan 98 12:00 → slots
  // between the Jan 99 and Jan 98 PRs.
  const prRows = makePrRows(3);
  const closeRows = [makeCloseRow()];
  const { routes } = loadVotes({ prRows, closeRows });
  const payload = await callMerged(routes, {});
  assert.equal(payload.merged.length, 4);
  assert.deepEqual(
    payload.merged.map((r) => r.row_type),
    ['pr', 'pr', 'close_issue', 'pr'],
    'close row interleaved by timestamp'
  );
  const close = payload.merged[2];
  assert.equal(close.id, 77);
  assert.equal(close.payload.appliedBy, 'group-vote');
  assert.equal(close.payload.issueNumber, 12);
  assert.equal(close.created_by_username, 'casey');
  assert.equal(close.up_count, 2);
  assert.equal(close.chat_count, 4);
});

test('on a created_at tie, PR rows rank before close-issue rows', async () => {
  const ts = new Date(Date.UTC(2026, 0, 50)).toISOString();
  const prRows = [{ id: 5, pr_number: 9, status: 'merged', created_at: ts }];
  const closeRows = [makeCloseRow({ id: 900, created_at: ts })];
  const { routes } = loadVotes({ prRows, closeRows });
  const payload = await callMerged(routes, {});
  assert.deepEqual(payload.merged.map((r) => r.row_type), ['pr', 'close_issue']);
});

test('total sums merged PRs and applied close-issue proposals', async () => {
  const { routes, captured } = loadVotes({
    prRows: makePrRows(2), closeRows: [makeCloseRow()], prTotal: 47, closeTotal: 3,
  });
  const payload = await callMerged(routes, {});
  assert.equal(payload.total, 50, 'total = 47 PRs + 3 applied closes');
  const closeCount = findCall(captured, /AS close_total/);
  assert.match(closeCount.sql, /payload \? 'appliedAt'/, 'count uses the applied predicate too');
});

test('hasMore reflects the combined stream and trims to limit', async () => {
  // 19 PRs + 3 close rows = 22 combined > default limit 20.
  const { routes } = loadVotes({
    prRows: makePrRows(19),
    closeRows: [
      makeCloseRow({ id: 71, created_at: new Date(Date.UTC(2026, 0, 97, 6)).toISOString() }),
      makeCloseRow({ id: 72, created_at: new Date(Date.UTC(2026, 0, 96, 6)).toISOString() }),
      makeCloseRow({ id: 73, created_at: new Date(Date.UTC(2026, 0, 95, 6)).toISOString() }),
    ],
  });
  const payload = await callMerged(routes, {});
  assert.equal(payload.merged.length, 20, 'page trimmed to limit');
  assert.equal(payload.hasMore, true, 'look-ahead rows flag another page');
});

test('cursor without before_type defaults to pr: PR keeps the tuple predicate, close pages <=', async () => {
  const { routes, captured } = loadVotes({ prRows: [], closeRows: [] });
  await callMerged(routes, { before: '2026-01-30T00:00:00.000Z', before_id: '900' });
  const prCall = findCall(captured, /cs\.status = 'merged'/);
  assert.match(prCall.sql, /\(cs\.created_at, cs\.id\) < \(\$3, \$4\)/, 'historical PR tuple predicate');
  assert.match(prCall.sql, /LIMIT \$5/);
  const closeCall = findCall(captured, /i\.kind = 'close_issue'/);
  assert.match(closeCall.sql, /i\.created_at <= \$2/, 'close rows at the PR-cursor timestamp sort after it');
  assert.ok(!/\(i\.created_at, i\.id\)/.test(closeCall.sql), 'no close tuple predicate at a PR cursor');
  assert.equal(closeCall.params[1], new Date('2026-01-30T00:00:00.000Z').toISOString());
});

test('before_type=close_issue flips the predicates: PR pages strictly older, close uses its tuple', async () => {
  const { routes, captured } = loadVotes({ prRows: [], closeRows: [] });
  await callMerged(routes, {
    before: '2026-01-30T00:00:00.000Z', before_id: '77', before_type: 'close_issue',
  });
  const prCall = findCall(captured, /cs\.status = 'merged'/);
  assert.match(prCall.sql, /cs\.created_at < \$3/, 'PRs at the close-cursor timestamp already paged out');
  assert.ok(!/\(cs\.created_at, cs\.id\) </.test(prCall.sql), 'no PR tuple predicate at a close cursor');
  const closeCall = findCall(captured, /i\.kind = 'close_issue'/);
  assert.match(closeCall.sql, /\(i\.created_at, i\.id\) < \(\$2, \$3\)/, 'close tuple predicate');
  assert.equal(closeCall.params[2], 77, 'before_id bound for the close source');
});

test('no cursor → neither source carries a keyset predicate', async () => {
  const { routes, captured } = loadVotes({ prRows: makePrRows(1), closeRows: [makeCloseRow()] });
  const payload = await callMerged(routes, {});
  assert.equal(payload.hasMore, false);
  const prCall = findCall(captured, /cs\.status = 'merged'/);
  assert.ok(!/\(cs\.created_at, cs\.id\) </.test(prCall.sql));
  assert.ok(!/cs\.created_at < \$3/.test(prCall.sql));
  const closeCall = findCall(captured, /i\.kind = 'close_issue'/);
  assert.ok(!/i\.created_at <=/.test(closeCall.sql));
});

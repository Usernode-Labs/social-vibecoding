// #639: a proposal's priority/assignee chips must inherit the linked
// issue's community-voted values when the proposal has no votes of its own,
// so the chips survive the issue → proposal (proposed for voting) → merged
// (done) lifecycle instead of resetting to "Set priority" / "Unassigned".
//
// Drives the real GET /api/apps/:slug/proposals/:id handler (the shared
// single-row path that also mirrors the /promoted + /merged enrichment)
// with a stubbed pool + a topic-attributes stub that returns DIFFERENT
// summaries for the 'proposal' target vs the 'issue' target — while keeping
// the REAL applyIssueFallback / emptySummary so the merge logic is exercised
// end to end. Same hermetic Module._load stubbing as proposal-by-id.
//
// Run with: node --test tests/proposal-issue-attr-inheritance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// The real service — we pass its pure helpers through the stub so the route
// runs the genuine per-field fallback, only faking the DB-backed summarize.
const realAttrs = require('../src/services/topic-attributes');

function makeRecordingRouter(routes) {
  const record = (method) => (path, ...handlers) => {
    routes.push({ method, path, handler: handlers[handlers.length - 1] });
  };
  return { get: record('get'), post: record('post'), put: record('put'), delete: record('delete'), use() {} };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// `row` is the merged-shaped proposal row (must carry linked_issues /
// created_from_issue_number). `proposalSummary` / `issueSummary` are the
// summaries summarizeForTargets returns for the 'proposal' and 'issue'
// targets respectively.
function loadVotes({ row, proposalSummary, issueSummary }) {
  const routes = [];
  const ids = {
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
  for (const id of Object.values(ids)) orig[id] = require.cache[id];

  const captured = { calls: [], summarizeCalls: [] };

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
    getAppForUser: async () => ({ id: 1, slug: 'demo' }),
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  // Fake ONLY the DB-backed summarize; pass the real pure helpers through so
  // applyLinkedIssueAttrs runs the genuine per-field merge.
  stub(ids.topicAttrs, {
    summarizeForTargets: async (pool, appId, targetType, refs) => {
      captured.summarizeCalls.push({ targetType, refs: [...refs] });
      const m = new Map();
      const summary = targetType === 'issue' ? issueSummary : proposalSummary;
      for (const ref of refs) m.set(ref, summary || realAttrs.emptySummary());
      return m;
    },
    emptySummary: realAttrs.emptySummary,
    applyIssueFallback: realAttrs.applyIssueFallback,
  });
  stub(ids.visuals, { shapeAgg: () => null });

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [id, mod] of Object.entries(orig)) {
    if (mod) require.cache[id] = mod; else delete require.cache[id];
  }
  return { routes, captured };
}

async function callById(routes, id) {
  const route = routes.find((r) => r.method === 'get' && r.path === '/api/apps/:slug/proposals/:id');
  assert.ok(route, 'proposals/:id route registered');
  let payload = null;
  let statusCode = 200;
  await route.handler(
    { params: { slug: 'demo', id: String(id) }, user: { id: 1 }, query: {} },
    { json(p) { payload = p; }, status(c) { statusCode = c; return { json(p) { payload = p; } }; } }
  );
  return { payload, statusCode };
}

const F = (top, count = top ? 1 : 0, myValue = null) => ({ top, count, myValue });

test('proposal with no own votes inherits the linked issue chips', async () => {
  const row = { id: 4242, status: 'merged', linked_issues: [77], created_from_issue_number: null };
  const { routes, captured } = loadVotes({
    row,
    proposalSummary: realAttrs.emptySummary(),
    issueSummary: { priority: F('high', 4), assignee: F('alice', 3) },
  });
  const { payload, statusCode } = await callById(routes, 4242);
  assert.equal(statusCode, 200);
  assert.equal(payload.proposal.priority.top, 'high', 'inherited priority');
  assert.equal(payload.proposal.priority.count, 4);
  assert.equal(payload.proposal.assignee.top, 'alice', 'inherited assignee');

  // The primary-issue summarize was over issue number 77 (from linked_issues).
  const issueCall = captured.summarizeCalls.find((c) => c.targetType === 'issue');
  assert.ok(issueCall, 'issue summarize issued');
  assert.deepEqual(issueCall.refs, [77]);
});

test('created_from_issue_number wins over linked_issues as the source', async () => {
  const row = { id: 4243, status: 'promoted', linked_issues: [10, 20], created_from_issue_number: 55 };
  const { routes, captured } = loadVotes({
    row,
    proposalSummary: realAttrs.emptySummary(),
    issueSummary: { priority: F('low', 1), assignee: F(null) },
  });
  const { payload } = await callById(routes, 4243);
  assert.equal(payload.proposal.priority.top, 'low');
  const issueCall = captured.summarizeCalls.find((c) => c.targetType === 'issue');
  assert.ok(issueCall, 'issue summarize issued');
  assert.deepEqual(issueCall.refs, [55], 'created_from_issue_number is the source, not linked_issues');
});

test('a direct proposal vote overrides the inherited issue value (per field)', async () => {
  const row = { id: 4244, status: 'merged', linked_issues: [77], created_from_issue_number: null };
  const { routes } = loadVotes({
    row,
    // Proposal has its OWN priority vote but no assignee vote.
    proposalSummary: { priority: F('medium', 2), assignee: F(null) },
    issueSummary: { priority: F('high', 9), assignee: F('alice', 3) },
  });
  const { payload } = await callById(routes, 4244);
  assert.equal(payload.proposal.priority.top, 'medium', 'own proposal priority wins');
  assert.equal(payload.proposal.priority.count, 2);
  assert.equal(payload.proposal.assignee.top, 'alice', 'assignee still inherits');
});

test('no linked issue → chips stay empty', async () => {
  const row = { id: 4245, status: 'merged', linked_issues: [], created_from_issue_number: null };
  const { routes, captured } = loadVotes({
    row,
    proposalSummary: realAttrs.emptySummary(),
    issueSummary: { priority: F('high', 9), assignee: F('alice', 3) },
  });
  const { payload } = await callById(routes, 4245);
  assert.equal(payload.proposal.priority.top, null);
  assert.equal(payload.proposal.assignee.top, null);
  assert.ok(!captured.summarizeCalls.some((c) => c.targetType === 'issue'), 'no issue summarize when nothing to inherit');
});

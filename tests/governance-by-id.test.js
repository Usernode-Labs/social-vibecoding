// (#1115) GET /api/apps/:slug/governance/:id — the by-id recovery path for
// opening a governance proposal whose row isn't in any cached client list.
// The list endpoint returns OPEN rows only and applied close-issue proposals
// live in the keyset-paginated Completed stream, so without this endpoint
// every settled close proposal beyond the first page was unresolvable.
//
// Drives the real route handler with a recording express Router and a stubbed
// pool (the same hermetic Module._load harness as merged-close-issue.test.js),
// asserting:
//   • the app gate 404s (no leak for an app the viewer can't see);
//   • a non-numeric id 404s before any query;
//   • the query is scoped to (app_id, id) and to the four governance kinds,
//     with NO status predicate (settled rows must resolve);
//   • my_vote is parameterised on the viewer, resolving null for anonymous;
//   • an applied close row comes back stamped row_type='close_issue' with its
//     payload / tallies / chat_count intact;
//   • a secret_change row's ciphertext is stripped and hasValue set;
//   • the computed gate fields ride along;
//   • the ?demo=1 staging fallback resolves mock ids (including 9100062, the
//     applied-close mock that can never reach the demo Completed page), while
//     production-mode 404s for the same id.
//
// Run with: node --test tests/governance-by-id.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function makeRecordingRouter(routes) {
  const record = (method) => (path, ...handlers) => {
    routes.push({ method, path, handler: handlers[handlers.length - 1] });
  };
  return {
    get: record('get'), post: record('post'), put: record('put'),
    patch: record('patch'), delete: record('delete'), use() {},
  };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// One governance row in the shape the route's SELECT produces.
function makeRow(over) {
  return {
    id: 4242,
    app_id: 1,
    kind: 'close_issue',
    title: 'Close issue #12: "Broken thing"',
    description: 'Obsolete since the rework.',
    status: 'closed',
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
    created_at: '2026-01-10T00:00:00.000Z',
    up_count: 2,
    down_count: 0,
    my_vote: null,
    chat_count: 4,
    last_message_at: null,
    ...over,
  };
}

// `staging` flips the module-level IS_STAGING (read at require time from
// USERNODE_ENV), so each load gets the environment the test needs.
function loadIssues({ row = null, gatedApp = { id: 1, slug: 'demo' }, staging = false } = {}) {
  const routes = [];
  const ids = {
    express: 'express',
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    platformEnv: require.resolve('../src/services/platform-env'),
    stagingSvc: require.resolve('../src/services/staging'),
    secrets: require.resolve('../src/services/secrets'),
    rateLimits: require.resolve('../src/middleware/rate-limits'),
    events: require.resolve('../src/services/events'),
    kudos: require.resolve('../src/routes/kudos'),
    bounties: require.resolve('../src/services/bounties'),
    appAccess: require.resolve('../src/services/app-access'),
    appAdmins: require.resolve('../src/services/app-admins'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    llm: require.resolve('../src/services/llm'),
    governance: require.resolve('../src/services/governance'),
    subject: require.resolve('../src/routes/issues'),
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
        if (/FROM issues i/.test(sql) && /i\.id = \$2/.test(sql)) {
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      },
    }),
  });
  stub(ids.github, { isEnabled: () => false });
  stub(ids.ws, {
    sendSystemMessage() {}, pushAppUpdate() {}, pushIssueUpdate() {}, broadcast() {},
  });
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 3, majority: 2 }) });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminUpVote: async () => false });
  stub(ids.appManifest, {});
  stub(ids.appSecrets, {});
  stub(ids.platformEnv, {});
  stub(ids.stagingSvc, {});
  stub(ids.secrets, { encrypt: (v) => v, decrypt: (v) => v });
  stub(ids.rateLimits, { issueKindLimiter: (req, res, next) => next() });
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.kudos, {
    weekStartUtc: () => new Date(0), countWeeklyAllowanceUsed: async () => 0,
    WEEKLY_KUDOS_LIMIT: 5,
  });
  stub(ids.bounties, { placeBounty: async () => {} });
  stub(ids.appAccess, {
    getAppForUser: async () => gatedApp,
    issueCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.appAdmins, { isAppAdmin: async () => false });
  stub(ids.topicAttrs, {
    summarizeForTargets: async () => new Map(),
    summarizeForProposals: async () => new Map(),
    emptySummary: () => ({ priority: null, assignee: null }),
  });
  stub(ids.llm, { FEEDBACK_FALLBACK_TITLE: 'Feedback' });
  stub(ids.governance, {
    getGovernance: async () => ({}),
    getElectorate: async () => ({ active: 3, approverIds: null }),
    qualifiedCountsBatch: async () => new Map(),
    computeGate: () => ({
      required: 2,
      windowEndsAt: '2026-01-12T00:00:00.000Z',
      contested: false,
      policy: 'default',
      approvalsRequired: null,
      qualifiedYes: 2,
      qualifiedNo: 0,
    }),
  });

  const prevEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = staging ? 'staging' : 'production';

  delete require.cache[ids.subject];
  const { issueRoutes } = require('../src/routes/issues');
  issueRoutes({});

  if (prevEnv === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    // `governance` is require()d from INSIDE the handler (lazily, like the
    // ./votes require the demo fallback uses), so its stub has to survive
    // past module load — the handler resolves it when a test calls it, not
    // now. Left installed for the lifetime of this file's process; each
    // loadIssues() re-installs it, and node --test isolates per file.
    if (k === 'governance') continue;
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }

  return { routes, captured };
}

async function callGov(routes, { id, query = {}, user = { id: 7 } } = {}) {
  const route = routes.find(
    (r) => r.method === 'get' && r.path === '/api/apps/:slug/governance/:id'
  );
  assert.ok(route, 'governance-by-id route registered');
  let payload = null; let code = 200;
  await route.handler(
    { params: { slug: 'demo', id: String(id) }, user, query },
    {
      json(p) { payload = p; return this; },
      status(c) { code = c; return { json(p) { payload = p; } }; },
    }
  );
  return { payload, code };
}

test('an app the viewer cannot see 404s', async () => {
  const { routes, captured } = loadIssues({ gatedApp: null, row: makeRow() });
  const { code, payload } = await callGov(routes, { id: 4242 });
  assert.equal(code, 404);
  assert.equal(payload.error, 'App not found');
  assert.equal(captured.calls.length, 0, 'gate short-circuits before any query');
});

test('a non-numeric id 404s without querying', async () => {
  const { routes, captured } = loadIssues({ row: makeRow() });
  const { code, payload } = await callGov(routes, { id: 'nope' });
  assert.equal(code, 404);
  assert.equal(payload.error, 'Proposal not found');
  assert.equal(captured.calls.length, 0, 'no query issued for a bad id');
});

test('the query is scoped to the app, the id, and the governance kinds only', async () => {
  const { routes, captured } = loadIssues({ row: makeRow() });
  await callGov(routes, { id: 4242 });
  const call = captured.calls.find((c) => /FROM issues i/.test(c.sql));
  assert.ok(call, 'row query issued');
  assert.match(call.sql, /i\.app_id = \$1 AND i\.id = \$2/, 'scoped to (app_id, id)');
  for (const kind of ['secret_change', 'rename', 'close_issue', 'maintenance_campaign']) {
    assert.match(call.sql, new RegExp(`'${kind}'`), `${kind} is servable`);
  }
  assert.doesNotMatch(
    call.sql, /i\.status\s*=/,
    'NO status predicate — a settled close proposal is the whole point'
  );
  assert.match(call.sql, /msg_type = 'message'/, 'chat_count counts human messages only');
  assert.deepEqual(call.params, [1, 4242, 7], 'app id, row id, viewer id');
});

test('an anonymous viewer resolves my_vote as null (view-level access)', async () => {
  const { routes, captured } = loadIssues({ row: makeRow() });
  await callGov(routes, { id: 4242, user: null });
  const call = captured.calls.find((c) => /FROM issues i/.test(c.sql));
  assert.equal(call.params[2], null, 'null viewer id, not a crash');
});

test('an applied close row comes back stamped row_type with its payload intact', async () => {
  const { routes } = loadIssues({ row: makeRow() });
  const { code, payload } = await callGov(routes, { id: 4242 });
  assert.equal(code, 200);
  const p = payload.proposal;
  assert.equal(p.row_type, 'close_issue', 'interchangeable with the /merged shape');
  assert.equal(p.id, 4242);
  assert.equal(p.status, 'closed');
  assert.equal(p.payload.appliedBy, 'group-vote');
  assert.equal(p.payload.issueNumber, 12);
  assert.equal(p.created_by_username, 'casey');
  assert.equal(p.up_count, 2);
  assert.equal(p.chat_count, 4);
});

test('an OPEN close row carries no row_type stamp', async () => {
  const { routes } = loadIssues({
    row: makeRow({
      status: 'open',
      payload: { issueNumber: 12, reason: 'Still up for vote.' },
    }),
  });
  const { payload } = await callGov(routes, { id: 4242 });
  assert.equal(payload.proposal.row_type, undefined, 'not a Completed-stream row');
});

test('the computed gate fields ride along', async () => {
  const { routes } = loadIssues({ row: makeRow({ status: 'open' }) });
  const { payload } = await callGov(routes, { id: 4242 });
  const p = payload.proposal;
  assert.equal(p.votes_required, 2);
  assert.equal(p.merge_window_ends_at, '2026-01-12T00:00:00.000Z');
  assert.equal(p.contested, false);
  assert.equal(p.approval_policy, 'default');
  assert.equal(p.qualified_yes_count, 2);
  assert.equal(p.qualified_no_count, 0);
});

test('a secret_change row never leaks its ciphertext', async () => {
  const { routes } = loadIssues({
    row: makeRow({
      kind: 'secret_change',
      status: 'open',
      payload: { key: 'STRIPE_SECRET_KEY', action: 'set', valueEnc: 'ciphertext-here' },
    }),
  });
  const { payload } = await callGov(routes, { id: 4242 });
  assert.equal(payload.proposal.payload.valueEnc, undefined, 'stripped');
  assert.equal(payload.proposal.payload.hasValue, true, 'presence still reported');
  assert.equal(payload.proposal.payload.key, 'STRIPE_SECRET_KEY');
  assert.doesNotMatch(JSON.stringify(payload), /ciphertext-here/, 'nowhere in the body');
});

test('a row the DB does not have 404s', async () => {
  const { routes } = loadIssues({ row: null });
  const { code, payload } = await callGov(routes, { id: 999999 });
  assert.equal(code, 404);
  assert.equal(payload.error, 'Proposal not found');
});

test('?demo=1 on staging resolves the beyond-the-page applied-close mock 9100062', async () => {
  const { routes } = loadIssues({ row: null, staging: true });
  const { code, payload } = await callGov(routes, { id: 9100062, query: { demo: '1' } });
  assert.equal(code, 200, 'the mock resolves through the by-id path');
  assert.equal(payload.proposal.id, 9100062);
  assert.equal(payload.proposal.row_type, 'close_issue');
  assert.equal(payload.proposal.payload.appliedBy, 'group-vote');
  assert.ok(payload.proposal.payload.appliedAt, 'applied — renders the settled pill');
});

test('?demo=1 on staging also resolves the first-page and open governance mocks', async () => {
  const { routes } = loadIssues({ row: null, staging: true });
  for (const id of [9100060, 9100061]) {
    const { code, payload } = await callGov(routes, { id, query: { demo: '1' } });
    assert.equal(code, 200, `applied-close mock ${id} resolves`);
    assert.equal(payload.proposal.id, id);
  }
  const { code, payload } = await callGov(routes, { id: 9100003, query: { demo: '1' } });
  assert.equal(code, 200, 'open governance mock resolves');
  assert.equal(payload.proposal.kind, 'close_issue');
  assert.equal(payload.proposal.status, 'open');
});

test('the demo fallback is a strict no-op in production', async () => {
  const { routes } = loadIssues({ row: null, staging: false });
  const { code } = await callGov(routes, { id: 9100062, query: { demo: '1' } });
  assert.equal(code, 404, 'mock ids never resolve outside staging');
});

test('staging without ?demo=1 does not serve mocks either', async () => {
  const { routes } = loadIssues({ row: null, staging: true });
  const { code } = await callGov(routes, { id: 9100062 });
  assert.equal(code, 404);
});

test('a real DB row always wins over a same-id mock', async () => {
  const { routes } = loadIssues({
    row: makeRow({ id: 9100062, title: 'Real row' }), staging: true,
  });
  const { payload } = await callGov(routes, { id: 9100062, query: { demo: '1' } });
  assert.equal(payload.proposal.title, 'Real row');
});

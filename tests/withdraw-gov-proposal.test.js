// Tests for the creator-gated governance withdraw — POST /api/issues/:id/close
// in src/routes/issues.js (repurposed from the old unguarded close route).
//
// A governance proposal may be withdrawn only by its creator
// (issues.created_by === req.user.id). The route checks that, then hands the
// withdrawal to the governance machine (src/workflow/platform.ts
// withdrawProposal), which decides it under the row lock and answers; its
// own behaviour (audit keys, the thread line, the twin close as work, an
// already-closed proposal) is pinned by tests/workflow-governance-postgres
// and tests/workflow-governance-routes-postgres.
//
// We stub getPool (db/pool), the ws collaborators and the workflow module,
// then drive the POST handler directly off the router stack.
//
// Run with: node --test tests/withdraw-gov-proposal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
// First matching [regex, rows] handler wins; every call is recorded.
function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
  };
}

// ── Load issueRoutes with stubbed collaborators ───────────────────────────
function loadRoute(pool) {
  const poolId = require.resolve('../src/db/pool');
  const wsId = require.resolve('../src/services/ws');
  const issuesId = require.resolve('../src/routes/issues');
  const workflowId = require.resolve('../src/workflow/platform.ts');
  const orig = {
    pool: require.cache[poolId],
    ws: require.cache[wsId],
    issues: require.cache[issuesId],
    workflow: require.cache[workflowId],
  };

  const spies = { systemMessages: [], issueUpdates: [], withdrawn: [] };
  require.cache[workflowId] = { id: workflowId, exports: {
    async withdrawProposal(issue, user) { spies.withdrawn.push([issue.id, user.username]); return { status: 200, body: { ok: true } }; },
  } };

  require.cache[poolId] = { id: poolId, exports: { getPool: () => pool } };
  // Preserve the real ws exports, override just what the route touches.
  const realWs = orig.ws ? orig.ws.exports : require('../src/services/ws');
  require.cache[wsId] = {
    id: wsId,
    exports: {
      ...realWs,
      sendSystemMessage: async (...args) => { spies.systemMessages.push(args); },
      pushIssueUpdate: (data) => { spies.issueUpdates.push(data); },
      pushAppUpdate: () => {},
    },
  };
  // Drop the cached issues module so it re-requires with our stubs.
  delete require.cache[issuesId];
  const { issueRoutes } = require('../src/routes/issues');
  const router = issueRoutes({ databaseUrl: 'postgres://test' });

  const restore = () => {
    if (orig.pool) require.cache[poolId] = orig.pool; else delete require.cache[poolId];
    if (orig.ws) require.cache[wsId] = orig.ws; else delete require.cache[wsId];
    if (orig.workflow) require.cache[workflowId] = orig.workflow; else delete require.cache[workflowId];
    delete require.cache[issuesId];
  };
  return { router, spies, restore };
}

// Pull the POST handler for /api/issues/:id/close off the router stack.
function closeHandler(router) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/api/issues/:id/close' && layer.route.methods.post) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('close route not found');
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const ISSUE = (over) => ({
  id: 31, app_id: 9, created_by: 42, title: 'Set secret API_KEY',
  kind: 'secret_change', status: 'open', github_issue_number: null,
  payload: { action: 'set', key: 'API_KEY' },
  app_slug: 'cool-app', repo_url: 'https://github.com/acme/cool-app',
  ...over,
});

test('the creator\'s withdrawal goes to the governance machine', async () => {
  const pool = makePool([[/SELECT i\.\*, a\.slug AS app_slug/, [ISSUE()]]]);
  const { router, spies, restore } = loadRoute(pool);
  try {
    const res = mockRes();
    await closeHandler(router)({ params: { id: '31' }, user: { id: 42, username: 'maker' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(spies.withdrawn, [[31, 'maker']]);
    assert.ok(!pool.issued(/UPDATE issues/), 'the route writes nothing itself');
  } finally {
    restore();
  }
});

test('a non-creator gets 403 and nothing is mutated', async () => {
  const pool = makePool([
    [/SELECT i\.\*, a\.slug AS app_slug/, [ISSUE({ created_by: 7 })]],
  ]);
  const { router, spies, restore } = loadRoute(pool);
  try {
    const handler = closeHandler(router);
    const res = mockRes();
    await handler({ params: { id: '31' }, user: { id: 42, username: 'intruder' } }, res);

    assert.equal(res.statusCode, 403);
    assert.deepEqual(spies.withdrawn, [], 'nothing reaches the machine');
  } finally {
    restore();
  }
});

test('a request that is not a governance proposal is not withdrawn here', async () => {
  const pool = makePool([[/SELECT i\.\*, a\.slug AS app_slug/, [ISSUE({ kind: 'general' })]]]);
  const { router, spies, restore } = loadRoute(pool);
  try {
    const res = mockRes();
    await closeHandler(router)({ params: { id: '31' }, user: { id: 42, username: 'maker' } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(spies.withdrawn, []);
    assert.ok(!pool.issued(/UPDATE issues/));
  } finally {
    restore();
  }
});

test('missing issue returns 404', async () => {
  const pool = makePool([
    [/SELECT i\.\*, a\.slug AS app_slug/, []],
  ]);
  const { router, spies, restore } = loadRoute(pool);
  try {
    const handler = closeHandler(router);
    const res = mockRes();
    await handler({ params: { id: '999' }, user: { id: 42, username: 'maker' } }, res);
    assert.equal(res.statusCode, 404);
    assert.ok(!pool.issued(/UPDATE issues/), 'no update attempted');
  } finally {
    restore();
  }
});

// Tests for the creator-gated governance withdraw — POST /api/issues/:id/close
// in src/routes/issues.js (repurposed from the old unguarded close route).
//
// A governance proposal (kind='secret_change' or legacy 'rename') may be
// withdrawn only by its creator (issues.created_by === req.user.id) and only
// while status='open'. Withdrawing stamps withdrawnAt/withdrawnBy onto the
// payload, posts a "withdrew their proposal" group-chat line (dual-posted
// into the governance thread), best-effort closes a GitHub twin when set,
// and pushes an issue update so open clients drop the card.
//
// We stub getPool (db/pool) to hand the route a mock pool and stub the ws
// collaborators, then drive the POST handler directly off the router stack.
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
  const orig = {
    pool: require.cache[poolId],
    ws: require.cache[wsId],
    issues: require.cache[issuesId],
  };

  const spies = { systemMessages: [], issueUpdates: [] };

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

test('creator can withdraw their own open governance proposal', async () => {
  const pool = makePool([
    [/SELECT i\.\*, a\.slug AS app_slug/, [ISSUE()]],
    [/UPDATE issues SET status = 'closed', payload/, (params) => [{ id: 31, app_id: 9 }]],
  ]);
  const { router, spies, restore } = loadRoute(pool);
  try {
    const handler = closeHandler(router);
    const res = mockRes();
    await handler({ params: { id: '31' }, user: { id: 42, username: 'maker' } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });

    // status flipped to closed with an audit payload stamping the withdrawer.
    const upd = pool.issued(/UPDATE issues SET status = 'closed', payload/);
    assert.ok(upd, 'UPDATE … status=closed issued');
    assert.match(upd.sql, /WHERE id = \$1 AND status = 'open'/, 'guarded on still-open');
    const audit = JSON.parse(upd.params[1]);
    assert.equal(audit.key, 'API_KEY', 'existing payload preserved');
    assert.equal(audit.withdrawnBy, 'maker', 'withdrawnBy stamped');
    assert.ok(audit.withdrawnAt, 'withdrawnAt stamped');

    // Group-chat line posted, and dual-posted into the governance thread.
    assert.equal(spies.systemMessages.length, 2, 'chat line + governance dual-post');
    assert.match(spies.systemMessages[0][2], /withdrew their proposal/);
    assert.match(spies.systemMessages[0][2], /Set secret API_KEY/);
    const threaded = spies.systemMessages[1];
    assert.deepEqual(threaded[5], { type: 'governance', ref: 31 }, 'dual-posted to gov thread');

    // Clients told to drop the card.
    assert.equal(spies.issueUpdates.length, 1);
    assert.equal(spies.issueUpdates[0].action, 'closed');
    assert.equal(spies.issueUpdates[0].issueId, 31);
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
    assert.ok(!pool.issued(/UPDATE issues SET status = 'closed'/), 'no UPDATE on 403');
    assert.equal(spies.systemMessages.length, 0, 'no chat line on 403');
    assert.equal(spies.issueUpdates.length, 0, 'no push on 403');
  } finally {
    restore();
  }
});

test('withdrawing an already-closed proposal is a no-op (404)', async () => {
  const pool = makePool([
    // The issue is loaded (creator matches) but the guarded UPDATE matches
    // no row because status is already 'closed'.
    [/SELECT i\.\*, a\.slug AS app_slug/, [ISSUE({ status: 'closed' })]],
    [/UPDATE issues SET status = 'closed', payload/, []],
  ]);
  const { router, spies, restore } = loadRoute(pool);
  try {
    const handler = closeHandler(router);
    const res = mockRes();
    await handler({ params: { id: '31' }, user: { id: 42, username: 'maker' } }, res);

    assert.equal(res.statusCode, 404, 'already-closed → 404 no-op');
    assert.equal(spies.systemMessages.length, 0, 'no duplicate withdrawal chat line');
    assert.equal(spies.issueUpdates.length, 0, 'no push for a no-op');
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
